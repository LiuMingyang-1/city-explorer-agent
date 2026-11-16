try {
  const { createWanderMascot, HAT_PALETTES } = await import('./wander-mascot.js');
  const mascots = [...document.querySelectorAll('boop-face')].map(face => createWanderMascot(face, { pointerFollow: face.id === 'wander-face' }));
  const captions = {
    idle: '准备好了，今天去哪儿？',
    thinking: '让我想想，怎么走更有意思…',
    searching: '拿上放大镜，找找有意思的地方。',
    validating: '再检查一下，时间和路线合不合适。',
    happy: '安排好了，出发！',
    asking: '想热闹一点，还是安静一点？',
    confused: '嗯…暂时没找到，换个条件试试？',
  };
  for (const button of document.querySelectorAll('[data-palette]')) button.addEventListener('click', () => {
    for (const mascot of mascots) mascot.setPalette(button.dataset.palette);
    document.getElementById('color-name').textContent = HAT_PALETTES[button.dataset.palette].label;
    for (const item of document.querySelectorAll('[data-palette]')) item.setAttribute('aria-pressed', String(item === button));
  });
  document.getElementById('hat-toggle').addEventListener('change', event => {
    for (const mascot of mascots) mascot.setHat(event.target.checked);
  });
  for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => {
    for (const mascot of mascots) mascot.setState(button.dataset.action);
    for (const item of document.querySelectorAll('[data-action]')) item.setAttribute('aria-pressed', String(item === button));
    document.getElementById('caption').textContent = captions[button.dataset.action];
  });
} catch (error) {
  document.getElementById('load-error').hidden = false;
  console.error('Mascot preview failed to load:', error);
}
