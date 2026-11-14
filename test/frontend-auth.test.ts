import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {setup,saved} from './frontend-fixture.ts';

const preferencesSource = readFileSync(new URL('../frontend/preferences.js', import.meta.url), 'utf8');

type Ctx = ReturnType<typeof setup>;

// Stub the auth endpoints; the initial /api/me refresh stays pending in
// requests[0] (anonymous default), which also exercises the race guard.
function stubAuth(h: Ctx, users: Record<string, {id:string;display_name:string}>) {
  h.context.fetch = async (url: string, init: {method?: string; body?: string} = {}) => {
    if (url === '/api/login') {
      const {username} = JSON.parse(init.body ?? '{}') as {username?: string};
      const u = users[username ?? ''];
      return {status: u ? 200 : 401, json: async () => u ? {user: {id: u.id, username, display_name: u.display_name}} : {error: 'x'}} as Response;
    }
    if (url === '/api/logout') return {status: 204, json: async () => null} as Response;
    return {status: 200, json: async () => ({authenticated: false})} as Response;
  };
}
function submit(h: Ctx, username: string, password: string) {
  h.$('auth-username-input').value = username; h.$('auth-password-input').value = password;
  return h.run('($("auth-form").listeners.get("submit"))({preventDefault(){}})') as Promise<void>;
}
const guestKey = 'wander.chat-history.v1.guest';
const accountKey = (id: string) => `wander.chat-history.v1.u-${id}`;
// Issue #20: the avatar-only button carries its state on aria-label, not text.
const entryName = (h: Ctx) => h.$('auth-open').attrs.get('aria-label');
const storedAt = (h: Ctx, key: string) => JSON.parse(h.storage.get(key) ?? '[]') as {id: string; messages: {text: string}[]}[];

test('login swaps history to the account bucket and logout restores the guest bucket', async () => {
  const h = setup({entries: [saved('guest-1', 11)], auth: true});
  // While /api/me is pending the view is the (empty) pending bucket.
  assert.equal(h.$('history-list').children[0]!.className, 'history-empty');
  assert.equal(h.storage.has('wander.chat-history.v1'), false); // legacy key migrated away
  h.requests[0]!.finish({authenticated: false});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(h.$('history-list').children.length, 1); // guest-1 visible again
  assert.ok((h.storage.get(guestKey) ?? '').includes('guest-1'));

  // An in-progress anonymous conversation is captured into the GUEST bucket.
  h.state.messages.push({role: 'user', text: '匿名草稿'}, {role: 'assistant', text: '已记录'});
  h.state.sessionId = 'anon-session';

  const prefCalls: unknown[] = [];
  h.context.window.WanderPreferences = {load: (...a: unknown[]) => {prefCalls.push(a); return Promise.resolve();}};
  stubAuth(h, {alice: {id: 'acc-a', display_name: 'Alice'}});
  await submit(h, 'alice', 'pw');

  assert.equal(entryName(h), '账号菜单：Alice');
  assert.deepEqual(prefCalls, [[true]]); // identity switch force-reloads the memory doc
  // The account bucket is empty: guest snapshots are not visible to the account.
  assert.equal(h.$('history-list').children.length, 1);
  assert.equal(h.$('history-list').children[0]!.className, 'history-empty');
  assert.equal(h.state.messages.length, 0);
  assert.equal(h.state.sessionId, null);
  assert.ok((h.storage.get(guestKey) ?? '').includes('匿名草稿'));
  assert.ok(!(h.storage.get(accountKey('acc-a')) ?? '').includes('匿名草稿'));

  // New work under the account lands in the account bucket only.
  h.state.messages.push({role: 'user', text: '账号的规划'}, {role: 'assistant', text: '安排'});
  h.run('window.WanderHistory.capture()');
  assert.ok((h.storage.get(accountKey('acc-a')) ?? '').includes('账号的规划'));
  assert.ok(!(h.storage.get(guestKey) ?? '').includes('账号的规划'));

  // Logout returns to the guest bucket; both guest entries are visible again.
  await h.run('($("auth-logout").listeners.get("click"))()') as Promise<void>;
  assert.equal(entryName(h), '登录账号');
  assert.equal(h.$('history-list').children.length, 2);
  assert.equal(h.state.messages.length, 0);
});

