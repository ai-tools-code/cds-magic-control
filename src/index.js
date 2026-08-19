import { buildEffectScript } from './effects/index.js';

const CDS_VERSION = '1.1.0';
const RUN_CONTENT_TYPE = 'text/plain; charset=utf-8';
const EFFECTS = new Set(['scratch', 'card_phone', 'google_single', 'peek', 'product_letters']);
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const DEFAULT_SETTINGS = Object.freeze({
  scratch: { card: 'AH' },
  card_phone: { imageKey: '' },
  google_single: { imageKey: '' },
  peek: {},
  product_letters: { name: 'MARK' }
});

let schemaReadyPromise = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === 'OPTIONS' && (url.pathname === '/api/run' || url.pathname === '/api/peek')) {
        return cors(new Response(null, { status: 204 }));
      }

      if (url.pathname === '/api/run' && request.method === 'GET') return runEffectAPI(request, env);
      if (url.pathname === '/api/peek' && request.method === 'POST') return receivePeek(request, env);
      if (url.pathname.startsWith('/media/') && request.method === 'GET') return serveMedia(request, env);

      if (url.pathname === '/api/admin/status' && request.method === 'GET') return adminStatus(env);
      if (url.pathname === '/api/debug/run-headers' && request.method === 'GET') return runHeadersDebug();
      if (url.pathname === '/api/admin/login' && request.method === 'POST') return adminLogin(request, env);
      if (url.pathname === '/api/admin/logout' && request.method === 'POST') return adminLogout();

      if (url.pathname.startsWith('/api/admin/')) {
        if (!(await isAdmin(request, env))) return json({ error: 'Unauthorized' }, 401);
        await ensureSchema(env);
      }

      if (url.pathname === '/api/admin/me' && request.method === 'GET') return json({ ok: true, version: CDS_VERSION });
      if (url.pathname === '/api/admin/users' && request.method === 'GET') return adminGetUsers(request, env);
      if (url.pathname === '/api/admin/users' && request.method === 'POST') return adminCreateUser(request, env);
      if (url.pathname === '/api/admin/peek' && request.method === 'GET') return adminPeek(request, env);
      if (url.pathname === '/api/admin/letter-library' && request.method === 'GET') return adminLetterLibrary(request, env);
      if (url.pathname === '/api/admin/letter-library/upload' && request.method === 'POST') return adminLetterUpload(request, env);

      let match = url.pathname.match(/^\/api\/admin\/letter-library\/([A-Z])$/i);
      if (match && request.method === 'DELETE') {
        return adminLetterDelete(request, env, match[1].toUpperCase());
      }

      match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (request.method === 'PATCH') return adminUpdateUser(request, env, id);
        if (request.method === 'DELETE') return adminDeleteUser(request, env, id);
      }

      match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/rotate-key$/);
      if (match && request.method === 'POST') {
        return adminRotateKey(request, env, decodeURIComponent(match[1]));
      }

      match = url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/upload$/);
      if (match && request.method === 'POST') {
        return adminUpload(request, env, decodeURIComponent(match[1]));
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error('CDS Worker error', error);
      return json({ error: 'Internal server error' }, 500);
    }
  }
};

async function runEffectAPI(request, env) {
  await ensureSchema(env);

  const user = await shortcutUser(request, env);
  if (!user) return cors(json({ error: 'Invalid API key' }, 401));

  if (!user.enabled) {
    const disabled = `/* CDS Magic API v${CDS_VERSION} */\n(function(){try{if(typeof completion==='function')completion('Shortcut disabled')}catch(_){}})();`;
    return cors(new Response(disabled, { status: 403, headers: runTextHeaders() }));
  }

  const settings = parseSettings(user.settings_json);
  const effect = EFFECTS.has(user.active_effect) ? user.active_effect : 'scratch';
  const config = structuredClone(settings[effect] || {});
  const origin = new URL(request.url).origin;

  if (effect === 'card_phone') {
    config.imageUrl = await r2DataURL(env, settings.card_phone.imageKey);
  }

  if (effect === 'google_single') {
    config.imageUrl = await r2DataURL(env, settings.google_single.imageKey);
  }

  if (effect === 'product_letters') {
    const name = normalizeName(settings.product_letters.name).slice(0, 20);
    config.name = name;

    const rows = await env.DB.prepare(
      'SELECT letter, r2_key FROM global_letter_assets WHERE letter IN (' +
      Array.from(new Set(name)).map(() => '?').join(',') + ')'
    ).bind(...Array.from(new Set(name))).all().catch(() => ({ results: [] }));

    const map = {};
    for (const row of rows.results || []) map[row.letter] = mediaURL(origin, row.r2_key);
    config.letterUrls = Array.from(name).map(letter => map[letter] || '');
  }

  const runtimeToken = await createRuntimeToken(user.id, env);
  const script = buildEffectScript({ effect, config, baseUrl: origin, runtimeToken });
  const responseText = `/* CDS Magic API v${CDS_VERSION} | response=text/plain | effect=${effect} */\n${script}`;

  return cors(new Response(responseText, { headers: runTextHeaders() }));
}

