import { buildEffectScript } from './effects/index.js';

const CDS_VERSION = '1.0.3';
const RUN_CONTENT_TYPE = 'text/plain; charset=utf-8';

const EFFECTS = new Set(['scratch','card_phone','google_single','peek','product_letters']);
const DEFAULT_SETTINGS = {
  scratch:{card:'AH'},
  card_phone:{imageKey:''},
  google_single:{imageKey:''},
  peek:{},
  product_letters:{name:'MARK'}
};

let schemaReadyPromise = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === 'OPTIONS' && (url.pathname === '/api/run' || url.pathname === '/api/peek')) return cors(new Response(null,{status:204}));
      if (url.pathname === '/api/run' && request.method === 'GET') return runEffectAPI(request, env);
      if (url.pathname === '/api/peek' && request.method === 'POST') return receivePeek(request, env);
      if (url.pathname.startsWith('/media/') && request.method === 'GET') return serveMedia(request, env);
      if (url.pathname === '/api/admin/status' && request.method === 'GET') return adminStatus(env);
      if (url.pathname === '/api/debug/run-headers' && request.method === 'GET') return runHeadersDebug();
      if (url.pathname === '/api/admin/login' && request.method === 'POST') return adminLogin(request, env);
      if (url.pathname === '/api/admin/logout' && request.method === 'POST') return adminLogout();

      if (url.pathname.startsWith('/api/admin/')) {
        if (!(await isAdmin(request, env))) return json({error:'Unauthorized'},401);
        await ensureSchema(env);
      }

      if (url.pathname === '/api/admin/me' && request.method === 'GET') return json({ok:true});
      if (url.pathname === '/api/admin/users' && request.method === 'GET') return adminGetUsers(request, env);
      if (url.pathname === '/api/admin/users' && request.method === 'POST') return adminCreateUser(request, env);
      if (url.pathname === '/api/admin/peek' && request.method === 'GET') return adminPeek(request, env);

      let m = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (request.method === 'PATCH') return adminUpdateUser(request, env, id);
        if (request.method === 'DELETE') return adminDeleteUser(request, env, id);
      }
      m = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/rotate-key$/);
      if (m && request.method === 'POST') return adminRotateKey(request, env, decodeURIComponent(m[1]));
      m = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/upload$/);
      if (m && request.method === 'POST') return adminUpload(request, env, decodeURIComponent(m[1]));

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({error:'Internal server error'},500);
    }
  }
};

async function runEffectAPI(request, env) {
  await ensureSchema(env);
  const user = await shortcutUser(request, env);
  if (!user) return cors(json({error:'Invalid API key'},401));
  if (!user.enabled) return cors(new Response(`/* CDS Magic API v${CDS_VERSION} | text/plain */\n(function(){try{if(typeof completion==='function')completion('Shortcut disabled')}catch(_){}})();`,{status:403,headers:runTextHeaders()}));
  const settings = parseSettings(user.settings_json);
  const effect = EFFECTS.has(user.active_effect) ? user.active_effect : 'scratch';
  const config = {...(settings[effect]||{})};
  const origin = new URL(request.url).origin;
  if (effect === 'card_phone') config.imageUrl = mediaURL(origin, config.imageKey);
  if (effect === 'google_single') config.imageUrl = mediaURL(origin, config.imageKey);
  if (effect === 'product_letters') {
    const name = normalizeName(config.name).slice(0,20);
    config.name = name;
    const rows = await env.DB.prepare('SELECT letter,r2_key FROM letter_assets WHERE user_id=?').bind(user.id).all();
    const map = {};
    for (const row of rows.results||[]) map[row.letter] = mediaURL(origin,row.r2_key);
    config.letterUrls = Array.from(name).map(ch=>map[ch]||'');
  }
  const runtimeToken = await createRuntimeToken(user.id, env);
  const script = buildEffectScript({effect,config,baseUrl:origin,runtimeToken});
  const responseText = `/* CDS Magic API v${CDS_VERSION} | response=text/plain | effect=${effect} */\n${script}`;
  return cors(new Response(responseText,{headers:runTextHeaders()}));
}

async function receivePeek(request, env) {
  await ensureSchema(env);
  const tokenData = await verifyRuntimeToken(bearerToken(request), env);
  if (!tokenData) return cors(json({error:'Invalid token'},401));
  const user = await env.DB.prepare('SELECT id,enabled,active_effect FROM users WHERE id=? LIMIT 1').bind(tokenData.userId).first();
  if (!user || !user.enabled || user.active_effect !== 'peek') return cors(json({error:'Peek not enabled'},403));
  const body = await readJSON(request);
  const value = String(body.value||'').slice(0,200), done = body.done ? 1 : 0, now = Date.now();
  await env.DB.prepare(`INSERT INTO peek_state(user_id,value,is_done,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value,is_done=excluded.is_done,updated_at=excluded.updated_at`).bind(user.id,value,done,now).run();
  return cors(json({ok:true}));
}

