'use strict';
// One identity and renderer for the account entry and every user message.
(() => {
 const glyph='<svg viewBox="0 0 24 24"><circle cx="12" cy="8.4" r="3.5"/><path d="M5.9 19.4c1-3.2 3.3-4.9 6.1-4.9s5.1 1.7 6.1 4.9"/></svg>';
 let initial='';
 function render(el){
  if(initial)el.textContent=initial;else el.innerHTML=glyph;
  el.classList.toggle('is-initial',Boolean(initial));
 }
 function attach(el){el.setAttribute('data-user-avatar','');render(el);}
 function setName(name){
  const text=String(name||'').trim();
  initial=text&&typeof Intl.Segmenter==='function'
   ?new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)[Symbol.iterator]().next().value.segment
   :[...text][0]||'';
  document.querySelectorAll('[data-user-avatar]').forEach(render);
 }
 window.WanderUserAvatar={attach,setName};
 setName('');
})();