async function receivePeek(request, env) {
  await ensureSchema(env);

  const tokenData = await verifyRuntimeToken(bearerToken(request), env);
  if (!tokenData) return cors(json({ error: 'Invalid token' }, 401));

  const user = await env.DB.prepare(
    'SELECT id, enabled, active_effect FROM users WHERE id = ? LIMIT 1'
  ).bind(tokenData.userId).first();

  if (!user || !user.enabled || user.active_effect !== 'peek') {
    return cors(json({ error: 'Peek not enabled' }, 403));
  }

  const body = await readJSON(request);
  const now = Date.now();

  if (body.start) {
    await env.DB.prepare(`
      INSERT INTO peek_state(user_id, value, is_done, updated_at)
      VALUES(?, '', 0, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        value = '',
        is_done = 0,
        updated_at = excluded.updated_at
    `).bind(user.id, now).run();

    return cors(json({ ok: true, connected: true }));
  }

  if (body.heartbeat) {
    await env.DB.prepare(`
      UPDATE peek_state
      SET updated_at = ?
      WHERE user_id = ? AND is_done = 0
    `).bind(now, user.id).run();

    return cors(json({ ok: true }));
  }

  const value = String(body.value || '').slice(0, 200);
  const done = body.done ? 1 : 0;

  await env.DB.prepare(`
    INSERT INTO peek_state(user_id, value, is_done, updated_at)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      value = excluded.value,
      is_done = excluded.is_done,
      updated_at = excluded.updated_at
  `).bind(user.id, value, done, now).run();

  return cors(json({ ok: true }));
}

