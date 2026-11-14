import assert from 'node:assert/strict';
import test from 'node:test';
import {setup,saved} from './frontend-fixture.ts';

test('history shows the newest two entries and expands inline; selection restores its session', async () => {
  const h = setup({ entries: [saved('third', 9), saved('second', 10), saved('first', 11)].reverse() });
  assert.equal(h.$('history-list').children.length, 2);
  assert.equal(h.$('history-list').children[0]!.children[0]!.textContent, '11.11');
  h.$('more-history').click();
  assert.equal(h.$('history-list').children.length, 3);
  assert.equal(h.$('messages').hidden, true);
  h.$('history-list').children[0]!.click();
  for (let i = 0; i < 12; i++) await Promise.resolve(); // settle any collapse transition
  assert.equal(h.state.sessionId, 'first');
  assert.equal(h.state.messages[0]!.text, '出游 11');
  assert.equal(h.$('messages').hidden, false);
});

test('new chat saves the conversation and resets route, session and input', () => {
  const h = setup();
  h.state.messages.push({ role: 'user', text: '西安一日游' }, { role: 'assistant', text: '安排好了' });
  h.state.sessionId = 'server-session'; h.state.busy = true; h.$('message-input').value = '未发送';
  h.run('let removed=false; map={removeLayer(){removed=true}}; routeLayer={};');
  h.$('new-chat').click();
  assert.equal(h.state.messages.length, 0); assert.equal(h.state.sessionId, null);
  assert.equal(h.state.busy, false); assert.equal(h.$('message-input').value, '');
  assert.equal(h.run('removed && routeLayer===null'), true);
  assert.equal(h.stored()[0].title, '西安一日游');
  assert.equal(h.$('history-list').children.length, 1);
});

test('blocked storage still permits in-page history; titles render as literal text', () => {
  const h = setup({ blocked: true });
  h.state.messages.push({ role: 'user', text: '<img src=x onerror=alert(1)>' });
  h.$('new-chat').click();
  assert(h.$('history-list').children[0]!.children[1]!.textContent.startsWith('<img'));
  assert.equal(h.$('history-list').children[0]!.children[1]!.innerHTML, '');
});

test('new chat aborts an active request and stale replies cannot enter the new conversation', async () => {
  const h = setup({ api: true });
  const first = h.run('window.sendMessage("旧会话")');
  h.$('new-chat').click();
  assert.equal(h.requests[0]!.signal.aborted, true);
  const second = h.run('window.sendMessage("新会话")');
  h.requests[0]!.finish({ kind: 'clarification', session_id: 'old', question: '旧回复' });
  await first;
  assert.equal(h.state.busy, true);
  assert.equal(h.state.sessionId, null);
  assert.equal(h.requests[1]!.body.session_id, undefined);
  h.requests[1]!.finish({ kind: 'clarification', session_id: 'new', question: '新回复' });
  await second;
  assert.equal(h.state.sessionId, 'new');
  assert.deepEqual(Array.from(h.state.messages, m => m.text), ['新会话', '新回复']);
});

test('continuing a saved conversation sends its original backend session id', async () => {
  const h = setup({ api: true, entries: [saved('existing-session', 11)] });
  h.$('history-list').children[0]!.click();
  const pending = h.run('window.sendMessage("再加一个景点")');
  assert.equal(h.requests[0]!.body.session_id, 'existing-session');
  h.requests[0]!.finish({ kind: 'clarification', session_id: 'existing-session', question: '想去哪片区域？' });
  await pending;
  assert.equal(h.state.messages.at(-1)!.text, '想去哪片区域？');
});

test('a delayed map restore cannot redraw a history route after new chat', async () => {
 const entry={...saved('old',11),location:{lat:34.27,lng:108.95,name:'西安市'},routeNames:['钟楼']};
 const h=setup({entries:[entry]});
 h.run('let finishLocation; selectLocation=()=>new Promise(resolve=>{finishLocation=resolve}); let redraws=0; drawRoute=()=>redraws++;');
 h.run('window.WanderHistory.open("old")');
 // Restore contains a legacy route; it must not reappear after the reset.
 h.$('new-chat').click();
 h.run('finishLocation()');await Promise.resolve();
 assert.equal(h.state.latestPlan,null);assert.equal(h.state.messages.length,0);
 assert.equal(h.run('redraws'),0);
});

test('composer enters bottom layout after sending and resets only for a new empty chat',async()=>{
 const h=setup({api:true});assert(!h.$('card').classes.has('has-conversation'));
 const job=h.run('window.sendMessage("去西安玩一天")');assert(h.$('card').classes.has('has-conversation'));assert.equal(h.$('welcome').hidden,true);
 h.requests[0]!.finish({kind:'clarification',question:'想从哪里出发？'});await job;assert(h.$('card').classes.has('has-conversation'));
 h.$('new-chat').click();assert(!h.$('card').classes.has('has-conversation'));assert.equal(h.$('welcome').hidden,false);
 h.$('history-list').children[0]!.click();assert(h.$('card').classes.has('has-conversation'));assert.equal(h.$('welcome').hidden,true);
});
