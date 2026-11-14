'use strict';
// Optional login: anonymous stays fully functional; signing in merges the
// anonymous cookie identity into the account server-side (see /api/login).
(() => {
 const openBtn=$('auth-open'),avatarEl=$('auth-avatar'),panel=$('auth-panel'),form=$('auth-form'),signedIn=$('auth-signed-in'),statusEl=$('auth-status');
 let me={authenticated:false},meEpoch=0,busy=false,returnFocus;
 // The button hosts #auth-avatar only; its name lives on aria-label, so
 // render() never rewrites the button's textContent (that would wipe the
 // span). The stock person glyph is the signed-out face and is restored
 // whenever no initial can be rendered.
 const defaultAvatar=avatarEl?avatarEl.innerHTML:'';
 function displayName(){const user=me&&me.user;return String(user&&(user.display_name||user.username)||'');}
 function initialOf(text){
  const trimmed=text.trim();if(!trimmed)return '';
  try{
   if(typeof Intl!=='undefined'&&typeof Intl.Segmenter==='function'){
    const first=new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(trimmed)[Symbol.iterator]().next();
    if(!first.done)return first.value.segment;
   }
  }catch{}
  return [...trimmed][0]||'';
 }
 function render(){
  const authed=me&&me.authenticated===true&&me.user,name=authed?displayName():'',initial=name?initialOf(name):'';
  form.hidden=Boolean(authed);signedIn.hidden=!authed;
  if(avatarEl){
   if(initial){avatarEl.textContent=initial;avatarEl.classList.add('is-initial');}
   else{avatarEl.innerHTML=defaultAvatar;avatarEl.classList.remove('is-initial');}
  }
  openBtn.classList.toggle('is-authed',Boolean(authed));
  openBtn.setAttribute('aria-label',authed?(name?'账号菜单：'+name:'账号菜单'):'登录账号');
  openBtn.setAttribute('aria-expanded',String(!panel.hidden));
  openBtn.setAttribute('aria-busy',String(busy));
  panel.setAttribute('aria-busy',String(busy));
  panel.setAttribute('aria-label',authed?'账号菜单':'账号登录');
  if(authed)$('auth-username').textContent=name;
  $('auth-login').disabled=busy;$('auth-login').textContent=busy?'登录中…':'登录';
  $('auth-logout').disabled=busy;
 }
 function status(text){statusEl.textContent=text||'';}
 async function api(path,init){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await fetch(path,{credentials:'same-origin',signal:controller.signal,...init,
    headers:{Accept:'application/json',...(init&&init.method!=='GET'?{'Content-Type':'application/json'}:{}),...(init&&init.headers)}});
   let data=null;try{data=await response.json();}catch{}
   return {status:response.status,data};
  }finally{clearTimeout(timer);}
 }
 // Local history is bucketed per identity (see history.js): accounts use
 // 'u-<userId>', the anonymous identity is 'guest'.
 function bucket(){return me.authenticated===true&&me.user&&typeof me.user.id==='string'&&me.user.id!==''?'u-'+me.user.id:'guest';}
 function applyIdentity(){window.WanderHistory?.setIdentity?.(bucket());}
 // New cookie identity ⇒ history swaps to the new bucket (old snapshots stay
 // under the old one); the preferences doc is force-reloaded so a stale draft
 // can never be saved into the new identity's user_memory.
 function switchIdentity(){applyIdentity();window.WanderPreferences?.load?.(true);}
 async function refresh(){
  const epoch=++meEpoch;
  try{const r=await api('/api/me',{method:'GET'});if(epoch!==meEpoch)return;if(r.status===200&&r.data&&typeof r.data.authenticated==='boolean')me=r.data;}catch{}
  // Any settled reply resolves the identity — failure falls back to guest so
  // pending-bucket writes are never stranded.
  if(epoch!==meEpoch)return;
  applyIdentity();render();
 }
 function open(){returnFocus=document.activeElement;panel.hidden=false;render();(form.hidden?$('auth-logout'):$('auth-username-input')).focus({preventScroll:true});}
 // Outside dismissal drops focus instead of yanking it back to the button;
 // restoreFocus is for deliberate closes only (toggle, Escape, transitions).
 function close(restoreFocus=true){panel.hidden=true;status('');openBtn.setAttribute('aria-expanded','false');if(restoreFocus)(returnFocus||openBtn).focus({preventScroll:true});}
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;
  const username=$('auth-username-input').value.trim(),password=$('auth-password-input').value;
  if(!username||!password){status('请输入用户名和密码');return;}
  busy=true;meEpoch++;status('');render();
  // Suspend preference writes the moment the transition starts: the new
  // cookie can go live before this handler resumes, and an old-identity
  // draft must never be sent under it.
  window.WanderPreferences?.suspend?.();
  try{
   const r=await api('/api/login',{method:'POST',body:JSON.stringify({username,password})});
   if(r.status===200&&r.data&&r.data.user){me={authenticated:true,user:r.data.user};$('auth-password-input').value='';render();close();switchIdentity();}
   else{
    window.WanderPreferences?.resume?.();
    if(r.status===401)status('用户名或密码错误');
    else if(r.status===429)status('尝试次数过多，请稍后再试');
    else status('登录失败，请稍后重试');
   }
  }catch{window.WanderPreferences?.resume?.();status('无法连接服务器，请稍后重试');}
  finally{busy=false;render();}
 });
 $('auth-logout').addEventListener('click',async()=>{
  if(busy)return;busy=true;meEpoch++;status('');render();
  window.WanderPreferences?.suspend?.();
  try{
   const r=await api('/api/logout',{method:'POST'});
   if(r.status!==204){window.WanderPreferences?.resume?.();status('退出失败，请稍后重试');return;}
   me={authenticated:false};render();close();switchIdentity();
  }catch{window.WanderPreferences?.resume?.();status('无法确认退出结果，请重试');}
  finally{busy=false;render();}
 });
 openBtn.addEventListener('click',()=>{if(panel.hidden)open();else close();});
 window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden)close();});
 window.addEventListener('pointerdown',event=>{
  const target=event.target;
  if(panel.hidden||target===panel||target===openBtn||panel.contains?.(target)||openBtn.contains?.(target))return;
  close(false);
 });
 window.addEventListener('focusin',event=>{
  const target=event.target;
  if(panel.hidden||target===openBtn||panel.contains?.(target)||openBtn.contains?.(target))return;
  close(false);
 });
 refresh();
})();
