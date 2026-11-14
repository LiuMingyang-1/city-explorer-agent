import assert from 'node:assert/strict';
import test from 'node:test';
import { setup, saved, type Element } from './frontend-fixture.ts';

// Issue #16: expanding "更多历史规划" slides the panel up while fading in;
// collapsing slides it down while fading out, and the expanded view is only
// torn down after the exit finishes. The vm harness cannot see transforms or
// opacity — it asserts the observable state contract: DOM state during and
// after each transition, rapid-toggle convergence, and that nothing from an
// interrupted transition leaks into the settled UI.

const ticks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const entries3 = () => [saved('c', 11), saved('b', 10), saved('a', 9)];
const rowsIn = (el: Element, acc: Element[] = []): Element[] => {
  for (const child of el.children) { if (child.classes.has('history-entry')) acc.push(child); rowsIn(child, acc); }
  return acc;
};
// Entries may be nested (e.g. an animated wrapper) — count them recursively.
const historyRows = (h: ReturnType<typeof setup>) => rowsIn(h.$('history-list'));
const animate = (h: ReturnType<typeof setup>) => { h.media.matches = false; };
// Class names that only make sense mid-transition; a settled UI must not keep
// them, whatever the implementation calls them.
const RESIDUE = /leav|is-off|closing|entering|exit|motion|slide/i;
const residue = (h: ReturnType<typeof setup>) => {
  const regions = ['card', 'history-area', 'history-list', 'messages', 'more-history']
    .flatMap(id => [...h.$(id).classes].map(c => `${id}.${c}`));
  const rows = historyRows(h).flatMap(row => [...row.classes].map(c => `history-entry.${c}`));
  return [...regions, ...rows].filter(name => RESIDUE.test(name));
};
// The expanded view survives mid-exit in some form: the full list is still
// rendered or the container still carries its expanded state.
const expandedState = (h: ReturnType<typeof setup>) =>
  h.$('card').classes.has('history-expanded') || historyRows(h).length === 3;
// A transitionend arriving after everything settled is a no-op for a correct
// implementation — stale listeners would corrupt the state here.
const strayTransitionEnd = (h: ReturnType<typeof setup>) => {
  for (const id of ['card', 'history-area', 'history-list', 'messages', 'more-history'])
    h.$(id).dispatchEvent({ type: 'transitionend', propertyName: 'transform', target: h.$(id) });
};

test('expanding shows every saved entry and stays expanded after the transition settles', async () => {
  const h = setup({ entries: entries3() });
  animate(h);
  assert.equal(historyRows(h).length, 2);
  h.$('more-history').click();
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'true');
  assert.equal(h.$('messages').hidden, true);
  assert.equal(historyRows(h).length, 3);
  assert(h.$('card').classes.has('history-expanded'));
  await ticks();
  assert.equal(historyRows(h).length, 3);
  assert.equal(h.$('messages').hidden, true);
  assert.equal(h.$('more-history').textContent, '收起历史规划');
  assert.deepEqual(residue(h), []);
});

test('collapsing keeps the expanded view through the exit, then restores the collapsed footer', async () => {
  const h = setup({ entries: entries3() });
  animate(h);
  h.$('more-history').click();
  await ticks();
  h.$('more-history').click();
  // The exit must not tear the expanded view down synchronously — something
  // of it (full list or expanded container state) survives until the fade
  // finishes; a hard cut violates "下滑渐隐后隐藏".
  assert(expandedState(h), 'exit tore down the expanded view synchronously — no fade-out happened');
  await ticks();
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('messages').hidden, false);
  assert(!h.$('card').classes.has('history-expanded'));
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'false');
  assert.equal(h.$('more-history').textContent, '更多历史规划');
  assert.deepEqual(residue(h), []);
});

test('a burst of rapid toggles converges to the last command with no leftover state', async () => {
  const h = setup({ entries: entries3() });
  animate(h);
  for (let i = 0; i < 4; i++) h.$('more-history').click();
  await ticks();
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('messages').hidden, false);
  assert(!h.$('card').classes.has('history-expanded'));
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'false');
  assert.equal(h.$('more-history').textContent, '更多历史规划');
  assert.deepEqual(residue(h), []);
  for (let i = 0; i < 3; i++) h.$('more-history').click();
  await ticks();
  assert.equal(historyRows(h).length, 3);
  assert.equal(h.$('messages').hidden, true);
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'true');
  assert.deepEqual(residue(h), []);
  // A fresh pair still behaves cleanly — no wedged flags or wedged listeners.
  h.$('more-history').click();
  await ticks();
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('messages').hidden, false);
  strayTransitionEnd(h);
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('messages').hidden, false);
  assert(!h.$('card').classes.has('history-expanded'));
});

test('re-expanding mid-exit cancels the exit and settles expanded', async () => {
  const h = setup({ entries: entries3() });
  animate(h);
  h.$('more-history').click();
  await ticks();
  h.$('more-history').click(); // exit begins
  h.$('more-history').click(); // cancel it mid-flight
  await ticks();
  assert.equal(historyRows(h).length, 3);
  assert.equal(h.$('messages').hidden, true);
  assert(h.$('card').classes.has('history-expanded'));
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'true');
  assert.equal(h.$('more-history').textContent, '收起历史规划');
  assert.deepEqual(residue(h), []);
});

