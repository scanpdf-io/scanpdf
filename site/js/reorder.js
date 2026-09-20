// Drag a thumbnail to reorder pages. Pointer Events, so one code path serves
// mouse, pen and touch. Nothing in the DOM moves during the drag: the dragged
// item follows the pointer with a transform and its neighbours slide out of
// the way with transforms too; the real reorder happens once, on drop.
//
// Mouse: the drag starts after a few pixels of movement. Touch: after a
// long-press, so that a plain swipe still scrolls the strip.

import { movePage } from './state.js';
import { t } from './i18n.js';
import { announce } from './toast.js';

const MOUSE_SLOP = 4;
const TOUCH_SLOP = 8;
const LONG_PRESS_MS = 350;
const EDGE = 40; // auto-scroll zone at both ends of the list, px
const MAX_SCROLL_STEP = 14;

// The rail is vertical on desktop and a horizontal strip on phones (app.css).
const mqStrip = window.matchMedia('(max-width: 767px)');

let list;
let onIdle = () => {};
let drag = null;
let suppressClick = false;
let lastPointerType = '';

export const isReordering = () => !!(drag && drag.active);

/** onDone runs whenever a drag ends, so the owner can do a deferred render. */
export function initReorder(listEl, onDone) {
  list = listEl;
  onIdle = onDone;

  list.addEventListener('pointerdown', onPointerDown);
  // Registered up front and non-passive: once a drag is live, the first
  // touchmove has to be cancelled or the browser starts panning the strip.
  list.addEventListener('touchmove', (e) => {
    if (isReordering()) e.preventDefault();
  }, { passive: false });
  // A drag must not end in "select this page".
  list.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  // Long-press opens the context menu on Android.
  list.addEventListener('contextmenu', (e) => {
    if (lastPointerType !== 'mouse') e.preventDefault();
  });
}

function onPointerDown(e) {
  lastPointerType = e.pointerType;
  const el = e.target.closest('.page-select') && e.target.closest('.page-item');
  if (!el || drag || !e.isPrimary || e.button !== 0 || list.children.length < 2) return;

  drag = {
    el,
    pointerId: e.pointerId,
    touch: e.pointerType !== 'mouse',
    x0: e.clientX,
    y0: e.clientY,
    x: e.clientX,
    y: e.clientY,
    active: false,
    timer: 0,
    raf: 0,
  };
  if (drag.touch) drag.timer = setTimeout(pickUp, LONG_PRESS_MS);

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onCancel);
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (drag.active) {
    update();
    return;
  }
  const moved = Math.hypot(drag.x - drag.x0, drag.y - drag.y0);
  if (drag.touch) {
    // Moved before the long-press fired: it is a scroll, not a drag.
    if (moved > TOUCH_SLOP) finish(false);
  } else if (moved > MOUSE_SLOP) {
    pickUp();
    update();
  }
}

function pickUp() {
  if (!drag || drag.active) return;
  const d = drag;
  d.active = true;
  d.items = Array.from(list.children);
  d.from = d.items.indexOf(d.el);
  d.to = d.from;
  d.axis = mqStrip.matches ? 'x' : 'y';
  const horiz = d.axis === 'x';
  d.start = horiz ? d.x0 : d.y0;
  d.startScroll = horiz ? list.scrollLeft : list.scrollTop;
  const rects = d.items.map((item) => item.getBoundingClientRect());
  d.lo = rects.map((r) => (horiz ? r.left : r.top));
  d.hi = rects.map((r) => (horiz ? r.right : r.bottom));
  d.mid = rects.map((r, k) => (d.lo[k] + d.hi[k]) / 2);
  const gap = parseFloat(getComputedStyle(list).gap) || 0;
  // Item sizes differ (photo aspect ratios): the others shift by the size of
  // the one being dragged.
  d.size = d.hi[d.from] - d.lo[d.from] + gap;

  suppressClick = true;
  d.el.classList.add('dragging');
  list.classList.add('reordering');
  try {
    d.el.setPointerCapture(d.pointerId);
  } catch (_) { /* pointer already gone */ }
  if (d.touch && navigator.vibrate) navigator.vibrate(8);
  d.raf = requestAnimationFrame(autoScroll);
}

function update() {
  const d = drag;
  const horiz = d.axis === 'x';
  const scroll = (horiz ? list.scrollLeft : list.scrollTop) - d.startScroll;
  const last = d.items.length - 1;
  let delta = (horiz ? d.x : d.y) - d.start + scroll;
  delta = Math.min(Math.max(delta, d.lo[0] - d.lo[d.from]), d.hi[last] - d.hi[d.from]);

  // A neighbour is passed once the leading edge of the dragged item crosses
  // its middle. (Comparing centres would make a short item at the end of the
  // list unreachable for a tall one.)
  const lead = delta > 0 ? d.hi[d.from] + delta : d.lo[d.from] + delta;
  let to = d.from;
  if (delta > 0) {
    for (let k = d.from + 1; k <= last && lead > d.mid[k]; k++) to = k;
  } else {
    for (let k = d.from - 1; k >= 0 && lead < d.mid[k]; k--) to = k;
  }
  d.to = to;

  d.items.forEach((item, k) => {
    let shift = 0;
    if (k === d.from) shift = delta;
    else if (k >= to && k < d.from) shift = d.size;
    else if (k > d.from && k <= to) shift = -d.size;
    item.style.transform = shift ? `translate${horiz ? 'X' : 'Y'}(${shift}px)` : '';
  });
}

function autoScroll() {
  if (!isReordering()) return;
  const d = drag;
  const horiz = d.axis === 'x';
  const box = list.getBoundingClientRect();
  const pos = horiz ? d.x : d.y;
  const start = horiz ? box.left : box.top;
  const end = horiz ? box.right : box.bottom;
  let step = 0;
  if (pos < start + EDGE) step = -Math.min(MAX_SCROLL_STEP, (start + EDGE - pos) / 3);
  else if (pos > end - EDGE) step = Math.min(MAX_SCROLL_STEP, (pos - (end - EDGE)) / 3);
  if (step) {
    if (horiz) list.scrollLeft += step;
    else list.scrollTop += step;
    update();
  }
  d.raf = requestAnimationFrame(autoScroll);
}

function onPointerUp(e) {
  if (drag && e.pointerId === drag.pointerId) finish(true);
}

function onCancel(e) {
  if (drag && (e.type === 'blur' || e.pointerId === drag.pointerId)) finish(false);
}

function onKeyDown(e) {
  if (e.key !== 'Escape' || !isReordering()) return;
  e.preventDefault();
  e.stopPropagation();
  finish(false);
}

function finish(commit) {
  const d = drag;
  if (!d) return;
  drag = null;
  clearTimeout(d.timer);
  cancelAnimationFrame(d.raf);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointercancel', onCancel);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('blur', onCancel);
  if (!d.active) return; // never became a drag: the click goes through

  for (const item of d.items) item.style.transform = '';
  d.el.classList.remove('dragging');
  list.classList.remove('reordering');
  try {
    d.el.releasePointerCapture(d.pointerId);
  } catch (_) { /* already released */ }
  // iOS sends no click after a long-press, so the flag must not linger.
  setTimeout(() => (suppressClick = false), 0);

  if (commit && movePage(d.from, d.to)) {
    announce(t('pageMoved', { i: d.to + 1, n: d.items.length }));
  } else {
    onIdle();
  }
}
