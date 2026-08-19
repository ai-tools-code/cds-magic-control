import { wrapEffect } from './index.js';

export function peekEffect(ctx) {
  const endpoint = ctx.baseUrl + '/api/peek';

  return wrapEffect('peek', `
var ENDPOINT=${JSON.stringify(endpoint)};
var TOKEN=${JSON.stringify(ctx.runtimeToken)};
var destroyed=false,lastValue=null,input=null,form=null,inputTimer=0,bindTimer=0,heartbeatTimer=0;

function findInput(){
  return document.querySelector("textarea[name='q']")||
         document.querySelector("input[name='q']")||
         document.querySelector("textarea[aria-label*='Search']")||
         document.querySelector("input[aria-label*='Search']");
}

function post(payload,keepalive){
  if(destroyed)return;
  fetch(ENDPOINT,{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
    body:JSON.stringify(payload),
    keepalive:!!keepalive
  }).catch(function(){});
}

function startSession(){
  post({start:true},false);
  heartbeatTimer=setInterval(function(){post({heartbeat:true},false)},5000);
}

function changed(){
  clearTimeout(inputTimer);
  inputTimer=setTimeout(function(){
    if(!input)return;
    var value=String(input.value||'').slice(0,200);
    if(value===lastValue)return;
    lastValue=value;
    post({value:value,done:false},false);
  },100);
}

function submitted(){
  if(input)post({value:String(input.value||'').slice(0,200),done:true},true);
  cleanup(false);
}

function keydown(event){
  if(event.key==='Enter')submitted();
}

function bind(){
  if(destroyed)return;
  input=findInput();
  if(!input){bindTimer=setTimeout(bind,250);return;}
  input.addEventListener('input',changed,{passive:true});
  input.addEventListener('keydown',keydown,true);
  form=input.form||input.closest('form');
  if(form)form.addEventListener('submit',submitted,true);
  startSession();
}

function cleanup(markDestroyed=true){
  if(markDestroyed)destroyed=true;
  clearTimeout(inputTimer);
  clearTimeout(bindTimer);
  clearInterval(heartbeatTimer);
  if(input){input.removeEventListener('input',changed);input.removeEventListener('keydown',keydown,true);}
  if(form)form.removeEventListener('submit',submitted,true);
}

bind();
window.__cdsActiveEffect={destroy:function(){cleanup(true)}};
`);
}