async function adminLogin(request, env) {
  if (!String(env.ADMIN_PASSWORD||'').trim()) {
    return json({
      error:'ADMIN_PASSWORD is not configured. Run: npx wrangler secret put ADMIN_PASSWORD'
    },503);
  }

  const body = await readJSON(request);
  if (!(await secureEqual(String(body.password||''), String(env.ADMIN_PASSWORD)))) {
    return json({error:'Invalid password'},401);
  }

  try {
    await ensureSchema(env);
  } catch (error) {
    console.error('D1 initialization failed', error);
    return json({
      error:'Database is not configured correctly. Check the DB binding/database_id, then redeploy.'
    },503);
  }

  const expiry = Math.floor(Date.now()/1000)+12*60*60;
  const signature = await sign('admin:'+expiry, signingSecret(env));
  return new Response(JSON.stringify({
    ok:true,
    signingSecretFallback:!String(env.SIGNING_SECRET||'').trim()
  }),{headers:{'Content-Type':'application/json; charset=utf-8','Set-Cookie':`cds_admin=${expiry}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,'Cache-Control':'no-store'}});
}

function runTextHeaders() {
  return {
    'Content-Type': RUN_CONTENT_TYPE,
    'Content-Disposition': 'inline; filename=\"cds-effect.txt\"',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-CDS-Version': CDS_VERSION,
    'X-CDS-Response-Mode': 'plain-text'
  };
}

function runHeadersDebug() {
  return json({
    ok: true,
    version: CDS_VERSION,
    endpoint: '/api/run',
    contentType: RUN_CONTENT_TYPE,
    contentDisposition: 'inline; filename=\"cds-effect.txt\"',
    responseMode: 'plain-text',
    note: 'After deploying v1.0.3, /api/run begins with a CDS Magic API v1.0.3 comment.'
  });
}

function adminStatus(env) {
  return json({
    ok:true,
    adminPasswordConfigured:!!String(env.ADMIN_PASSWORD||'').trim(),
    signingSecretConfigured:!!String(env.SIGNING_SECRET||'').trim(),
    databaseBound:!!env.DB,
    mediaBound:!!env.MEDIA
  });
}
function adminLogout(){return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json; charset=utf-8','Set-Cookie':'cds_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0','Cache-Control':'no-store'}})}

async function adminGetUsers(request, env) {
  const ur = await env.DB.prepare('SELECT id,name,enabled,active_effect,settings_json,created_at,updated_at FROM users ORDER BY created_at DESC').all();
  const lr = await env.DB.prepare('SELECT user_id,letter,r2_key FROM letter_assets').all();
  const origin = new URL(request.url).origin, letters={};
  for (const row of lr.results||[]) { letters[row.user_id] ||= {}; letters[row.user_id][row.letter]=mediaURL(origin,row.r2_key); }
  return json({users:(ur.results||[]).map(row=>({id:row.id,name:row.name,enabled:!!row.enabled,activeEffect:row.active_effect,settings:parseSettings(row.settings_json),letters:letters[row.id]||{},createdAt:row.created_at,updatedAt:row.updated_at}))});
}

async function adminCreateUser(request, env) {
  const body = await readJSON(request), name=String(body.name||'').trim().slice(0,80);
  if (!name) return json({error:'Name required'},400);
  const id=crypto.randomUUID(), shortcutKey=generateShortcutKey(), hash=await sha256Hex(shortcutKey), now=Date.now();
  await env.DB.prepare(`INSERT INTO users(id,name,api_key_hash,enabled,active_effect,settings_json,created_at,updated_at) VALUES(?,?,?,1,'scratch',?,?,?)`).bind(id,name,hash,JSON.stringify(DEFAULT_SETTINGS),now,now).run();
  return json({ok:true,userId:id,shortcutKey},201);
}

async function adminUpdateUser(request, env, id) {
  const row=await env.DB.prepare('SELECT * FROM users WHERE id=? LIMIT 1').bind(id).first(); if(!row)return json({error:'User not found'},404);
  const body=await readJSON(request); let effect=row.active_effect; if(body.activeEffect!==undefined){if(!EFFECTS.has(body.activeEffect))return json({error:'Invalid effect'},400);effect=body.activeEffect;}
  const enabled=body.enabled===undefined?!!row.enabled:!!body.enabled, settings=mergeSettings(parseSettings(row.settings_json),body.settings||{}), name=body.name===undefined?row.name:String(body.name).trim().slice(0,80)||row.name;
  await env.DB.prepare('UPDATE users SET name=?,enabled=?,active_effect=?,settings_json=?,updated_at=? WHERE id=?').bind(name,enabled?1:0,effect,JSON.stringify(settings),Date.now(),id).run();
  return json({ok:true});
}

async function adminRotateKey(request, env, id) {
  if (!(await env.DB.prepare('SELECT id FROM users WHERE id=?').bind(id).first())) return json({error:'User not found'},404);
  const key=generateShortcutKey(), hash=await sha256Hex(key); await env.DB.prepare('UPDATE users SET api_key_hash=?,updated_at=? WHERE id=?').bind(hash,Date.now(),id).run(); return json({ok:true,shortcutKey:key});
}

async function adminUpload(request, env, id) {
  const url=new URL(request.url), slot=String(url.searchParams.get('slot')||''), row=await env.DB.prepare('SELECT id,settings_json FROM users WHERE id=? LIMIT 1').bind(id).first(); if(!row)return json({error:'User not found'},404);
  const form=await request.formData(), file=form.get('file'); if(!file||typeof file.arrayBuffer!=='function')return json({error:'Image file required'},400); if(file.size>4*1024*1024)return json({error:'Image must be under 4 MB'},400);
  const type=String(file.type||'').toLowerCase(); if(!['image/png','image/jpeg','image/webp'].includes(type))return json({error:'PNG, JPEG or WebP only'},400);
  const ext=type==='image/jpeg'?'jpg':type.split('/')[1], key=`users/${id}/${safeSlot(slot)}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:type}});
  const settings=parseSettings(row.settings_json);
  if(slot==='card_phone'||slot==='google_single'){
    const prior=settings[slot]?.imageKey; settings[slot]={...settings[slot],imageKey:key}; if(prior)await safeDeleteR2(env,prior);
    await env.DB.prepare('UPDATE users SET settings_json=?,updated_at=? WHERE id=?').bind(JSON.stringify(settings),Date.now(),id).run();
  } else if(slot.startsWith('letter:')){
    const letter=slot.slice(7).toUpperCase(); if(!/^[A-Z0-9]$/.test(letter)){await safeDeleteR2(env,key);return json({error:'Invalid letter'},400)}
    const prior=await env.DB.prepare('SELECT r2_key FROM letter_assets WHERE user_id=? AND letter=?').bind(id,letter).first();
    await env.DB.prepare(`INSERT INTO letter_assets(user_id,letter,r2_key,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,letter) DO UPDATE SET r2_key=excluded.r2_key,updated_at=excluded.updated_at`).bind(id,letter,key,Date.now()).run(); if(prior?.r2_key)await safeDeleteR2(env,prior.r2_key);
  } else { await safeDeleteR2(env,key); return json({error:'Unknown upload slot'},400); }
  return json({ok:true,key,url:mediaURL(new URL(request.url).origin,key)});
}

