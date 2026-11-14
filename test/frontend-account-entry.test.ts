import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {setup} from './frontend-fixture.ts';

// Issue #20: the memory+avatar entry pair moves out of the left card into a
// global top-right group. DOM ids are contractual (auth.js/preferences.js
// resolve them by id); the avatar button owns #auth-avatar and a dynamic
// accessible name instead of button text.
const html = readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');
const preferencesSource = readFileSync(new URL('../frontend/preferences.js', import.meta.url), 'utf8');

type Ctx = ReturnType<typeof setup>;
const ariaLabel = (h: Ctx, id = 'auth-open') => h.$(id).attrs.get('aria-label');
const occurrences = (id: string) => html.split(`id="${id}"`).length - 1;

test('index.html keeps every contractual id exactly once', () => {
  for (const id of [
    'auth-open', 'auth-avatar', 'auth-panel', 'auth-form', 'auth-username-input', 'auth-password-input',
    'auth-login', 'auth-signed-in', 'auth-username', 'auth-logout', 'auth-status',
    'preferences-open', 'preferences-panel', 'preferences-form', 'preferences-content', 'preferences-close',
    'new-chat', 'history-list', 'activity-detail', 'map',
  ]) {
    assert.equal(occurrences(id), 1, `id="${id}" must appear exactly once`);
  }
});

test('the avatar span lives inside the auth-open button', () => {
  const open = html.indexOf('id="auth-open"');
  assert.ok(open >= 0);
  const close = html.indexOf('</button>', open);
  const avatar = html.indexOf('id="auth-avatar"');
  assert.ok(avatar > open && avatar < close, '#auth-avatar must be a child of #auth-open');
  assert.match(html.slice(open, close), /aria-haspopup="dialog"/);
  assert.match(html.slice(open, close), /aria-controls="auth-panel"/);
});

test('the memory+avatar pair sits outside the left glass card, memory first', () => {
  const cardStart = html.indexOf('class="glass-card"');
  const cardEnd = html.indexOf('</aside>', cardStart);
  assert.ok(cardStart >= 0 && cardEnd > cardStart);
  const memory = html.indexOf('id="preferences-open"');
  const avatar = html.indexOf('id="auth-open"');
  assert.ok(memory >= 0 && avatar >= 0);
  assert.ok(memory < cardStart || memory > cardEnd, 'memory entry must leave the left card');
  assert.ok(avatar < cardStart || avatar > cardEnd, 'avatar entry must leave the left card');
  assert.ok(memory < avatar, 'entry order is [记忆] then [头像]');
});

function stubAuth(h: Ctx, users: Record<string, {id: string; display_name: string}>) {
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

test('the avatar button carries a dynamic accessible name, not button text', async () => {
  const h = setup({auth: true});
  h.requests[0]!.finish({authenticated: false});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(ariaLabel(h), '登录账号');
  assert.equal(h.$('auth-open').classes.has('is-authed'), false);

  stubAuth(h, {alice: {id: 'acc-a', display_name: 'Alice'}});
  await submit(h, 'alice', 'pw');
  const name = ariaLabel(h) ?? '';
  assert.ok(name.includes('Alice') && name.includes('账号'), `signed-in name must identify the account, got "${name}"`);
  assert.equal(h.$('auth-open').classes.has('is-authed'), true);

  await h.run('($("auth-logout").listeners.get("click"))()') as Promise<void>;
  assert.equal(ariaLabel(h), '登录账号');
  assert.equal(h.$('auth-open').classes.has('is-authed'), false);
});

test('the avatar face shows a grapheme initial for the signed-in name', async () => {
  const h = setup({auth: true});
  stubAuth(h, {xiaoyu: {id: 'acc-c', display_name: '小雨点儿'}});
  await submit(h, 'xiaoyu', 'pw');
  assert.equal(h.$('auth-avatar').textContent, '小');
  assert.equal(h.$('auth-avatar').classes.has('is-initial'), true);
  await h.run('($("auth-logout").listeners.get("click"))()') as Promise<void>;
  assert.equal(h.$('auth-avatar').classes.has('is-initial'), false);
});

test('clicking the avatar while signed out opens the login dialog and Escape closes it', async () => {
  const h = setup({auth: true});
  h.requests[0]!.finish({authenticated: false});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  h.$('auth-panel').hidden = true; // the markup ships the dialog closed
  h.run('($("auth-open").listeners.get("click"))()');
  assert.equal(h.$('auth-panel').hidden, false);
  assert.equal(h.$('auth-form').hidden, false);
  assert.equal(h.$('auth-open').attrs.get('aria-expanded'), 'true');
  h.run('const e=new Event("keydown");e.key="Escape";window.dispatchEvent(e)');
  assert.equal(h.$('auth-panel').hidden, true);
  assert.equal(h.$('auth-open').attrs.get('aria-expanded'), 'false');
});

test('pointerdown outside the open dialog dismisses it', async () => {
  const h = setup({auth: true});
  h.requests[0]!.finish({authenticated: false});
  for (let i = 0; i < 10; i++) await Promise.resolve();
  h.$('auth-panel').hidden = true; // the markup ships the dialog closed
  h.run('($("auth-open").listeners.get("click"))()');
  assert.equal(h.$('auth-panel').hidden, false);
  h.run('window.dispatchEvent(new Event("pointerdown"))');
  assert.equal(h.$('auth-panel').hidden, true);
  assert.equal(h.$('auth-open').attrs.get('aria-expanded'), 'false');
});

test('the memory entry still opens the existing preferences flow', async () => {
  const h = setup({api: true});
  const calls: string[] = [];
  h.context.fetch = async (url: string) => {calls.push(url); return Response.json({content: '喜欢美术馆', updated_at: 't'});};
  vm.runInContext(preferencesSource, h.context);
  h.run('($("preferences-open").listeners.get("click"))()');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(h.$('preferences-open').attrs.get('aria-expanded'), 'true');
  assert.equal(h.$('preferences-panel').hidden, false);
  assert.deepEqual(calls, ['/api/memory']);
  assert.equal(h.$('preferences-content').value, '喜欢美术馆');
});
