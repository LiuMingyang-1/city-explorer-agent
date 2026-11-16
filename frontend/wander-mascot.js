import './assets/vendor/boopface/boopface-lite.js';
import { registerAvatarExtension } from './assets/vendor/boopface/src/boopface-extension-host.js';
import { MOTION_PROFILES, sampleMascotMotion, createMascotBlinkUpdater } from './wander-mascot-motion.js';

export const MASCOT_STATES = Object.freeze(['idle', 'thinking', 'searching', 'validating', 'happy', 'asking', 'confused']);
export const HAT_PALETTES = Object.freeze({
  moss: { crown: '#82916f', band: '#657653', brim: '#748560', seam: '#b6c29b', label: '苔绿 / MOSS' },
  sand: { crown: '#cfb88c', band: '#b49a6d', brim: '#c3a777', seam: '#ead9b5', label: '沙色 / SAND' },
  clay: { crown: '#ba8e77', band: '#986d58', brim: '#ab7c64', seam: '#e3baa0', label: '陶土 / CLAY' },
});
const controllers = new WeakMap();
const namespace = 'http://www.w3.org/2000/svg';
const smooth = t => 1 - Math.pow(1 - t, 3);

// Hooks run on BoopFace's existing frame loop; no second animation loop.
registerAvatarExtension({
  name: 'wander-accessories',
  draw(now) { controllers.get(this)?.draw(now); },
});