async function adminPeek(request, env) {
  const id=new URL(request.url).searchParams.get('userId'); if(!id)return json({error:'userId required'},400);
  const row=await env.DB.prepare('SELECT value,is_done,updated_at FROM peek_state WHERE user_id=? LIMIT 1').bind(id).first();
  return json(row?{value:row.value,done:!!row.is_done,updatedAt:row.updated_at}:{value:'',done:false,updatedAt:0});
}

async function adminDeleteUser(request, env, id) {
  const row=await env.DB.prepare('SELECT settings_json FROM users WHERE id=? LIMIT 1').bind(id).first(); if(!row)return json({error:'User not found'},404); const settings=parseSettings(row.settings_json), keys=[settings.card_phone?.imageKey,settings.google_single?.imageKey].filter(Boolean);
  const lr=await env.DB.prepare('SELECT r2_key FROM letter_assets WHERE user_id=?').bind(id).all(); for(const x of lr.results||[])if(x.r2_key)keys.push(x.r2_key); for(const k of keys)await safeDeleteR2(env,k);
  await env.DB.prepare('DELETE FROM peek_state WHERE user_id=?').bind(id).run(); await env.DB.prepare('DELETE FROM letter_assets WHERE user_id=?').bind(id).run(); await env.DB.prepare('DELETE FROM users WHERE id=?').bind(id).run(); return json({ok:true});
}

async function serveMedia(request, env) {
  let key; try{key=decodeURIComponent(new URL(request.url).pathname.slice('/media/'.length))}catch{return new Response('Bad key',{status:400})}
  const object=await env.MEDIA.get(key); if(!object)return new Response('Not found',{status:404}); const headers=new Headers(); object.writeHttpMetadata(headers); headers.set('ETag',object.httpEtag); headers.set('Cache-Control','public, max-age=31536000, immutable'); headers.set('X-Content-Type-Options','nosniff'); return new Response(object.body,{headers});
}

