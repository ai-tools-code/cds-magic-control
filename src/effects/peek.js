import { wrapEffect } from './index.js';

export function peekEffect(ctx) {
  const endpoint = ctx.baseUrl + '/api/peek';
  return wrapEffect('peek', `
var ENDPOINT=${JSON.stringify(endpoint)},TOKEN=${JSON.stringify(ctx.runtimeToken)},destroyed=false,lastValue='',timer=0,input=null,form=null;
var badge=document.createElement('div');badge.textContent='Live peek active';Object.assign(badge.style,{position:'fixed',right:'10px',bottom:'10px',zIndex:'2147483647',padding:'6px 9px',borderRadius:'999px',background:'rgba(0,0,0,.72)',color:'#fff',font:'12px -apple-system,BlinkMacSystemFont,Arial',pointerEvents:'none'});document.documentElement.appendChild(badge);
function findInput(){return document.querySelector("textarea[name='q']")||document.querySelector("input[name='q']")||document.querySelector("textarea[aria-label*='Search']")||document.querySelector("input[aria-label*='Search']");}
function send(value,done){if(destroyed)return;value=String(value||'').slice(0,200);if(value===lastValue&&!done)return;lastValue=value;fetch(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:JSON.stringify({value:value,done:!!done}),keepalive:true}).catch(function(){});}
function changed(){clearTimeout(timer);timer=setTimeout(function(){if(input)send(input.value,false)},120);}
function submitted(){if(input)send(input.value,true);cleanup();}
function bind(){if(destroyed)return;input=findInput();if(!input){setTimeout(bind,300);return;}input.addEventListener('input',changed,{passive:true});form=input.form||input.closest('form');if(form)form.addEventListener('submit',submitted,true);}
function cleanup(){destroyed=true;clearTimeout(timer);if(input)input.removeEventListener('input',changed);if(form)form.removeEventListener('submit',submitted,true);try{badge.remove()}catch(_){}}
bind();window.__cdsActiveEffect={destroy:cleanup};`);
}
