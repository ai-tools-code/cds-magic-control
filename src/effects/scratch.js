import { wrapEffect } from './index.js';

export function scratchEffect(ctx) {
  const card = String(ctx.config.card || 'AH').toUpperCase();
  return wrapEffect('scratch', `
var SECRET_CARD=${JSON.stringify(card)};
var m=SECRET_CARD.match(/^(A|K|Q|J|10|[2-9])([SHDC])$/)||['','A','H'];
var rank=m[1], suit=m[2], suitMap={S:['♠',false],H:['♥',true],D:['♦',true],C:['♣',false]}, symbol=suitMap[suit][0], red=suitMap[suit][1];
var canvas=document.createElement('canvas'), secret=document.createElement('canvas');
canvas.id='__cdsScratchCanvas';Object.assign(canvas.style,{position:'fixed',inset:'0',width:'100vw',height:'100vh',zIndex:'2147483647',pointerEvents:'none',touchAction:'none',background:'transparent'});document.documentElement.appendChild(canvas);
var ctx=canvas.getContext('2d'), sc=secret.getContext('2d'), dpr=1,vw=0,vh=0,active=false,scratching=false,lastX=0,lastY=0,lastTap=0,tapX=0,tapY=0;
function rr(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.lineTo(x+w-r,y);c.quadraticCurveTo(x+w,y,x+w,y+r);c.lineTo(x+w,y+h-r);c.quadraticCurveTo(x+w,y+h,x+w-r,y+h);c.lineTo(x+r,y+h);c.quadraticCurveTo(x,y+h,x,y+h-r);c.lineTo(x,y+r);c.quadraticCurveTo(x,y,x+r,y);c.closePath();}
function corner(x,y,flip,w){sc.save();sc.translate(x,y);if(flip)sc.rotate(Math.PI);sc.fillStyle=red?'#d71920':'#111';sc.textAlign='center';sc.textBaseline='top';sc.font='600 '+Math.round(w*.10)+'px -apple-system,BlinkMacSystemFont,Arial';sc.fillText(rank,0,0);sc.font=Math.round(w*.105)+'px Georgia,serif';sc.fillText(symbol,0,w*.09);sc.restore();}
function draw(){dpr=Math.min(devicePixelRatio||1,3);vw=innerWidth;vh=innerHeight;canvas.width=Math.round(vw*dpr);canvas.height=Math.round(vh*dpr);secret.width=canvas.width;secret.height=canvas.height;ctx.setTransform(dpr,0,0,dpr,0,0);sc.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,vw,vh);sc.clearRect(0,0,vw,vh);var margin=8,ratio=1.42,w=vw-margin*2,h=w*ratio;if(h>vh-margin*2){h=vh-margin*2;w=h/ratio;}var x=(vw-w)/2,y=(vh-h)/2,r=Math.max(18,w*.045);sc.save();sc.shadowColor='rgba(0,0,0,.25)';sc.shadowBlur=Math.max(20,w*.055);sc.shadowOffsetY=8;sc.fillStyle='#fff';rr(sc,x,y,w,h,r);sc.fill();sc.restore();sc.fillStyle='#fff';rr(sc,x,y,w,h,r);sc.fill();sc.strokeStyle='rgba(0,0,0,.14)';sc.lineWidth=Math.max(1,w*.003);sc.stroke();corner(x+w*.095,y+w*.065,false,w);corner(x+w-w*.095,y+h-w*.065,true,w);sc.save();sc.fillStyle=red?'#d71920':'#111';sc.textAlign='center';sc.textBaseline='middle';var size=rank==='A'?w*.42:/[JQK]/.test(rank)?w*.34:w*.24;sc.font=Math.round(size)+'px Georgia,serif';sc.fillText(symbol,x+w/2,y+h/2);sc.restore();}
function ep(e){var p=(e.touches&&e.touches[0])||(e.changedTouches&&e.changedTouches[0])||e;return{x:p.clientX,y:p.clientY};}
function reveal(x,y,r){ctx.save();ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.clip();ctx.drawImage(secret,0,0,secret.width,secret.height,0,0,vw,vh);ctx.restore();}
function line(x1,y1,x2,y2){var dx=x2-x1,dy=y2-y1,dist=Math.hypot(dx,dy),steps=Math.max(1,Math.ceil(dist/10));for(var i=0;i<=steps;i++){var t=i/steps;reveal(x1+dx*t,y1+dy*t,58);}}
function ss(e){if(!active)return;var p=ep(e);scratching=true;lastX=p.x;lastY=p.y;reveal(p.x,p.y,58);e.preventDefault();}
function sm(e){if(!active||!scratching)return;var p=ep(e);line(lastX,lastY,p.x,p.y);lastX=p.x;lastY=p.y;e.preventDefault();}
function se(e){scratching=false;try{e.preventDefault()}catch(_){}}
function ts(e){if(active||!e.touches||e.touches.length!==1)return;tapX=e.touches[0].clientX;tapY=e.touches[0].clientY;}
function te(e){if(active||!e.changedTouches||e.changedTouches.length!==1)return;var t=e.changedTouches[0];if(Math.hypot(t.clientX-tapX,t.clientY-tapY)>20){lastTap=0;return;}var now=Date.now();if(lastTap&&now-lastTap>60&&now-lastTap<390){lastTap=0;active=true;canvas.style.pointerEvents='auto';document.removeEventListener('touchstart',ts,true);document.removeEventListener('touchend',te,true);}else lastTap=now;}
canvas.addEventListener('touchstart',ss,{passive:false});canvas.addEventListener('touchmove',sm,{passive:false});canvas.addEventListener('touchend',se,{passive:false});document.addEventListener('touchstart',ts,{capture:true,passive:true});document.addEventListener('touchend',te,{capture:true,passive:true});window.addEventListener('resize',draw,{passive:true});draw();
window.__cdsActiveEffect={destroy:function(){document.removeEventListener('touchstart',ts,true);document.removeEventListener('touchend',te,true);window.removeEventListener('resize',draw);try{canvas.remove()}catch(_){}}};`);
}