export function createWanderMascot(face, { palette = 'moss', pointerFollow = false } = {}) {
  if (controllers.has(face)) return controllers.get(face).api;
  if (!HAT_PALETTES[palette]) throw new Error(`Unknown hat palette: ${palette}`);
  face.setHeadRoundness(100);
  face.setPointerFollow(pointerFollow);
  // Attach to the same motion group as the head, so actions carry the hat.
  // This adapter depends on the pinned upstream SVG structure in SOURCE.md.
  const root = face.shadowRoot;
  const antennaStyle = document.createElement('style');
  antennaStyle.textContent = '#antennaDot{display:none!important}';
  root.append(antennaStyle);
  const hat = document.createElementNS(namespace, 'g');
  hat.id = 'wander-hat';
  hat.setAttribute('pointer-events', 'none');
  const hatTransform = 'translate(0 6) rotate(-3 120 70)';
  const brimPath = 'M55 54Q34 65 22 79Q15 87 35 91Q120 106 207 91Q226 87 218 79L185 54Q122 74 55 54Z';
  hat.setAttribute('transform', hatTransform);
  hat.innerHTML = `
    <path data-tone="crown" d="M55 57 69 20Q120 4 171 20L185 57Q122 76 55 57Z"/>
    <path data-tone="band" d="M59 44Q121 60 181 44L185 57Q121 77 55 57Z"/>
    <path data-tone="brim" d="${brimPath}"/>
    <path data-tone="seam" d="M32 83Q120 100 208 83M73 24 63 45M167 24 177 45" fill="none" stroke-width="1.2" stroke-dasharray="2 3" opacity=".7"/>
    <g transform="translate(111 25)"><rect width="19" height="17" rx="3" fill="#f5f0d9"/><path d="m4 12 4-7 3 5 4-5" fill="none" stroke="#637650" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="15" cy="5" r="1.5" fill="#637650"/></g>`;
  // Mask the whole face, including moving eyes and their eyelid shapes.
  // A scalp-only clip leaves those shapes free to emerge above the brim.
  // Share the brim geometry and transform so its occlusion cannot drift.
  const faceMask = document.createElementNS(namespace, 'mask');
  faceMask.id = 'wander-hat-mask';
  faceMask.setAttribute('maskUnits', 'userSpaceOnUse');
  for (const [key, value] of Object.entries({ x: -80, y: -80, width: 400, height: 400 })) faceMask.setAttribute(key, value);
  faceMask.style.maskType = 'luminance';
  faceMask.innerHTML = `<rect x="-40" y="78" width="320" height="240" fill="white"/>
    <path d="${brimPath}" transform="${hatTransform}" fill="black"/>`;
  root.querySelector('defs').append(faceMask);
  const faceLayer = document.createElementNS(namespace, 'g');
  faceLayer.id = 'wander-face-layer';
  faceLayer.setAttribute('mask', 'url(#wander-hat-mask)');
  const head = root.getElementById('head');
  const eyes = head.nextElementSibling;
  const motion = root.getElementById('headMotion');
  motion.insertBefore(faceLayer, head);
  faceLayer.append(head, eyes);
  motion.append(hat);
  root.querySelector('svg').setAttribute('aria-label', '戴渔夫帽的漫游小伙伴');
  const poseLayer = document.createElementNS(namespace, 'g');
  poseLayer.id = 'wander-pose';
  motion.insertBefore(poseLayer, faceLayer);
  poseLayer.append(faceLayer, hat);
  const lensClip = document.createElementNS(namespace, 'clipPath');
  lensClip.id = 'wander-lens-clip';
  lensClip.innerHTML = '<circle r="32"/>';
  root.querySelector('defs').append(lensClip);
  const magnifier = document.createElementNS(namespace, 'g');
  magnifier.id = 'wander-magnifier';
  magnifier.setAttribute('pointer-events', 'none');
  magnifier.setAttribute('display', 'none');
  magnifier.innerHTML = `
    <path d="M-24 26 -45 53" stroke="#26382d" stroke-width="13" stroke-linecap="round"/>
    <path d="M-24 26 -45 53" stroke="#c8ad7b" stroke-width="8" stroke-linecap="round"/>
    <circle cx="-43" cy="52" r="10" fill="#f4eed8" stroke="#26382d" stroke-width="2"/>
    <g clip-path="url(#wander-lens-clip)">
      <circle r="33" fill="#26382d"/>
      <g transform="scale(1.2)"><use href="#leftBase"/><use href="#leftTop"/><use href="#leftBottom"/></g>
      <circle r="32" fill="#bcdacf" fill-opacity=".12"/>
    </g>
    <circle r="35" fill="none" stroke="#26382d" stroke-width="7"/>
    <circle r="35" fill="none" stroke="#d5bb86" stroke-width="4"/>
    <path d="M-21-16Q-15-25-5-26" fill="none" stroke="#fff" stroke-opacity=".65" stroke-width="3" stroke-linecap="round"/>`;
  poseLayer.append(magnifier);

  let state = 'idle';
  let searchAmount = 0;
  let searchTarget = 0;
  let searchFrom = 0;
  let transitionStart = 0;
  const motionStart = performance.now();
  let stateStart = motionStart;
  let motionProfile = { ...MOTION_PROFILES.idle };
  let motionFrom = { ...motionProfile };
  let hatVisible = true;
  const reduced = () => face.getAttribute('motion') === 'reduce' || (face.getAttribute('motion') !== 'full' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  face._updateBlink = createMascotBlinkUpdater(face._updateBlink, reduced);
  face._nextBlinkAt = motionStart + 1000 + Math.random() * 800;
  function applyLabel() {
    const labels = { idle: '待机', thinking: '专注思考', searching: '举着放大镜寻找', validating: '检查方案', happy: '开心', asking: '询问', confused: '困惑' };
    root.querySelector('svg').setAttribute('aria-label', `${hatVisible ? '戴渔夫帽的' : ''}漫游小伙伴：${labels[state]}`);
  }
  const api = {
    get state() { return state; },
    setPalette(name) {
      if (!HAT_PALETTES[name]) throw new Error(`Unknown hat palette: ${name}`);
      for (const part of hat.querySelectorAll('[data-tone]')) part.setAttribute(part.dataset.tone === 'seam' ? 'stroke' : 'fill', HAT_PALETTES[name][part.dataset.tone]);
    },
    setHat(visible) {
      hatVisible = Boolean(visible);
      hat.setAttribute('display', hatVisible ? 'inline' : 'none');
      if (hatVisible) faceLayer.setAttribute('mask', 'url(#wander-hat-mask)');
      else faceLayer.removeAttribute('mask');
      applyLabel();
    },
    setState(next) {
      if (!MASCOT_STATES.includes(next)) throw new Error(`Unknown mascot state: ${next}`);
      if (next === state) return;
      const now = performance.now();
      searchFrom = searchAmount;
      searchTarget = next === 'searching' ? 1 : 0;
      transitionStart = now;
      stateStart = now;
      motionFrom = { ...motionProfile };
      state = next;
      // Reset invalidates any pending upstream action before entering a held pose.
      face.reset();
      face.setPointerFollow(pointerFollow && next === 'idle');
      const duration = reduced() ? 0 : 240;
      const pose = { happy: 'happy', confused: 'sad' }[next] || 'idle';
      face.setState(pose, { duration });
      if (next !== 'idle') face._expressionLock = true;
      if (next === 'validating') face._startMorph({ ...face._toPose, topY: -8, bottomY: 19 }, duration, smooth);
      applyLabel();
      face.dispatchEvent(new CustomEvent('wander-mascot-state', { detail: { state: next } }));
    },
  };
  const controller = {
    api,
    draw(now) {
      const reduce = reduced();
      const elapsed = now - stateStart;
      const blend = reduce ? 1 : smooth(Math.min(1, Math.max(0, elapsed / 280)));
      for (const key of Object.keys(motionProfile)) {
        motionProfile[key] = motionFrom[key] + (MOTION_PROFILES[state][key] - motionFrom[key]) * blend;
      }
      const body = sampleMascotMotion(motionProfile, now - motionStart, reduce);
      // Face, hat, hand and lens move together, preserving their occlusion.
      poseLayer.setAttribute('transform', `translate(${body.x.toFixed(3)} ${body.y.toFixed(3)}) rotate(${body.rotation.toFixed(3)} 120 120)`);
      // State is controlled externally; time only animates the current state.
      if (state === 'searching') {
        const scan = reduce ? 0 : Math.sin(elapsed / 850) * 7;
        for (const [eye, x] of [[face._leftEye, 86], [face._rightEye, 154]]) eye.setAttribute('transform', `translate(${x + scan} 130)`);
      } else if (state === 'thinking' && !reduce) {
        const offset = Math.sin(elapsed / 650) * 3;
        face._leftEye.setAttribute('transform', `translate(86 ${126 + offset})`);
        face._rightEye.setAttribute('transform', `translate(154 ${126 - offset})`);
      } else if (state === 'asking') {
        face._leftEye.setAttribute('transform', 'translate(86 122)');
        face._rightEye.setAttribute('transform', 'translate(154 130)');
      } else if (state === 'validating') {
        const scan = reduce ? 0 : Math.sin((now - motionStart) / 1050) * 4;
        face._leftEye.setAttribute('transform', `translate(${86 + scan} 128)`);
        face._rightEye.setAttribute('transform', `translate(${154 + scan} 128)`);
      } else if (state === 'confused') {
        const glance = reduce ? 0 : Math.sin((now - motionStart) / 1250) * 2;
        face._leftEye.setAttribute('transform', `translate(${86 + glance} 130)`);
        face._rightEye.setAttribute('transform', `translate(${154 + glance} 130)`);
      }
      const progress = reduce ? 1 : Math.min(1, Math.max(0, (now - transitionStart) / 240));
      searchAmount = searchFrom + (searchTarget - searchFrom) * smooth(progress);
      magnifier.setAttribute('display', searchAmount > 0.001 ? 'inline' : 'none');
      if (searchAmount > 0.001) {
        const scan = state === 'searching' && !reduce ? Math.sin(elapsed / 850) * 7 : 0;
        magnifier.setAttribute('transform', `translate(${86 + scan - (1-searchAmount)*30} ${130 + (1-searchAmount)*65}) rotate(${(1-searchAmount)*-22})`);
        magnifier.setAttribute('opacity', searchAmount);
      }
    },
  };
  controllers.set(face, controller);
  api.setPalette(palette);
  applyLabel();
  return api;
}