test('switching directly between accounts re-buckets history each time', async () => {
  const h = setup({entries: [saved('guest-1', 11)], auth: true});
  stubAuth(h, {alice: {id: 'acc-a', display_name: 'A'}, bob: {id: 'acc-b', display_name: 'B'}});
  await submit(h, 'alice', 'pw');
  h.state.messages.push({role: 'user', text: 'A 的行程'}, {role: 'assistant', text: '好'});
  h.run('window.WanderHistory.capture()');

  // Log in as a different account without logging out first.
  await submit(h, 'bob', 'pw');
  assert.equal(entryName(h), '账号菜单：B');
  assert.equal(h.$('history-list').children[0]!.className, 'history-empty');
  assert.ok(!(h.storage.get(accountKey('acc-b')) ?? '').includes('A 的行程'));

  // Back to alice: only her bucket's entries reappear.
  await submit(h, 'alice', 'pw');
  assert.equal(storedAt(h, accountKey('acc-a')).length, 1);
  assert.equal(h.$('history-list').children.length, 1);
  assert.equal(h.$('history-list').children[0]!.children[1]!.textContent, 'A 的行程');
});

test('a late /api/me reply cannot overwrite the signed-in state', async () => {
  const h = setup({auth: true});
  assert.equal(h.requests.length, 1); // the init refresh() GET is still pending
  stubAuth(h, {alice: {id: 'a1', display_name: 'Alice'}});
  await submit(h, 'alice', 'pw');
  assert.equal(entryName(h), '账号菜单：Alice');
  // The init refresh resolves late with an anonymous payload — epoch-guarded.
  h.requests[0]!.finish({authenticated: false});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(entryName(h), '账号菜单：Alice');
  assert.equal(h.$('auth-form').hidden, true);
});

test('a logged-in reload buckets history under the account once /api/me lands', async () => {
  const h = setup({entries: [saved('guest-1', 11)], auth: true});
  // The init refresh() resolves to an authenticated identity: history must
  // re-bucket to the account while guest snapshots stay in the guest bucket.
  h.requests[0]!.finish({authenticated: true, user: {id: 'acc-a', username: 'alice', display_name: 'A'}});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(entryName(h), '账号菜单：A');
  assert.equal(h.$('history-list').children[0]!.className, 'history-empty');
  assert.ok((h.storage.get(guestKey) ?? '').includes('guest-1'));
});

const pendingKey = 'wander.chat-history.v1.pending';
const ticks = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('writes during the unresolved window flush into the account bucket when me lands', async () => {
  const h = setup({entries: [saved('guest-1', 11)], auth: true});
  h.state.messages.push({role: 'user', text: '窗口期消息'}, {role: 'assistant', text: 'ok'});
  h.run('window.WanderHistory.capture()');
  assert.ok((h.storage.get(pendingKey) ?? '').includes('窗口期消息'));
  assert.ok(!(h.storage.get(guestKey) ?? '').includes('窗口期消息'));
  h.requests[0]!.finish({authenticated: true, user: {id: 'acc-a', username: 'alice', display_name: 'A'}});
  await ticks();
  assert.ok((h.storage.get(accountKey('acc-a')) ?? '').includes('窗口期消息'));
  assert.equal(h.storage.has(pendingKey), false);
  assert.ok(!(h.storage.get(guestKey) ?? '').includes('窗口期消息'));
  assert.ok((h.storage.get(guestKey) ?? '').includes('guest-1')); // guest data untouched
  assert.equal(h.$('history-list').children[0]!.children[1]!.textContent, '窗口期消息');
});

test('an anonymous me resolution flushes pending writes into the guest bucket', async () => {
  const h = setup({entries: [saved('guest-1', 11)], auth: true});
  h.state.messages.push({role: 'user', text: '窗口期消息'}, {role: 'assistant', text: 'ok'});
  h.run('window.WanderHistory.capture()');
  h.requests[0]!.finish({authenticated: false});
  await ticks();
  assert.equal(storedAt(h, guestKey).length, 2); // window write + migrated entry
  assert.ok((h.storage.get(guestKey) ?? '').includes('窗口期消息'));
  assert.equal(h.storage.has(pendingKey), false);
});

