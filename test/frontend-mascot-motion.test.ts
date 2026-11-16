import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/wander-mascot-motion.js', import.meta.url), 'utf8');
const context = vm.createContext({ Math });
vm.runInContext(source.replace(/^export /gm, '') + '\nglobalThis.motion = { MOTION_PROFILES, sampleMascotMotion, createMascotBlinkUpdater };', context);
const { MOTION_PROFILES, sampleMascotMotion, createMascotBlinkUpdater } = context.motion;

test('all seven held expressions retain gentle continuous motion and respect reduced motion', () => {
  assert.equal(Object.keys(MOTION_PROFILES).length, 7);
  for (const profile of Object.values(MOTION_PROFILES)) {
    const frames = Array.from({ length: 156 }, (_, index) => sampleMascotMotion(profile, index * 33));
    const xs = frames.map(frame => frame.x);
    assert(Math.max(...xs) - Math.min(...xs) > 3, 'every state visibly sways');
    assert(frames.every(frame => Math.abs(frame.x) <= 3.21 && Math.abs(frame.y) <= 4.21 && Math.abs(frame.rotation) <= 7.6));
    assert(frames.slice(1).every((frame, index) => Math.abs(frame.x - frames[index].x) < .14 && Math.abs(frame.rotation - frames[index].rotation) < .11));
    assert.deepEqual(sampleMascotMotion(profile, 0, true), sampleMascotMotion(profile, 4000, true));
  }
});

test('held expressions still blink, double blinks stop at two, and expression locks are restored', () => {
  let reduced = false;
  const renderBlink = function(this: { _blinkAnim: object | null; _blink: number; _expressionLock: boolean; _nextBlinkAt: number }, now: number) {
    if (reduced) { this._blinkAnim = null; this._blink = 1; return; }
    assert.equal(this._expressionLock, false);
    if (this._blinkAnim) { this._blinkAnim = null; this._blink = 1; }
    else if (now >= this._nextBlinkAt) this._blinkAnim = { start: now };
  };
  for (const state of Object.keys(MOTION_PROFILES)) {
    const face = { _expressionLock: state !== 'idle', _blinkAnim: null as object | null, _nextBlinkAt: 100, _blink: 1 };
    const update = createMascotBlinkUpdater(renderBlink, () => reduced, () => 0);
    update.call(face, 100);
    assert(face._blinkAnim, `${state} must blink even while holding its pose`);
    assert.equal(face._expressionLock, state !== 'idle');
    update.call(face, 280);
    assert.equal(face._nextBlinkAt, 440);
    update.call(face, 440);
    update.call(face, 620);
    assert.equal(face._nextBlinkAt, 2820, 'normal resting interval after the second blink');
    reduced = true;
    update.call(face, 3000);
    assert.equal(face._blinkAnim, null);
    reduced = false;
  }
  const face = { _expressionLock: true };
  assert.throws(() => createMascotBlinkUpdater(() => { throw Error('renderer failed'); }, () => false).call(face, 0));
  assert.equal(face._expressionLock, true);
});
