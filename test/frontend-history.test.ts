import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

class Element {
  textContent = ''; className = ''; value = ''; title = ''; type = '';
  innerHTML = ''; hidden = false; disabled = false; parent: Element | null = null;
  children: Element[] = []; attrs = new Map<string, string>();
  listeners = new Map<string, () => void>(); classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    toggle: (name: string, value: boolean) => value ? this.classes.add(name) : this.classes.delete(name),
  };
  append(...nodes: Element[]) { nodes.forEach(n => { n.parent = this; this.children.push(n); }); }
  replaceChildren() { this.children.forEach(n => { n.parent = null; }); this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  click() { this.listeners.get('click')?.(); }
  focus() {} scrollTo() {}
  querySelector() { return new Element(); }
}
const historySource = readFileSync(new URL('../frontend/history.js', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../frontend/chat.js', import.meta.url), 'utf8');
function saved(id: string, day: number) {
  return { id, createdAt: new Date(2026, 10, day).getTime(), updatedAt: day, title: `规划 ${day}`,
    messages: [{ role: 'user', text: `出游 ${day}` }, { role: 'assistant', text: '已安排' }], sessionId: id };
}
function setup({ entries = [] as ReturnType<typeof saved>[], blocked = false, api = false } = {}) {
  const elements = new Map<string, Element>();
  const $ = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  let stored = JSON.stringify(entries);
  const window = Object.assign(new EventTarget(), {
    crypto: { randomUUID },
    localStorage: {
      getItem() { if (blocked) throw new Error('blocked'); return stored; },
      setItem(_key: string, value: string) { if (blocked) throw new Error('blocked'); stored = value; },
    },
  });
  const state = { messages: [] as { role: string; text: string }[], busy: false,
    sessionId: null as string | null, latestPlan: null, routeNames: [], location: { lat: 34.27, lng: 108.95, name: '西安市' } };
  const requests: { body: Record<string, unknown>; signal: AbortSignal; finish: (value: object) => void }[] = [];
  const context = vm.createContext({ window, state, $, Event, AbortController, console,
    document: { createElement: () => new Element(), querySelector: () => $('card') },
    map: null, routeLayer: null, updatePlaceMarkers() {}, updateSendButton() {},
    selectLocation() {}, scrollMessages() {}, matchMedia: () => ({ matches: true }),
    setTimeout: () => 0, clearTimeout() {},
    appendMessage(role: string, text: string) { state.messages.push({ role, text }); },
    fetch(_url: string, options: { body: string; signal: AbortSignal }) {
      return new Promise(resolve => requests.push({ body: JSON.parse(options.body), signal: options.signal,
        finish: value => resolve({ ok: true, json: async () => value }) }));
    },
  });
  if (api) vm.runInContext(chatSource, context);
  vm.runInContext(historySource, context);
  return { $, state, context, requests, stored: () => JSON.parse(stored), run: (code: string) => vm.runInContext(code, context) };
}

test('history shows the newest two entries and expands inline; selection restores its session', () => {
  const h = setup({ entries: [saved('third', 9), saved('second', 10), saved('first', 11)].reverse() });
  assert.equal(h.$('history-list').children.length, 2);
  assert.equal(h.$('history-list').children[0]!.children[0]!.textContent, '11.11');
  h.$('more-history').click();
  assert.equal(h.$('history-list').children.length, 3);
  assert.equal(h.$('messages').hidden, true);
  h.$('history-list').children[0]!.click();
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
