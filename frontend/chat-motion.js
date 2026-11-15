'use strict';
// FLIP keeps the composer and first message continuous without delaying fetch.
(() => {
 let current;
 function cancel(){current?.close(false);}
 function prepareFirstSend(){
  const card=document.querySelector('.glass-card'),composer=card?.querySelector('.composer-area'),input=document.getElementById('message-input');
  if(!composer?.animate||!composer.getBoundingClientRect||matchMedia('(prefers-reduced-motion: reduce)').matches)return null;
  const from=composer.getBoundingClientRect(),inputFrom=input.getBoundingClientRect(),typed=Boolean(input.value.trim()),cardRect=card.getBoundingClientRect();
  window.WanderHistory?.cancelLayoutMotion?.();cancel();
  const snapshot=document.createElement('div');snapshot.className='glass-card chat-welcome-snapshot';snapshot.setAttribute('aria-hidden','true');snapshot.inert=true;
  Object.assign(snapshot.style,{position:'fixed',left:cardRect.left+'px',top:cardRect.top+'px',right:'auto',bottom:'auto',width:cardRect.width+'px',height:cardRect.height+'px',minHeight:'0',maxHeight:'none',minWidth:'0',maxWidth:'none',padding:'0',margin:'0',background:'transparent',border:'0',borderRadius:'0',boxShadow:'none',backdropFilter:'none',webkitBackdropFilter:'none',overflow:'visible',pointerEvents:'none',zIndex:'1010'});
  for(const node of card.querySelectorAll('.welcome,.weather,.location-status')){
   const rect=node.getBoundingClientRect();if(!rect.width||!rect.height)continue;
   const copy=node.cloneNode(true);
   const originals=[node,...node.querySelectorAll('*')],copies=[copy,...copy.querySelectorAll('*')];copies.forEach((n,i)=>{if(!originals[i].id)return;const style=getComputedStyle(originals[i]);Object.assign(n.style,{font:style.font,color:style.color,letterSpacing:style.letterSpacing,marginLeft:style.marginLeft});n.removeAttribute('id');});copy.querySelectorAll('input,button').forEach(n=>n.disabled=true);
   Object.assign(copy.style,{position:'absolute',left:(rect.left-cardRect.left)+'px',top:(rect.top-cardRect.top)+'px',width:rect.width+'px',height:rect.height+'px',margin:'0',transform:'none'});snapshot.append(copy);
  }
  document.body.append(snapshot);
  const animations=[],media=matchMedia('(prefers-reduced-motion: reduce)');let timer,target,flight,onFinish,closed=false;
  const job={close(settle){if(closed)return;closed=true;clearTimeout(timer);media.removeEventListener?.('change',reduce);window.removeEventListener('resize',resize);animations.forEach(a=>a.cancel());snapshot.remove();flight?.remove();if(target)target.style.visibility='';if(current===job)current=null;if(settle)onFinish?.();}};
  const reduce=()=>{if(media.matches)job.close(true);},resize=()=>job.close(true);current=job;media.addEventListener?.('change',reduce);window.addEventListener('resize',resize);
  return (message,settled)=>{
   if(closed)return;onFinish=settled;
   const to=composer.getBoundingClientRect(),ease='cubic-bezier(.22,.8,.32,1)';
   const movement=composer.animate([{transform:`translate(${from.left-to.left}px,${from.top-to.top}px)`},{transform:'translate(0,0)'}],{duration:420,easing:ease,fill:'both'});animations.push(movement);
   animations.push(snapshot.animate([{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(-8px)'}],{duration:220,easing:'ease-out',fill:'both'}));
   const bubble=message.querySelector('.bubble');
   if(typed&&bubble){
    const rect=bubble.getBoundingClientRect(),style=getComputedStyle(bubble),line=parseFloat(style.lineHeight)||20;
    target=message;target.style.visibility='hidden';flight=document.createElement('div');flight.className='message user chat-message-flight';flight.setAttribute('aria-hidden','true');flight.inert=true;
    Object.assign(flight.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',width:rect.width+'px',height:rect.height+'px',maxHeight:card.querySelector('.messages').clientHeight+'px',overflow:'hidden',margin:'0',padding:'0',display:'block',font:style.font,color:style.color,pointerEvents:'none',zIndex:'1011'});
    const copy=bubble.cloneNode(true);Object.assign(copy.style,{width:'100%',maxWidth:'100%',margin:'0'});flight.append(copy);document.body.append(flight);
    const x=inputFrom.left-rect.left-parseFloat(style.paddingLeft||0),y=inputFrom.top+(inputFrom.height-line)/2-rect.top-parseFloat(style.paddingTop||0);
    animations.push(flight.animate([{transform:`translate(${x}px,${y}px)`,opacity:.9},{transform:'translate(0,0)',opacity:1}],{duration:380,easing:ease,fill:'both'}));
   }
   movement.onfinish=()=>job.close(true);
   // A cold map compositor can delay WAAPI's first frame. Start the safety
   // timer only after playback is ready, never while the animation is pending.
   movement.ready.then(()=>{if(!closed)timer=setTimeout(()=>job.close(true),650);}).catch(()=>{if(!closed)job.close(true);});
  };
 }
 window.WanderChatMotion={prepareFirstSend,cancel,get active(){return Boolean(current);}};
})();