test('login during the unresolved window carries pending writes into the account bucket', async () => {
  const h = setup({entries: [saved('guest-1', 11)], auth: true});
  h.state.messages.push({role: 'user', text: '匿名消息'}, {role: 'assistant', text: 'ok'});
  stubAuth(h, {alice: {id: 'acc-a', display_name: 'A'}});
  await submit(h, 'alice', 'pw');
  assert.ok((h.storage.get(accountKey('acc-a')) ?? '').includes('匿名消息'));
  assert.equal(h.storage.has(pendingKey), false);
});

test('preference writes suspend at login click and resume on failure', async () => {
  const h = setup({auth: true});
  const seq: string[] = [];
  h.context.window.WanderPreferences = {
    suspend: () => {seq.push('suspend');}, resume: () => {seq.push('resume');},
    load: (f?: boolean) => {seq.push('load:' + f); return Promise.resolve();},
  };
  // Failure path: suspend before the request, resume after the 401.
  h.context.fetch = async () => ({status: 401, json: async () => ({error: 'x'})}) as Response;
  await submit(h, 'alice', 'bad');
  assert.deepEqual(seq, ['suspend', 'resume']);
  // Success path: suspend stays held, the forced reload takes over.
  seq.length = 0;
  stubAuth(h, {alice: {id: 'a1', display_name: 'A'}});
  await submit(h, 'alice', 'pw');
  assert.deepEqual(seq, ['suspend', 'load:true']);
  // Logout suspends as well.
  seq.length = 0;
  await h.run('($("auth-logout").listeners.get("click"))()') as Promise<void>;
  assert.deepEqual(seq, ['suspend', 'load:true']);
});

test('an anonymous me resolution keeps the live conversation running', async () => {
  const h = setup({auth: true});
  h.state.messages.push({role: 'user', text: '窗口期对话'}, {role: 'assistant', text: '还在规划'});
  h.run('window.WanderHistory.capture()');
  h.requests[0]!.finish({authenticated: false});
  await ticks();
  // Guest was the assumed identity all along: no conversation reset, no epoch bump.
  assert.equal(h.state.messages.length, 2);
  assert.equal(h.run('window.WanderHistory.generation()'), 0);
  assert.ok((h.storage.get(guestKey) ?? '').includes('窗口期对话'));
  assert.equal(h.storage.has(pendingKey), false);
});

test('pending entries left over from a dead page flush into the resolved bucket', async () => {
  const h = setup({entries: [saved('guest-1', 11)], pending: [saved('stale-window', 10)], auth: true});
  // The leftover pending entry is what the boot bucket shows before me lands.
  assert.equal(h.$('history-list').children[0]!.children[1]!.textContent, '规划 10');
  h.requests[0]!.finish({authenticated: true, user: {id: 'acc-a', username: 'alice', display_name: 'A'}});
  await ticks();
  assert.ok((h.storage.get(accountKey('acc-a')) ?? '').includes('stale-window'));
  assert.ok(!(h.storage.get(guestKey) ?? '').includes('stale-window'));
  assert.equal(h.storage.has(pendingKey), false);
});

// Real preferences.js + real auth.js on one page: the whole transition window
// end to end. `release` holds the pending auth replies; `user` is the cookie
// identity the (fake) server would see, flipped exactly when the reply lands.
function wire(h: Ctx) {
  vm.runInContext(preferencesSource, h.context);
  const w = {
    user: 'guest' as 'guest' | 'acc-a',
    calls: [] as {url: string; method: string; body?: string}[],
    release: {} as Record<'login' | 'logout', (r: object) => void>,
    prefs: h.context.window.WanderPreferences,
  };
  h.context.fetch = (url: string, init: {method?: string; body?: string} = {}) => {
    const method = init.method ?? 'GET';
    w.calls.push({url, method, body: init.body});
    if (url === '/api/memory') {
      if (method === 'PUT') return Promise.resolve(Response.json({content: JSON.parse(init.body ?? '{}').content, updated_at: 't'}));
      if (method === 'DELETE') return Promise.resolve(new Response(null, {status: 204}));
      return Promise.resolve(Response.json({content: w.user === 'acc-a' ? '账号偏好' : '访客偏好', updated_at: 't'}));
    }
    if (url === '/api/login') return new Promise(resolve => {w.release.login = resolve;});
    if (url === '/api/logout') return new Promise(resolve => {w.release.logout = resolve;});
    return Promise.resolve({status: 200, json: async () => ({authenticated: false})});
  };
  return w;
}

