'use strict';
// The API persists memory per authenticated cookie. Demo storage is explicit and isolated.
(() => {
 const demo=window.WANDER_CONFIG?.mockMemory===true,storageKey='wander.demo-preferences.v1';
 let saved={content:'',updated_at:null},loaded=false,busy=false,confirmClear=false,requestEpoch=0,returnFocus,slideTimer=0,slideDone;
 const input=$('preferences-content'),panel=$('preferences-panel');
 const still=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 const refreshMap=()=>{window.WanderAMap?.updatePlaces?.();window.dispatchEvent(new Event('wander:viewport'));};
 const valid=value=>value&&typeof value.content==='string'&&(value.updated_at===null||typeof value.updated_at==='string');
 const dirty=()=>input.value.trim()!==saved.content;
 function status(message,error=false){$('preferences-status').textContent=message;$('preferences-status').classList.toggle('error',error);}
 function update(){
  input.disabled=busy||!loaded;$('preferences-count').textContent=input.value.length+' / 8000';
  const content=input.value.trim();$('preferences-save').disabled=busy||!loaded||!dirty()||!content||content.length>8000;
  $('preferences-clear').disabled=busy||!loaded||!saved.content&&!content;
  $('preferences-save').textContent=busy?'处理中…':'保存修改';$('preferences-clear').textContent=confirmClear?'确认清空':'清空偏好';
  const date=saved.updated_at&&new Date(saved.updated_at);
  $('preferences-updated').textContent=date&&Number.isFinite(date.getTime())?'上次保存 '+date.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'暂无已保存偏好';
  $('preferences-mode').textContent=demo?'演示模式：偏好只保存在当前浏览器，不会写入真实账号。':'这里是城市向导记住的兴趣与出行习惯，你可以随时修改。';
  panel.setAttribute('aria-busy',String(busy));
 }
 async function api(method,content){
  if(demo){try{
   if(method==='GET'){const raw=window.localStorage.getItem(storageKey);if(!raw)return {content:'',updated_at:null};const data=JSON.parse(raw);if(!valid(data))throw new Error('无法读取演示偏好');return data;}
   if(method==='DELETE'){window.localStorage.removeItem(storageKey);return {content:'',updated_at:null};}
   const data={content,updated_at:new Date().toISOString()};window.localStorage.setItem(storageKey,JSON.stringify(data));return data;
  }catch{throw new Error('当前浏览器无法读取或保存演示偏好，请检查存储设置。');}}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{
   const response=await fetch(window.WANDER_CONFIG?.memoryEndpoint||'/api/memory',{method,credentials:'same-origin',signal:controller.signal,
    headers:method==='PUT'?{'Content-Type':'application/json',Accept:'application/json'}:{Accept:'application/json'},...(method==='PUT'?{body:JSON.stringify({content})}:{})});
   if(!response.ok)throw new Error(response.status===404?'偏好服务尚未连接，请稍后重试':response.status===413?'内容过长，请精简后保存':'偏好服务暂不可用，请稍后重试');
   if(method==='DELETE'){if(response.status!==204)throw new Error('未能确认清空结果，请重新加载');return {content:'',updated_at:null};}
   const data=await response.json();if(!valid(data))throw new Error('偏好数据格式暂不支持');return data;
  }catch(error){if(error?.name==='AbortError')throw new Error('连接超时，请重试');if(error instanceof TypeError)throw new Error('无法连接偏好服务，请检查网络后重试');throw error;}
  finally{clearTimeout(timer);}
 }
 async function load(){
  if(busy||loaded&&dirty())return;const epoch=++requestEpoch;busy=true;confirmClear=false;status('正在读取偏好…');$('preferences-retry').hidden=true;update();
  try{const data=await api('GET');if(epoch!==requestEpoch)return;saved=data;loaded=true;input.value=data.content;status(data.content?'这些偏好会帮助城市向导理解你的下一次规划。':'还没有偏好，写下你喜欢的出行方式吧。');}
  catch(error){if(epoch===requestEpoch){status(error.message||'偏好读取失败',true);$('preferences-retry').hidden=false;}}
  finally{if(epoch===requestEpoch){busy=false;update();}}
 }
 function slideIn(){
  const wasHidden=panel.hidden;
  if(!wasHidden&&!panel.classList.contains?.('is-leaving'))return;
  clearTimeout(slideTimer);panel.removeEventListener?.('transitionend',slideDone);panel.hidden=false;
  const done=event=>{
   if(event&&(event.propertyName!=='transform'||event.target!==panel))return;
   panel.removeEventListener?.('transitionend',done);clearTimeout(slideTimer);refreshMap();
  };
  if(panel.classList.contains?.('is-leaving'))panel.classList.remove('is-leaving');
  else if(still()){refreshMap();return;}
  else{panel.classList.add('is-off');void panel.offsetWidth;panel.classList.remove('is-off');}
  panel.addEventListener('transitionend',slideDone=done);slideTimer=setTimeout(done,340);
 }
 function slideOut(){
  if(panel.hidden)return;
  if(panel.classList.contains?.('is-leaving')){
   if(!still())return;
   panel.removeEventListener?.('transitionend',slideDone);clearTimeout(slideTimer);panel.classList.remove('is-leaving');panel.hidden=true;refreshMap();return;
  }
  clearTimeout(slideTimer);panel.removeEventListener?.('transitionend',slideDone);
  if(still()){panel.hidden=true;refreshMap();return;}
  panel.classList.add('is-leaving');
  const done=event=>{
   if(event&&(event.propertyName!=='transform'||event.target!==panel))return;
   panel.removeEventListener?.('transitionend',done);clearTimeout(slideTimer);
   if(!panel.classList.contains?.('is-leaving'))return;
   panel.classList.remove('is-leaving');panel.hidden=true;refreshMap();
  };
  panel.addEventListener('transitionend',slideDone=done);slideTimer=setTimeout(done,380);
 }
 function open(){returnFocus=document.activeElement;slideIn();$('preferences-open').setAttribute('aria-expanded','true');window.WanderAMap?.updatePlaces?.();$('preferences-close').focus({preventScroll:true});if(loaded&&dirty()){status('你有尚未保存的修改。');update();return;}return load();}
 function close(){slideOut();confirmClear=false;update();$('preferences-open').setAttribute('aria-expanded','false');window.WanderAMap?.updatePlaces?.();(returnFocus||$('preferences-open')).focus({preventScroll:true});}
 async function save(){
  const content=input.value.trim();if(busy||!loaded||!content||content.length>8000||!dirty())return;
  busy=true;confirmClear=false;status('正在保存偏好…');update();
  try{saved=await api('PUT',content);input.value=saved.content;status(demo?'演示偏好已保存到当前浏览器。':'偏好已保存，下次规划会参考这些内容。');}
  catch(error){status(error.message||'保存失败，你的修改仍保留在这里。',true);}
  finally{busy=false;update();}
 }
 async function clear(){
  if(busy||!loaded||!saved.content&&!input.value.trim())return;
  if(!confirmClear){confirmClear=true;status('再次点击“确认清空”，删除已保存的偏好。');update();return;}
  busy=true;status('正在清空偏好…');update();
  try{saved=await api('DELETE');input.value='';confirmClear=false;status('偏好已清空。');}
  catch(error){status(error.message||'清空失败，原偏好已保留。',true);}
  finally{busy=false;update();}
 }
 input.addEventListener('input',()=>{confirmClear=false;status(dirty()?'修改尚未保存。':'');update();});
 $('preferences-open').addEventListener('click',open);$('preferences-close').addEventListener('click',close);
 $('preferences-form').addEventListener('submit',event=>{event.preventDefault();save();});
 $('preferences-clear').addEventListener('click',clear);$('preferences-retry').addEventListener('click',load);
 window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!panel.hidden)close();});
 window.WanderPreferences={open,close,load,save,clear};update();
})();
