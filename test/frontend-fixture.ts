import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
export class Element {
  textContent = ''; className = ''; value = ''; title = ''; type = '';
  href = ''; src = ''; alt = ''; id = ''; tabIndex = 0;
  style = { setProperty(_name: string, _value: string) {} };
  innerHTML = ''; hidden = false; disabled = false; parent: Element | null = null;
  children: Element[] = []; attrs = new Map<string, string>();
  listeners = new Map<string, () => void>(); classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
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
const plansSource = readFileSync(new URL('../frontend/plans.js', import.meta.url), 'utf8');
const transportSource = readFileSync(new URL('../frontend/transport.js', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../frontend/chat.js', import.meta.url), 'utf8');
export function saved(id: string, day: number) {
  return { id, createdAt: new Date(2026, 10, day).getTime(), updatedAt: day, title: `规划 ${day}`,
    messages: [{ role: 'user', text: `出游 ${day}` }, { role: 'assistant', text: '已安排' }], sessionId: id };
}
export function setup({ entries = [] as ReturnType<typeof saved>[], blocked = false, api = false, mock = null as string | null } = {}) {
  const elements = new Map<string, Element>();
  const $ = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  let stored = JSON.stringify(entries);
  const window = Object.assign(new EventTarget(), {
    crypto: { randomUUID }, location: {search: mock ? '?mock='+mock : ''}, WANDER_CONFIG: {mockDelay:0},
    localStorage: {
      getItem() { if (blocked) throw new Error('blocked'); return stored; },
      setItem(_key: string, value: string) { if (blocked) throw new Error('blocked'); stored = value; },
    },
  });
  const state = { messages: [] as { role: string; text: string }[], busy: false,
    sessionId: null as string | null, latestPlan: null, routeNames: [], location: { lat: 34.27, lng: 108.95, name: '西安市' } };
  const requests: { body: Record<string, unknown>; signal: AbortSignal; finish: (value: object) => void }[] = [];
  const context = vm.createContext({ window, state, $, Event, AbortController, console, URL, URLSearchParams, TextDecoder, DOMException,
    document: { createElement: () => new Element(), querySelector: () => $('card') },
    map: null, routeLayer: null, updatePlaceMarkers() {}, updateSendButton() {},
    selectLocation() {}, scrollMessages() {}, matchMedia: () => ({ matches: true }),
    setTimeout: (callback: () => void, ms: number) => {if(ms<=500)queueMicrotask(callback);return 0;}, clearTimeout() {},
    appendMessage(role: string, text: string) { state.messages.push({ role, text }); },
    fetch(_url: string, options: { body: string; signal: AbortSignal }) {
      return new Promise(resolve => requests.push({ body: JSON.parse(options.body), signal: options.signal,
        finish: value => resolve({ ok: true, json: async () => value }) }));
    },
  });
  if (api) { vm.runInContext(plansSource, context);vm.runInContext(transportSource, context);vm.runInContext(chatSource, context); }
  vm.runInContext(historySource, context);
  return { $, state, context, requests, stored: () => JSON.parse(stored), run: (code: string) => vm.runInContext(code, context) };
}