async function adminLogin(request, env) {
  if (!String(env.ADMIN_PASSWORD || '').trim()) {
    return json({ error: 'ADMIN_PASSWORD is not configured. Run: npx wrangler secret put ADMIN_PASSWORD' }, 503);
  }

  const body = await readJSON(request);
  if (!(await secureEqual(String(body.password || ''), String(env.ADMIN_PASSWORD)))) {
    return json({ error: 'Invalid password' }, 401);
  }

  try {
    await ensureSchema(env);
  } catch (error) {
    console.error('D1 initialization failed', error);
    return json({ error: 'Database is not configured correctly. Check the DB binding/database_id, then redeploy.' }, 503);
  }

  const expiry = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const signature = await sign('admin:' + expiry, signingSecret(env));

  return new Response(JSON.stringify({ ok: true, version: CDS_VERSION }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `cds_admin=${expiry}.${signature}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
      'Cache-Control': 'no-store'
    }
  });
}

function adminLogout() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': 'cds_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
      'Cache-Control': 'no-store'
    }
  });
}

async function adminGetUsers(request, env) {
  const result = await env.DB.prepare(`
    SELECT id, name, enabled, active_effect, settings_json, created_at, updated_at
    FROM users
    ORDER BY created_at DESC
  `).all();

  const origin = new URL(request.url).origin;

  return json({
    users: (result.results || []).map(row => {
      const settings = parseSettings(row.settings_json);
      return {
        id: row.id,
        name: row.name,
        enabled: !!row.enabled,
        activeEffect: row.active_effect,
        settings,
        assets: {
          card_phone: settings.card_phone.imageKey ? mediaURL(origin, settings.card_phone.imageKey) : '',
          google_single: settings.google_single.imageKey ? mediaURL(origin, settings.google_single.imageKey) : ''
        },
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    })
  });
}

async function adminCreateUser(request, env) {
  const body = await readJSON(request);
  const name = String(body.name || '').trim().slice(0, 80);
  if (!name) return json({ error: 'Name required' }, 400);

  const id = crypto.randomUUID();
  const shortcutKey = generateShortcutKey();
  const hash = await sha256Hex(shortcutKey);
  const now = Date.now();

  await env.DB.prepare(`
    INSERT INTO users(id, name, api_key_hash, enabled, active_effect, settings_json, created_at, updated_at)
    VALUES(?, ?, ?, 1, 'scratch', ?, ?, ?)
  `).bind(id, name, hash, JSON.stringify(DEFAULT_SETTINGS), now, now).run();

  return json({ ok: true, userId: id, shortcutKey }, 201);
}

async function adminUpdateUser(request, env, id) {
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ? LIMIT 1').bind(id).first();
  if (!row) return json({ error: 'User not found' }, 404);

  const body = await readJSON(request);
  let effect = row.active_effect;

  if (body.activeEffect !== undefined) {
    if (!EFFECTS.has(body.activeEffect)) return json({ error: 'Invalid effect' }, 400);
    effect = body.activeEffect;
  }

  const current = parseSettings(row.settings_json);
  let settings;
  try {
    settings = applySettingsPatch(current, body.settings || {});
  } catch (error) {
    return json({ error: error.message || 'Invalid settings' }, 400);
  }
  const enabled = body.enabled === undefined ? !!row.enabled : !!body.enabled;
  const name = body.name === undefined ? row.name : (String(body.name).trim().slice(0, 80) || row.name);

  await env.DB.prepare(`
    UPDATE users
    SET name = ?, enabled = ?, active_effect = ?, settings_json = ?, updated_at = ?
    WHERE id = ?
  `).bind(name, enabled ? 1 : 0, effect, JSON.stringify(settings), Date.now(), id).run();

  return json({ ok: true, settings });
}

async function adminRotateKey(request, env, id) {
  if (!(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first())) {
    return json({ error: 'User not found' }, 404);
  }

  const shortcutKey = generateShortcutKey();
  const hash = await sha256Hex(shortcutKey);

  await env.DB.prepare('UPDATE users SET api_key_hash = ?, updated_at = ? WHERE id = ?')
    .bind(hash, Date.now(), id).run();

  return json({ ok: true, shortcutKey });
}

async function adminUpload(request, env, id) {
  if (!env.MEDIA) return json({ error: 'R2 binding MEDIA is not configured' }, 503);

  const url = new URL(request.url);
  const slot = String(url.searchParams.get('slot') || '');

  if (!['card_phone', 'google_single'].includes(slot)) {
    return json({ error: 'Unknown upload slot' }, 400);
  }

  const row = await env.DB.prepare('SELECT id, settings_json FROM users WHERE id = ? LIMIT 1').bind(id).first();
  if (!row) return json({ error: 'User not found' }, 404);

  const file = await imageFromForm(request);
  if (file.error) return json({ error: file.error }, file.status || 400);

  const settings = parseSettings(row.settings_json);
  const prior = settings[slot].imageKey;
  const key = `users/${id}/${slot}/${crypto.randomUUID()}.${file.extension}`;

  await env.MEDIA.put(key, file.bytes, { httpMetadata: { contentType: file.type } });

  settings[slot].imageKey = key;

  await env.DB.prepare('UPDATE users SET settings_json = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify(settings), Date.now(), id).run();

  if (prior && prior !== key) await safeDeleteR2(env, prior);

  return json({
    ok: true,
    slot,
    configured: true,
    key,
    url: mediaURL(url.origin, key),
    settings
  });
}

async function adminLetterLibrary(request, env) {
  const rows = await env.DB.prepare('SELECT letter, r2_key, updated_at FROM global_letter_assets ORDER BY letter').all();
  const origin = new URL(request.url).origin;
  const map = {};

  for (const letter of LETTERS) map[letter] = { configured: false, url: '', updatedAt: 0 };

  for (const row of rows.results || []) {
    map[row.letter] = {
      configured: true,
      url: mediaURL(origin, row.r2_key),
      updatedAt: row.updated_at
    };
  }

  return json({ letters: map, configuredCount: Object.values(map).filter(x => x.configured).length });
}

async function adminLetterUpload(request, env) {
  if (!env.MEDIA) return json({ error: 'R2 binding MEDIA is not configured' }, 503);

  const url = new URL(request.url);
  const letter = String(url.searchParams.get('letter') || '').toUpperCase();
  if (!/^[A-Z]$/.test(letter)) return json({ error: 'letter must be A-Z' }, 400);

  const file = await imageFromForm(request);
  if (file.error) return json({ error: file.error }, file.status || 400);

  const prior = await env.DB.prepare('SELECT r2_key FROM global_letter_assets WHERE letter = ?').bind(letter).first();
  const key = `library/letters/${letter}/${crypto.randomUUID()}.${file.extension}`;

  await env.MEDIA.put(key, file.bytes, { httpMetadata: { contentType: file.type } });

  await env.DB.prepare(`
    INSERT INTO global_letter_assets(letter, r2_key, updated_at)
    VALUES(?, ?, ?)
    ON CONFLICT(letter) DO UPDATE SET
      r2_key = excluded.r2_key,
      updated_at = excluded.updated_at
  `).bind(letter, key, Date.now()).run();

  if (prior?.r2_key && prior.r2_key !== key) await safeDeleteR2(env, prior.r2_key);

  return json({ ok: true, letter, url: mediaURL(url.origin, key) });
}

async function adminLetterDelete(request, env, letter) {
  const row = await env.DB.prepare('SELECT r2_key FROM global_letter_assets WHERE letter = ?').bind(letter).first();
  if (row?.r2_key) await safeDeleteR2(env, row.r2_key);
  await env.DB.prepare('DELETE FROM global_letter_assets WHERE letter = ?').bind(letter).run();
  return json({ ok: true, letter });
}

async function adminPeek(request, env) {
  const id = new URL(request.url).searchParams.get('userId');
  if (!id) return json({ error: 'userId required' }, 400);

  const row = await env.DB.prepare(
    'SELECT value, is_done, updated_at FROM peek_state WHERE user_id = ? LIMIT 1'
  ).bind(id).first();

  if (!row) {
    return json({ value: '', done: false, connected: false, updatedAt: 0 });
  }

  const age = Date.now() - row.updated_at;
  return json({
    value: row.value,
    done: !!row.is_done,
    connected: !row.is_done && age <= 12000,
    updatedAt: row.updated_at
  });
}

async function adminDeleteUser(request, env, id) {
  const row = await env.DB.prepare('SELECT settings_json FROM users WHERE id = ? LIMIT 1').bind(id).first();
  if (!row) return json({ error: 'User not found' }, 404);

  const settings = parseSettings(row.settings_json);
  for (const key of [settings.card_phone.imageKey, settings.google_single.imageKey].filter(Boolean)) {
    await safeDeleteR2(env, key);
  }

  await env.DB.prepare('DELETE FROM peek_state WHERE user_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM letter_assets WHERE user_id = ?').bind(id).run().catch(() => {});
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();

  return json({ ok: true });
}

async function serveMedia(request, env) {
  if (!env.MEDIA) return new Response('Media storage unavailable', { status: 503 });

  let key;
  try {
    key = decodeURIComponent(new URL(request.url).pathname.slice('/media/'.length));
  } catch {
    return new Response('Bad key', { status: 400 });
  }

  const object = await env.MEDIA.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(object.body, { headers });
}

async function imageFromForm(request) {
  const form = await request.formData();
  const file = form.get('file');

  if (!file || typeof file.arrayBuffer !== 'function') {
    return { error: 'Image file required', status: 400 };
  }

  if (file.size > 4 * 1024 * 1024) {
    return { error: 'Image must be under 4 MB', status: 400 };
  }

  const type = String(file.type || '').toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) {
    return { error: 'PNG, JPEG or WebP only', status: 400 };
  }

  return {
    bytes: await file.arrayBuffer(),
    type,
    extension: type === 'image/jpeg' ? 'jpg' : type.split('/')[1]
  };
}

async function shortcutUser(request, env) {
  const key = request.headers.get('X-CDS-Key');
  if (!key || key.length > 200) return null;

  return env.DB.prepare(`
    SELECT id, name, enabled, active_effect, settings_json
    FROM users
    WHERE api_key_hash = ?
    LIMIT 1
  `).bind(await sha256Hex(key)).first();
}

async function isAdmin(request, env) {
  const session = parseCookies(request.headers.get('Cookie') || '').cds_admin;
  if (!session) return false;

  const parts = session.split('.');
  if (parts.length !== 2) return false;

  const expiry = Number(parts[0]);
  if (!Number.isFinite(expiry) || expiry < Date.now() / 1000) return false;

  return secureEqual(parts[1], await sign('admin:' + expiry, signingSecret(env)));
}

async function createRuntimeToken(id, env) {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const payload = `runtime:${id}:${expiry}`;
  const signature = await sign(payload, signingSecret(env));
  return `rt.${id}.${expiry}.${signature}`;
}

async function verifyRuntimeToken(token, env) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'rt') return null;

  const expiry = Number(parts[2]);
  if (!Number.isFinite(expiry) || expiry < Date.now() / 1000) return null;

  const expected = await sign(`runtime:${parts[1]}:${expiry}`, signingSecret(env));
  return (await secureEqual(parts[3], expected)) ? { userId: parts[1], expiry } : null;
}

function parseSettings(raw) {
  let parsed = {};
  try { parsed = JSON.parse(raw || '{}') || {}; } catch {}

  return {
    scratch: {
      card: normalizeCard(parsed.scratch?.card) || DEFAULT_SETTINGS.scratch.card
    },
    card_phone: {
      imageKey: String(parsed.card_phone?.imageKey || '')
    },
    google_single: {
      imageKey: String(parsed.google_single?.imageKey || '')
    },
    peek: {},
    product_letters: {
      name: normalizeName(parsed.product_letters?.name || DEFAULT_SETTINGS.product_letters.name).slice(0, 20) || DEFAULT_SETTINGS.product_letters.name
    }
  };
}

function applySettingsPatch(current, patch) {
  const result = structuredClone(current);

  if (patch.scratch && patch.scratch.card !== undefined) {
    const card = normalizeCard(patch.scratch.card);
    if (!card) throw new Error('Invalid card. Use AH, 10S, QD, KC, etc.');
    result.scratch.card = card;
  }

  if (patch.product_letters && patch.product_letters.name !== undefined) {
    const name = normalizeName(patch.product_letters.name).slice(0, 20);
    if (!name) throw new Error('Name must contain A-Z letters');
    result.product_letters.name = name;
  }

  return result;
}

function normalizeCard(value) {
  const v = String(value || '').toUpperCase().replace(/\s+/g, '');
  return /^(A|K|Q|J|10|[2-9])[SHDC]$/.test(v) ? v : '';
}

function normalizeName(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function signingSecret(env) {
  const dedicated = String(env.SIGNING_SECRET || '').trim();
  if (dedicated) return dedicated;

  const fallback = String(env.ADMIN_PASSWORD || '').trim();
  if (fallback) return fallback;

  throw new Error('No signing secret available');
}

async function ensureSchema(env) {
  if (!env.DB || typeof env.DB.prepare !== 'function') throw new Error('D1 binding DB is missing');

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
      env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash)'),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS letter_assets (
        user_id TEXT NOT NULL,
        letter TEXT NOT NULL,
        r2_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, letter)
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS global_letter_assets (
        letter TEXT PRIMARY KEY,
        r2_key TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS peek_state (
        user_id TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT '',
        is_done INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`)
    ]).catch(error => {
      schemaReadyPromise = null;
      throw error;
    });
  }

  return schemaReadyPromise;
}