async function shortcutUser(request, env){const key=request.headers.get('X-CDS-Key');if(!key||key.length>200)return null;return env.DB.prepare('SELECT id,name,enabled,active_effect,settings_json FROM users WHERE api_key_hash=? LIMIT 1').bind(await sha256Hex(key)).first();}
async function isAdmin(request, env){const session=parseCookies(request.headers.get('Cookie')||'').cds_admin;if(!session)return false;const p=session.split('.');if(p.length!==2)return false;const expiry=Number(p[0]);if(!Number.isFinite(expiry)||expiry<Date.now()/1000)return false;return secureEqual(p[1],await sign('admin:'+expiry,signingSecret(env)));}
async function createRuntimeToken(id,env){const expiry=Math.floor(Date.now()/1000)+3600, payload=`runtime:${id}:${expiry}`, sig=await sign(payload,signingSecret(env));return `rt.${id}.${expiry}.${sig}`;}
async function verifyRuntimeToken(token,env){if(!token)return null;const p=token.split('.');if(p.length!==4||p[0]!=='rt')return null;const expiry=Number(p[2]);if(!Number.isFinite(expiry)||expiry<Date.now()/1000)return null;const ok=await secureEqual(p[3],await sign(`runtime:${p[1]}:${expiry}`,signingSecret(env)));return ok?{userId:p[1],expiry}:null;}
function parseSettings(raw){let parsed={};try{parsed=JSON.parse(raw||'{}')}catch{}return mergeSettings(DEFAULT_SETTINGS,parsed)}
function mergeSettings(base,patch){const result=structuredClone(DEFAULT_SETTINGS);for(const effect of Object.keys(result))result[effect]={...result[effect],...(base?.[effect]||{})};if(patch.scratch){const c=normalizeCard(patch.scratch.card);if(c)result.scratch.card=c;}if(patch.product_letters)result.product_letters.name=normalizeName(patch.product_letters.name).slice(0,20);result.card_phone.imageKey=String(base?.card_phone?.imageKey||result.card_phone.imageKey||'');result.google_single.imageKey=String(base?.google_single?.imageKey||result.google_single.imageKey||'');return result;}
function normalizeCard(v){v=String(v||'').toUpperCase().replace(/\s+/g,'');return /^(A|K|Q|J|10|[2-9])[SHDC]$/.test(v)?v:''} function normalizeName(v){return String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'')}
function signingSecret(env) {
  const dedicated = String(env.SIGNING_SECRET||'').trim();
  if (dedicated) return dedicated;
  const fallback = String(env.ADMIN_PASSWORD||'').trim();
  if (fallback) return fallback;
  throw new Error('No signing secret available');
}

async function ensureSchema(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function') {
    throw new Error('D1 binding DB is missing');
  }

  if (!schemaReadyPromise) {
    schemaReadyPromise = env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key_hash TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        active_effect TEXT NOT NULL DEFAULT 'scratch',
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS letter_assets (
        user_id TEXT NOT NULL,
        letter TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, letter),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS peek_state (
        user_id TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        is_done INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )`)
    ]).catch(error => {
      schemaReadyPromise = null;
      throw error;
    });
  }

  return schemaReadyPromise;
}

async function sha256Hex(value){const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value)));return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('')}
async function sign(text,secret){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(String(secret||'')),{name:'HMAC',hash:'SHA-256'},false,['sign']);return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text))))}
async function secureEqual(a,b){const [ah,bh]=await Promise.all([crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(a))),crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(b)))]);const aa=new Uint8Array(ah),bb=new Uint8Array(bh);let diff=0;for(let i=0;i<aa.length;i++)diff|=aa[i]^bb[i];return diff===0}
function generateShortcutKey(){const bytes=new Uint8Array(32);crypto.getRandomValues(bytes);return 'cds_'+base64Url(bytes)} function base64Url(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'')}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}})}
function cors(response){const h=new Headers(response.headers);h.set('Access-Control-Allow-Origin','*');h.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');h.set('Access-Control-Allow-Headers','Content-Type, X-CDS-Key, Authorization');h.set('Access-Control-Max-Age','86400');return new Response(response.body,{status:response.status,statusText:response.statusText,headers:h})}
async function readJSON(request){try{return await request.json()}catch{return {}}} function parseCookies(value){const out={};for(const item of value.split(';')){const i=item.indexOf('=');if(i<0)continue;out[item.slice(0,i).trim()]=item.slice(i+1).trim()}return out} function bearerToken(request){const v=request.headers.get('Authorization')||'';return v.startsWith('Bearer ')?v.slice(7):''}
function mediaURL(origin,key){return key?origin+'/media/'+encodeURIComponent(key):''} function safeSlot(v){return String(v||'asset').replace(/[^A-Za-z0-9:_-]/g,'_').slice(0,50)} async function safeDeleteR2(env,key){if(key)try{await env.MEDIA.delete(key)}catch{}}