test('collapsing mid-enter converges to fully collapsed', async () => {
  const h = setup({ entries: entries3() });
  animate(h);
  h.$('more-history').click(); // enter begins
  h.$('more-history').click(); // collapse before it settles
  await ticks();
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('messages').hidden, false);
  assert(!h.$('card').classes.has('history-expanded'));
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'false');
  assert.equal(h.$('more-history').textContent, '更多历史规划');
  assert.deepEqual(residue(h), []);
});

test('selecting a saved entry mid-exit restores it and the conversation view at once', async () => {
  const h = setup({ entries: entries3() });
  animate(h);
  h.$('more-history').click();
  await ticks();
  h.$('more-history').click();    // exit begins
  historyRows(h)[0]!.click();     // pick the newest entry mid-exit
  // Restoring a conversation abandons the exit immediately: messages visible,
  // expanded view torn down, collapsed footer rebuilt — not at timer end.
  assert.equal(h.state.sessionId, 'c');
  assert.equal(h.state.messages[0]!.text, '出游 11');
  assert.equal(h.$('messages').hidden, false);
  assert.equal(historyRows(h).length, 2);
  assert(!h.$('card').classes.has('history-expanded'));
  await ticks();
  assert.equal(h.state.sessionId, 'c');
  assert.equal(h.$('messages').hidden, false);
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'false');
  assert.deepEqual(residue(h), []);
});

test('a re-render mid-exit does not wedge the transition', async () => {
  const h = setup({ entries: entries3() });
  animate(h);
  h.state.messages.push({ role: 'user', text: '正在规划' }, { role: 'assistant', text: '安排中' });
  h.$('more-history').click();
  await ticks();
  h.$('more-history').click();              // exit begins
  h.run('window.WanderHistory.capture()');  // capture() re-renders the list mid-exit
  await ticks();
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('messages').hidden, false);
  assert(!h.$('card').classes.has('history-expanded'));
  assert.deepEqual(residue(h), []);
});

test('new chat while expanded settles collapsed', async () => {
  const h = setup({ entries: entries3() });
  animate(h);
  h.$('more-history').click();
  await ticks();
  h.$('new-chat').click(); // newChat() calls setExpanded(false) internally
  await ticks();
  assert(!h.$('card').classes.has('history-expanded'));
  assert.equal(h.$('messages').hidden, false);
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'false');
  assert.deepEqual(residue(h), []);
});

test('new chat during the collapse exit restores the conversation view at once', async () => {
  const h = setup({ entries: entries3() });
  animate(h);
  h.$('more-history').click();
  await ticks();
  h.$('more-history').click(); // exit begins
  h.$('new-chat').click();
  // A new chat abandons the exit immediately: messages visible, expanded view
  // torn down, collapsed footer rebuilt — not deferred to the exit timer.
  assert.equal(h.$('messages').hidden, false);
  assert(!h.$('card').classes.has('history-expanded'));
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'false');
  await ticks();
  assert.equal(h.$('messages').hidden, false);
  assert.equal(historyRows(h).length, 2);
  assert.deepEqual(residue(h), []);
});

test('an identity switch mid-exit tears down the old account list at once', async () => {
  const h = setup({ entries: entries3() });
  animate(h);
  h.$('more-history').click();
  await ticks();
  h.$('more-history').click();                        // exit begins
  const stale = historyRows(h)[0]!;                   // old-account row still mounted
  h.run('window.WanderHistory.setIdentity("u-new")');
  // The new identity's (empty) list replaces the old rows synchronously —
  // old-account entries must not stay visible/clickable until the timer.
  assert.equal(historyRows(h).length, 0);
  assert.equal(h.$('messages').hidden, false);
  assert(!h.$('card').classes.has('history-expanded'));
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'false');
  stale.click(); // a detached stale row must not resurrect old-account state
  assert.equal(h.state.sessionId, null);
  assert.equal(historyRows(h).length, 0);
  await ticks(); // a late exit-timer fire must not corrupt the new view
  assert.equal(historyRows(h).length, 0);
  assert.equal(h.$('messages').hidden, false);
  assert.equal(h.state.sessionId, null);
  assert.deepEqual(residue(h), []);
});

test('with reduced motion, expand and collapse settle instantly', () => {
  const h = setup({ entries: entries3() }); // media.matches stays true
  h.$('more-history').click();
  assert.equal(historyRows(h).length, 3);
  assert.equal(h.$('messages').hidden, true);
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'true');
  h.$('more-history').click();
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('messages').hidden, false);
  assert(!h.$('card').classes.has('history-expanded'));
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'false');
  assert.deepEqual(residue(h), []);
});

test('expanding inside an active conversation converges to the same end states', async () => {
  const h = setup({ api: true, entries: entries3() });
  animate(h);
  const job = h.run('window.sendMessage("想去钟楼")') as Promise<unknown>;
  assert(h.$('card').classes.has('has-conversation'));
  h.$('more-history').click();
  await ticks();
  assert.equal(historyRows(h).length, 3);
  assert.equal(h.$('messages').hidden, true);
  h.$('more-history').click();
  await ticks();
  assert.equal(historyRows(h).length, 2);
  assert.equal(h.$('messages').hidden, false);
  assert.equal(h.$('more-history').attrs.get('aria-expanded'), 'false');
  assert.deepEqual(residue(h), []);
  h.requests[0]!.finish({ kind: 'clarification', question: '哪天去？' });
  await job;
});
