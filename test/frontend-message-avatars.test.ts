import assert from 'node:assert/strict';
import test from 'node:test';
import {setup} from './frontend-fixture.ts';

test('account and all user rows share the current avatar, including future rows', () => {
 const h=setup({api:true});
 h.run('appendMessage("user","第一条");appendMessage("user","第二条")');
 const rows=h.$('messages').children;
 assert.ok(rows.every(row=>row.children[0].attrs.has('data-user-avatar')));
 h.run('window.WanderUserAvatar.setName("👩🏽‍💻老绵羊")');
 assert.equal(h.$('auth-avatar').textContent,'👩🏽‍💻');
 assert.ok(rows.every(row=>row.children[0].textContent==='👩🏽‍💻'));
 h.run('appendMessage("user","第三条")');
 assert.equal(h.$('messages').children.at(-1)!.children[0].textContent,'👩🏽‍💻');
 h.run('window.WanderUserAvatar.setName("")');
 assert.ok(h.$('messages').children.every(row=>row.children[0].innerHTML===h.$('auth-avatar').innerHTML));
 assert.ok(h.$('auth-avatar').innerHTML.includes('<svg'));
});

test('all assistant output paths register their avatar with the same lifecycle', async () => {
 const h=setup({api:true});
 h.run('window.__avatars=[];window.WanderMascot={attach(slot){window.__avatars.push(slot)},begin(){return {round:1}},settle(){}}');
 h.run('appendMessage("assistant","回答");showSendError("问题",new Error("断网"))');
 assert.equal(h.run('window.__avatars.length'),2);
 h.run('window.WanderTransport.request=async()=>({kind:"answer",text:"完成"})');
 await h.run('window.sendMessage("下一题")');
 assert.equal(h.run('window.__avatars.length'),4,'planning and final reply both attach');
 assert.equal(h.$('messages').children.filter(row=>row.classes.has('assistant')).length,3);
});

test('user-controlled display names are rendered as text', () => {
 const h=setup({api:true});
 h.run('window.WanderUserAvatar.setName("<img src=x onerror=alert(1)>");appendMessage("user","你好")');
 assert.equal(h.$('auth-avatar').textContent,'<');
 assert.equal(h.$('messages').children[0].children[0].textContent,'<');
});
