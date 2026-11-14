import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
export class Element {
  textContent = ''; value = ''; title = ''; type = '';
  href = ''; src = ''; alt = ''; id = ''; tabIndex = 0;
  style = { setProperty(_name: string, _value: string) {} } as Record<string, unknown> & { setProperty(name: string, value: string): void };
  innerHTML = ''; hidden = false; disabled = false; parent: Element | null = null;
  children: Element[] = []; attrs = new Map<string, string>();
  listeners = new Map<string, (event?: unknown) => void>(); classes = new Set<string>();
  classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, value = !this.classes.has(name)) => value ? this.classes.add(name) : this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
  };
  get className() { return [...this.classes].join(' '); }
  set className(value: string) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  append(...nodes: Element[]) { nodes.forEach(n => { n.parent = this; this.children.push(n); }); }
  replaceChildren() { this.children.forEach(n => { n.parent = null; }); this.children = []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); this.parent = null; }
  addEventListener(name: string, callback: (event?: unknown) => void) { this.listeners.set(name, callback); }
  removeEventListener(name: string, callback?: (event?: unknown) => void) { if (!callback || this.listeners.get(name) === callback) this.listeners.delete(name); }
  dispatchEvent(event: { type: string } & Record<string, unknown>) { this.listeners.get(event.type)?.(event); return true; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  click() { this.listeners.get('click')?.(); }
  focus() {} scrollTo() {}
  // WAAPI surface: history rows animate sink+fade via element.animate().
  animate(_keyframes?: unknown, _options?: unknown) { return { cancel() {}, finished: Promise.resolve(), onfinish: null }; }
  querySelector() { return new Element(); }
}
const historySource = readFileSync(new URL('../frontend/history.js', import.meta.url), 'utf8');
const mapLayoutSource=readFileSync(new URL('../frontend/map-layout.js',import.meta.url),'utf8');
const plansSource = readFileSync(new URL('../frontend/plans.js', import.meta.url), 'utf8');
const transportSource = readFileSync(new URL('../frontend/transport.js', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../frontend/chat.js', import.meta.url), 'utf8');
const authSource = readFileSync(new URL('../frontend/auth.js', import.meta.url), 'utf8');
export function saved(id: string, day: number) {
  return { id, createdAt: new Date(2026, 10, day).getTime(), updatedAt: day, title: `规划 ${day}`,
    messages: [{ role: 'user', text: `出游 ${day}` }, { role: 'assistant', text: '已安排' }], sessionId: id };
}
export function setup({ entries = [] as ReturnType<typeof saved>[], pending = [] as ReturnType<typeof saved>[], blocked = false, api = false, mock = null as string | null, auth = false } = {}) {
  const elements = new Map<string, Element>();
  const $ = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const historyBase = 'wander.chat-history.v1' + (mock ? '.demo' : '');
  const storage = new Map<string, string>([[historyBase, JSON.stringify(entries)]]);
  if (pending.length) storage.set(historyBase + '.pending', JSON.stringify(pending));
  const media = { matches: true }; // every query shares it; flip matches to toggle reduced-motion
  let timerSeq = 0;
  const timers = new Map<number, { cancelled: boolean }>();
  const window = Object.assign(new EventTarget(), {
    crypto: { randomUUID }, location: {search: mock ? '?mock='+mock : ''}, WANDER_CONFIG: {mockDelay:0},
    localStorage: {
      getItem(key: string) { if (blocked) throw new Error('blocked'); return storage.get(key) ?? null; },
      setItem(key: string, value: string) { if (blocked) throw new Error('blocked'); storage.set(key, value); },
      removeItem(key: string) { storage.delete(key); },
    },
  });
  const state = { messages: [] as { role: string; text: string }[], busy: false,
    sessionId: null as string | null, latestPlan: null, routeNames: [], location: { lat: 34.27, lng: 108.95, name: '西安市' } };
  const requests: { url: string; body: Record<string, unknown>; signal: AbortSignal; finish: (value: object) => void }[] = [];
  const context = vm.createContext({ window, state, $, Event, AbortController, console, URL, URLSearchParams, TextDecoder, DOMException,
    document: { createElement: () => new Element(), querySelector: () => $('card') },
    map: null, routeLayer: null, updatePlaceMarkers() {}, updateSendButton() {},
    selectLocation() {}, scrollMessages() {}, matchMedia: () => media,
    // Microtask timers keep async settling deterministic; clearTimeout really
    // cancels so a re-toggle can stop an in-flight exit callback.
    setTimeout: (callback: () => void, ms = 0) => {
      if (ms > 500) return 0;
      const id = ++timerSeq, token = { cancelled: false }; timers.set(id, token);
      queueMicrotask(() => { timers.delete(id); if (!token.cancelled) callback(); });
      return id;
    },
    clearTimeout: (id: number) => { const t = timers.get(id); if (t) t.cancelled = true; timers.delete(id); },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    appendMessage(role: string, text: string) { state.messages.push({ role, text }); },
    fetch(url: string, options: { body?: string; signal?: AbortSignal } = {}) {
      return new Promise(resolve => requests.push({ url, body: options.body === undefined ? {} : JSON.parse(options.body), signal: options.signal as AbortSignal,
        finish: value => resolve({ ok: true, status: 200, json: async () => value }) }));
    },
  });
  vm.runInContext(mapLayoutSource,context);
  if (api) { vm.runInContext(plansSource, context);vm.runInContext(transportSource, context);vm.runInContext(chatSource, context); }
  vm.runInContext(historySource, context);
  if (auth) vm.runInContext(authSource, context);
  // Without the auth module nothing resolves identity: settle to guest like
  // an instantly-answered anonymous /api/me, flushing the pending bucket.
  else vm.runInContext('window.WanderHistory.setIdentity("guest")', context);
  return { $, state, context, requests, storage, media, stored: (key = historyBase + '.guest') => JSON.parse(storage.get(key) ?? '[]'), run: (code: string) => vm.runInContext(code, context) };
}