test('a save during the login window never reaches the wire; the new doc loads on success', async () => {
  const h = setup({auth: true});
  const w = wire(h), prefs = w.prefs;
  h.requests[0]!.finish({authenticated: false});
  await ticks();
  await prefs.open();
  assert.equal(h.$('preferences-content').value, '访客偏好');
  h.$('preferences-content').value = '窗口期旧草稿';
  h.$('preferences-content').listeners.get('input')!();

  const login = submit(h, 'alice', 'pw');
  assert.equal(w.calls.at(-1)!.url, '/api/login'); // POST already left
  // Suspended at click time: every write entry is dead — no PUT/DELETE and no extra GET.
  assert.equal(h.$('preferences-content').disabled, true);
  assert.equal(h.$('preferences-save').disabled, true);
  assert.equal(h.$('preferences-clear').disabled, true);
  await prefs.save(); await prefs.clear();
  h.run('($("preferences-form").listeners.get("submit"))({preventDefault(){}})');
  h.$('preferences-retry').click();
  assert.equal(w.calls.filter(c => c.url === '/api/memory').length, 1); // only the open() GET

  w.user = 'acc-a'; // the reply's Set-Cookie flips the cookie before the body parses
  w.release.login({status: 200, json: async () => ({user: {id: 'acc-a', username: 'alice', display_name: 'A'}})});
  await prefs.save(); await prefs.clear(); // still suspended until load(true) lands
  assert.equal(w.calls.filter(c => c.method === 'PUT' || c.method === 'DELETE').length, 0);
  await login; await ticks();
  assert.equal(h.$('preferences-content').value, '账号偏好'); // re-fetched under the new cookie
  assert.ok(w.calls.every(c => !(c.body ?? '').includes('窗口期旧草稿'))); // stale draft never sent
});

test('a failed login resumes the suspended draft so a retry still writes under the old identity', async () => {
  const h = setup({auth: true});
  const w = wire(h), prefs = w.prefs;
  h.requests[0]!.finish({authenticated: false});
  await ticks();
  await prefs.open();
  h.$('preferences-content').value = '窗口期旧草稿';
  h.$('preferences-content').listeners.get('input')!();
  const login = submit(h, 'alice', 'bad');
  w.release.login({status: 401, json: async () => ({error: 'x'})});
  await login; await ticks();
  // Transition failed → same identity: the draft is editable again, nothing discarded.
  assert.equal(h.$('preferences-content').disabled, false);
  assert.equal(h.$('preferences-content').value, '窗口期旧草稿');
  assert.equal(h.$('preferences-save').disabled, false);
  await prefs.save();
  const put = w.calls.at(-1)!;
  assert.equal(put.method, 'PUT');
  assert.deepEqual(JSON.parse(put.body!), {content: '窗口期旧草稿'});
});

test('a save during the logout window is suspended the same way', async () => {
  const h = setup({auth: true});
  const w = wire(h), prefs = w.prefs;
  w.user = 'acc-a';
  h.requests[0]!.finish({authenticated: true, user: {id: 'acc-a', username: 'alice', display_name: 'A'}});
  await ticks();
  await prefs.open();
  assert.equal(h.$('preferences-content').value, '账号偏好');
  h.$('preferences-content').value = '未同步的账号草稿';
  h.$('preferences-content').listeners.get('input')!();
  const logout = h.run('($("auth-logout").listeners.get("click"))()') as Promise<void>;
  assert.equal(w.calls.at(-1)!.url, '/api/logout');
  assert.equal(h.$('preferences-content').disabled, true);
  await prefs.save(); await prefs.clear();
  assert.equal(w.calls.filter(c => c.method === 'PUT' || c.method === 'DELETE').length, 0);
  w.user = 'guest'; // the 204 clears the cookie
  w.release.logout({status: 204, json: async () => null});
  await logout; await ticks();
  assert.equal(h.$('preferences-content').value, '访客偏好');
  assert.ok(w.calls.every(c => !(c.body ?? '').includes('未同步的账号草稿')));
});
