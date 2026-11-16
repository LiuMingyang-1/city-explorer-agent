// Shared rhythms keep state changes continuous; profiles change the character
// of the movement, never the business state or its duration.
export const MOTION_PROFILES = Object.freeze({
  idle: { x: 2.4, y: .7, turn: 1.6, tilt: 0, drop: 0, bounce: 0 },
  thinking: { x: 2.8, y: 1, turn: 1.8, tilt: 0, drop: 0, bounce: .3 },
  searching: { x: 2.2, y: .6, turn: 1.2, tilt: 0, drop: 0, bounce: 0 },
  validating: { x: 1.8, y: .6, turn: 1.1, tilt: 0, drop: 0, bounce: .2 },
  happy: { x: 3.2, y: .8, turn: 2.4, tilt: 0, drop: 0, bounce: 1.7 },
  asking: { x: 2.1, y: .7, turn: 2, tilt: -5.5, drop: 0, bounce: .2 },
  confused: { x: 2, y: .7, turn: 1.4, tilt: 1.8, drop: 2, bounce: 0 },
});

export function sampleMascotMotion(profile, elapsed, reduced = false) {
  if (reduced) return { x: 0, y: 0, rotation: profile.tilt };
  const phase = elapsed / 820;
  return {
    x: Math.sin(phase) * profile.x,
    y: profile.drop + Math.sin(phase * 2 + .5) * profile.y - (1 - Math.cos(phase * 2)) * profile.bounce,
    rotation: profile.tilt + Math.sin(phase + .35) * profile.turn,
  };
}

// Upstream locks blinking along with a held expression. Keep its blink renderer
// and reduced-motion handling, while allowing natural blinks in every pose.
export function createMascotBlinkUpdater(baseUpdate, reduced, random = Math.random) {
  let followUp = false;
  return function updateMascotBlink(now) {
    const wasBlinking = Boolean(this._blinkAnim);
    const expressionLock = this._expressionLock;
    try {
      this._expressionLock = false;
      baseUpdate.call(this, now);
    } finally {
      this._expressionLock = expressionLock;
    }
    if (reduced()) {
      followUp = false;
    } else if (wasBlinking && !this._blinkAnim) {
      // At most two blinks in a cluster, followed by a normal resting interval.
      const doubleBlink = !followUp && random() < .18;
      this._nextBlinkAt = now + (doubleBlink ? 160 + random() * 70 : 2200 + random() * 1800);
      followUp = doubleBlink;
    }
  };
}
