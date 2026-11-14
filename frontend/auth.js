'use strict';
// Optional login: anonymous stays fully functional; signing in merges the
// anonymous cookie identity into the account server-side (see /api/login).
(() => {
 const openBtn=$('auth-open'),panel=$('auth-panel'),form=$('auth-form'),signedIn=$('auth-signed-in'),statusEl=$('auth-status');
 let me={authenticated:false},meEpoch=0,busy=false,returnFocus;
 function render(){
  const authed=me&&me.authenticated===true&&me.user;
  form.hidden=Boolean(authed);signedIn.hidden=!authed;
  openBtn.textContent=authed?String(me.user.username||'账号'):'登录';
  openBtn.setAttribute('aria-expanded',String(!panel.hidden));
  if(authed)$('auth-username').textContent=String(me.user.display_name||me.user.username||'');
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
 function close(){panel.hidden=true;status('');openBtn.setAttribute('aria-expanded','false');(returnFocus||openBtn).focus({preventScroll:true});}
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
 refresh();
})();
