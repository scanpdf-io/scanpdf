// Thumbnail strip: select, reorder (▲/▼), delete, detection status badges.

import { state, subscribe, emit } from './state.js';

const THUMB_W = 164;

// On mobile the strip is horizontal, so reorder arrows point left/right.
const mqMobile = window.matchMedia('(max-width: 767px)');

let list;

export function initPagesUI() {
  list = document.getElementById('pages-list');
  mqMobile.addEventListener('change', render);
  subscribe(render);
  render();
}

function render() {
  list.textContent = '';
  state.pages.forEach((page, i) => {
    list.appendChild(buildItem(page, i));
  });
}

function buildItem(page, i) {
  const item = document.createElement('div');
  item.className = 'page-item' + (page.id === state.selectedId ? ' selected' : '');
  item.addEventListener('click', () => {
    state.selectedId = page.id;
    emit();
  });

  const thumb = document.createElement('canvas');
  thumb.className = 'thumb';
  const s = THUMB_W / page.procCanvas.width;
  thumb.width = THUMB_W;
  thumb.height = Math.max(1, Math.round(page.procCanvas.height * s));
  const tctx = thumb.getContext('2d');
  tctx.drawImage(page.procCanvas, 0, 0, thumb.width, thumb.height);
  if (!page.detecting) {
    const pts = page.corners.map((c) => ({
      x: (c.x / page.scale) * s,
      y: (c.y / page.scale) * s,
    }));
    tctx.beginPath();
    pts.forEach((p, j) => (j === 0 ? tctx.moveTo(p.x, p.y) : tctx.lineTo(p.x, p.y)));
    tctx.closePath();
    tctx.strokeStyle = page.detectOk ? 'rgba(77, 163, 255, 0.95)' : 'rgba(255, 170, 60, 0.95)';
    tctx.lineWidth = 2;
    tctx.stroke();
  }
  item.appendChild(thumb);

  const meta = document.createElement('div');
  meta.className = 'page-meta';
  const num = document.createElement('span');
  num.className = 'page-num';
  num.textContent = String(i + 1);
  meta.appendChild(num);
  if (page.detecting) {
    const spin = document.createElement('span');
    spin.className = 'spinner';
    spin.title = 'Detecting corners…';
    meta.appendChild(spin);
  } else if (!page.detectOk) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'adjust corners';
    badge.title = 'Automatic detection failed — drag the corners manually';
    meta.appendChild(badge);
  }
  const name = document.createElement('span');
  name.className = 'page-name';
  name.textContent = page.name;
  meta.appendChild(name);
  item.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'page-actions';
  const horiz = mqMobile.matches;
  actions.appendChild(actionBtn(horiz ? '◀' : '▲', horiz ? 'Move left' : 'Move up', i === 0, () => move(i, -1)));
  actions.appendChild(actionBtn(horiz ? '▶' : '▼', horiz ? 'Move right' : 'Move down', i === state.pages.length - 1, () => move(i, 1)));
  const del = actionBtn('✕', 'Delete page', false, () => remove(i));
  del.classList.add('del');
  actions.appendChild(del);
  item.appendChild(actions);

  return item;
}

function actionBtn(label, title, disabled, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.disabled = disabled;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.pages.length) return;
  const tmp = state.pages[i];
  state.pages[i] = state.pages[j];
  state.pages[j] = tmp;
  emit();
}

function remove(i) {
  const [page] = state.pages.splice(i, 1);
  if (page.fullBitmap && page.fullBitmap.close) page.fullBitmap.close();
  if (state.selectedId === page.id) {
    const next = state.pages[Math.min(i, state.pages.length - 1)];
    state.selectedId = next ? next.id : null;
  }
  emit();
}
