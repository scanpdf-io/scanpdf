// Page thumbnails: select, delete, detection status, and reordering (drag in
// reorder.js, Alt+arrows here).

import { state, subscribe, emit, indexOfPage, movePage, removePage } from './state.js';
import { t } from './i18n.js';
import { icon, overlayColors } from './icons.js';
import { announce } from './toast.js';
import { initReorder, isReordering } from './reorder.js';

const THUMB_W = 164;

let list;
let dirty = false; // state changed while a drag was in progress
let lastSelectedId = null;

export function initPagesUI() {
  list = document.getElementById('pages-list');
  list.addEventListener('keydown', onKeyDown);
  initReorder(list, () => {
    if (dirty) render();
  });
  subscribe(render);
  render();
}

function render() {
  // Rebuilding the list would destroy the element being dragged (corner
  // detection finishing mid-drag emits too), so wait for the drop.
  if (isReordering()) {
    dirty = true;
    return;
  }
  dirty = false;

  const active = document.activeElement;
  const hadFocus = !!active && list.contains(active);
  const focusedId = hadFocus ? active.closest('.page-item')?.dataset.id ?? null : null;
  const scrollLeft = list.scrollLeft;
  const scrollTop = list.scrollTop;

  list.textContent = '';
  state.pages.forEach((page, i) => {
    list.appendChild(buildItem(page, i));
  });
  list.scrollLeft = scrollLeft;
  list.scrollTop = scrollTop;

  // Keep keyboard focus on the same page (or, if it was deleted, the selection).
  if (hadFocus) {
    const id = indexOfPage(focusedId) >= 0 ? focusedId : state.selectedId;
    const btn = id && itemFor(id)?.querySelector('.page-select');
    if (btn) btn.focus({ preventScroll: true });
  }
  if (state.selectedId !== lastSelectedId) {
    lastSelectedId = state.selectedId;
    itemFor(state.selectedId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function itemFor(id) {
  return Array.from(list.children).find((el) => el.dataset.id === id) || null;
}

function buildItem(page, i) {
  const selected = page.id === state.selectedId;
  const item = document.createElement('div');
  item.className = 'page-item' + (selected ? ' selected' : '');
  item.dataset.id = page.id;

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'page-select';
  select.title = page.name;
  select.setAttribute('aria-label', t('pageLabel', { i: i + 1, n: state.pages.length }));
  select.setAttribute('aria-pressed', String(selected));
  select.addEventListener('click', () => {
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
    const colors = overlayColors();
    const pts = page.corners.map((c) => ({
      x: (c.x / page.scale) * s,
      y: (c.y / page.scale) * s,
    }));
    const quad = () => {
      pts.forEach((p, j) => (j === 0 ? tctx.moveTo(p.x, p.y) : tctx.lineTo(p.x, p.y)));
      tctx.closePath();
    };
    // Dim what is left out, as the editor does: duplicates and the halves of
    // a split page show the same photo and differ only in their quad.
    tctx.beginPath();
    tctx.rect(0, 0, thumb.width, thumb.height);
    quad();
    tctx.fillStyle = colors.dim;
    tctx.fill('evenodd');
    tctx.beginPath();
    quad();
    tctx.strokeStyle = page.detectOk ? colors.accentSoft : colors.warn;
    tctx.lineWidth = 2;
    tctx.stroke();
  }
  select.appendChild(thumb);
  item.appendChild(select);

  const meta = document.createElement('div');
  meta.className = 'page-meta';
  const num = document.createElement('span');
  num.className = 'page-num';
  num.textContent = String(i + 1);
  meta.appendChild(num);
  if (page.detecting) {
    const spin = document.createElement('span');
    spin.className = 'spinner';
    spin.title = t('detecting');
    meta.appendChild(spin);
  } else if (!page.detectOk) {
    const flag = document.createElement('span');
    flag.className = 'page-flag';
    flag.title = t('adjustCornersTitle');
    flag.setAttribute('role', 'img');
    flag.setAttribute('aria-label', t('adjustCorners'));
    flag.appendChild(icon('alert'));
    meta.appendChild(flag);
  }
  item.appendChild(meta);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'page-del';
  del.title = t('deletePage');
  del.setAttribute('aria-label', t('deletePage'));
  del.appendChild(icon('x'));
  del.addEventListener('click', () => removePage(page.id));
  item.appendChild(del);

  return item;
}

// On a focused thumbnail: arrows walk the pages, Alt+arrows move the page,
// Delete removes it. Both arrow axes work, whichever way the list is laid out.
function onKeyDown(e) {
  const item = e.target.closest('.page-select') && e.target.closest('.page-item');
  if (!item) return;
  const i = indexOfPage(item.dataset.id);
  if (i < 0) return;

  const dir = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
  if (dir) {
    e.preventDefault();
    const j = i + dir;
    if (j < 0 || j >= state.pages.length) return;
    if (e.altKey) {
      if (movePage(i, j)) announce(t('pageMoved', { i: j + 1, n: state.pages.length }));
    } else {
      state.selectedId = state.pages[j].id;
      emit();
      itemFor(state.selectedId)?.querySelector('.page-select').focus();
    }
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removePage(item.dataset.id);
  }
}
