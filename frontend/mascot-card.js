'use strict';
// Card mascot: one persistent boop-face anchored to the card's top-left
// header. The facade below is synchronous so chat.js can drive expressions
// before the vendor module finishes loading; the latest desired state is
// replayed once the face mounts. All business timing stays in chat.js —
// progress frames only change the current expression, unknown stages never
// reset it.
(() => {
 const STAGE_STATE=Object.assign(Object.create(null),{searching_events:'searching',exploring_plans:'thinking',routing:'thinking',validating_schedule:'validating'});
 const KIND_STATE=Object.assign(Object.create(null),{plans:'happy',itinerary:'happy',answer:'happy',clarification:'asking'});
 let controller=null,current='idle',pending='idle';
 function commit(next){pending=next;current=next;if(controller)try{controller.setState(next);}catch{/* a broken face must not break chat */}}
 const api={
  get state(){return current;},
  begin(){commit('thinking');},
  // Own-key lookups only: inherited names like toString/__proto__ and any
  // unknown stage/kind keep the current expression instead of committing a
  // function into pending (which would then throw on mount replay).
  progress(stage){if(Object.hasOwn(STAGE_STATE,stage))commit(STAGE_STATE[stage]);},
  finish(kind){if(Object.hasOwn(KIND_STATE,kind))commit(KIND_STATE[kind]);},
  fail(){commit('confused');},
  idle(){commit('idle');},
 };
 window.WanderMascot=api;
 window.addEventListener('wander:reset',()=>api.idle());
 const card=document.querySelector('.glass-card');
 if(!card)return;
 let face=null;
 Promise.resolve().then(()=>import('./wander-mascot.js')).then(({createWanderMascot})=>{
  face=document.createElement('boop-face');
  face.className='card-mascot';
  face.setAttribute('aria-hidden','true');
  face.setAttribute('color','#26382d');
  face.setAttribute('auto-sleep','0');
  face.setAttribute('press-squeeze','false');
  face.setAttribute('antenna-drag','false');
  face.setAttribute('motion','auto');
  card.append(face);
  controller=createWanderMascot(face,{palette:'moss',pointerFollow:true});
  if(pending!=='idle')commit(pending);
 }).catch(error=>{
  // Degraded: no mascot, but every WanderMascot call stays a safe no-op and
  // the text progress bubble keeps reporting the real request state.
  face?.remove();face=null;
  console.error('漫游小伙伴加载失败:',error);
 });
})();