function runTextHeaders() {
  return {
    'Content-Type': RUN_CONTENT_TYPE,
    'Content-Disposition': 'inline; filename="cds-effect.txt"',
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
    responseMode: 'plain-text'
  });
}

function adminStatus(env) {
  return json({
    ok: true,
    version: CDS_VERSION,
    adminPasswordConfigured: !!String(env.ADMIN_PASSWORD || '').trim(),
    signingSecretConfigured: !!String(env.SIGNING_SECRET || '').trim(),
    databaseBound: !!env.DB,
    mediaBound: !!env.MEDIA
  });
}

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sign(text, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))));
}

async function secureEqual(a, b) {
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(a))),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(b)))
  ]);

  const aa = new Uint8Array(ah);
  const bb = new Uint8Array(bh);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function generateShortcutKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return 'cds_' + base64Url(bytes);
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function cors(response) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-CDS-Key, Authorization');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readJSON(request) {
  try { return await request.json(); } catch { return {}; }
}

function parseCookies(value) {
  const result = {};
  for (const item of value.split(';')) {
    const index = item.indexOf('=');
    if (index < 0) continue;
    result[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return result;
}

function bearerToken(request) {
  const value = request.headers.get('Authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function mediaURL(origin, key) {
  return key ? origin + '/media/' + encodeURIComponent(key) : '';
}


async function r2DataURL(env, key) {
  if (!key || !env.MEDIA) return '';

  const object = await env.MEDIA.get(key);
  if (!object) return '';

  const bytes = new Uint8Array(await object.arrayBuffer());
  const contentType = object.httpMetadata?.contentType || 'image/png';
  return `data:${contentType};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function safeDeleteR2(env, key) {
  if (!key || !env.MEDIA) return;
  try { await env.MEDIA.delete(key); } catch {}
}
