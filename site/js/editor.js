// Corner editor: the source photo with a draggable quad overlay and a loupe
// while dragging, plus the debounced live "scan preview" pane.

import { state, selectedPage, subscribe, emit } from './state.js';
import { cvReady } from './cv-loader.js';
import { computeOutputSize, warpToCanvas } from './warp.js';
import { applyFilter, rotateCanvas } from './filters.js';

// Finger-friendly sizes on touch devices; the loupe sits further from the
// corner so the dragging finger does not cover it.
const COARSE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const HANDLE_R = COARSE ? 13 : 10;
const HIT_R = COARSE ? 28 : 24;
const TOUCH_HIT_R = 40;
const LOUPE_R = COARSE ? 78 : 65;
const LOUPE_OFFSET = COARSE ? 130 : 90;
const PREVIEW_MAX_SIDE = 900;

// Corner dragging is relative to the grab point, scaled down so the corner
// moves slower than the finger/cursor — the finger no longer has to sit
// exactly on the target, which makes precise aiming much easier. Touch is
// slowed the most since the fingertip hides the corner.
const DRAG_GAIN_TOUCH = 0.45;
const DRAG_GAIN_MOUSE = 0.8;

let canvas, ctx, wrap, dropzone, hint, previewCanvas;
let viewScale = 1; // fullBitmap px -> CSS px
let viewW = 0;
let viewH = 0;
let drag = null; // { index, gain, startX, startY, origViewX, origViewY }
let lastPageId = null;
let previewTimer = 0;

export function initEditor() {
  canvas = document.getElementById('editor-canvas');
  ctx = canvas.getContext('2d');
  wrap = document.getElementById('editor-wrap');
  dropzone = document.getElementById('dropzone');
  hint = document.getElementById('editor-hint');
  previewCanvas = document.getElementById('preview-canvas');

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  new ResizeObserver(() => {
    fit();
    render();
  }).observe(wrap);

  subscribe(onState);
  onState();
}

function onState() {
  const page = selectedPage();
  const id = page ? page.id : null;
  dropzone.hidden = !!page;
  canvas.hidden = !page;
  hint.hidden = !page;
  if (id !== lastPageId) {
    lastPageId = id;
    drag = null;
    fit();
  }
  render();
  schedulePreview();
}

function fit() {
  const page = selectedPage();
  if (!page) return;
  // Zero when the editor pane is display:none (mobile preview mode); the
  // ResizeObserver fires again with real sizes once the pane reappears.
  if (wrap.clientWidth === 0 || wrap.clientHeight === 0) return;
  const bmp = page.fullBitmap;
  const availW = Math.max(50, wrap.clientWidth - 32);
  const availH = Math.max(50, wrap.clientHeight - 32);
  viewScale = Math.min(availW / bmp.width, availH / bmp.height);
  viewW = Math.round(bmp.width * viewScale);
  viewH = Math.round(bmp.height * viewScale);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${viewW}px`;
  canvas.style.height = `${viewH}px`;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const toView = (p) => ({ x: p.x * viewScale, y: p.y * viewScale });

function render() {
  const page = selectedPage();
  if (!page) return;
  ctx.clearRect(0, 0, viewW, viewH);
  ctx.drawImage(page.fullBitmap, 0, 0, viewW, viewH);

  const pts = page.corners.map(toView);

  // Dim everything outside the quad.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, viewW, viewH);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(10, 13, 18, 0.5)';
  ctx.fill('evenodd');
  ctx.restore();

  // Quad edges.
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Corner handles.
  for (let i = 0; i < 4; i++) {
    ctx.beginPath();
    ctx.arc(pts[i].x, pts[i].y, HANDLE_R, 0, Math.PI * 2);
    ctx.fillStyle = drag && drag.index === i ? '#4da3ff' : 'rgba(20, 26, 34, 0.85)';
    ctx.fill();
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  if (drag) drawLoupe(page, pts[drag.index], page.corners[drag.index]);
}

function drawLoupe(page, viewPt, fullPt) {
  const zoom = Math.min(3, Math.max(1.5, viewScale * 4)); // source px -> CSS px
  const cx = Math.min(Math.max(viewPt.x, LOUPE_R + 4), viewW - LOUPE_R - 4);
  let cy = viewPt.y - LOUPE_OFFSET - LOUPE_R;
  if (cy < LOUPE_R + 4) cy = Math.min(viewPt.y + LOUPE_OFFSET + LOUPE_R, viewH - LOUPE_R - 4);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, LOUPE_R, 0, Math.PI * 2);
  ctx.clip();

  // Zoomed source centered on the corner.
  const srcSize = (LOUPE_R * 2) / zoom;
  ctx.fillStyle = '#000';
  ctx.fillRect(cx - LOUPE_R, cy - LOUPE_R, LOUPE_R * 2, LOUPE_R * 2);
  ctx.drawImage(
    page.fullBitmap,
    fullPt.x - srcSize / 2, fullPt.y - srcSize / 2, srcSize, srcSize,
    cx - LOUPE_R, cy - LOUPE_R, LOUPE_R * 2, LOUPE_R * 2,
  );

  // Quad edges through the loupe.
  ctx.beginPath();
  page.corners.forEach((c, i) => {
    const lx = cx + (c.x - fullPt.x) * zoom;
    const ly = cy + (c.y - fullPt.y) * zoom;
    if (i === 0) ctx.moveTo(lx, ly);
    else ctx.lineTo(lx, ly);
  });
  ctx.closePath();
  ctx.strokeStyle = 'rgba(77, 163, 255, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Crosshair.
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy);
  ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12);
  ctx.lineTo(cx, cy + 12);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, LOUPE_R, 0, Math.PI * 2);
  ctx.strokeStyle = '#4da3ff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function onPointerDown(e) {
  const page = selectedPage();
  if (!page) return;
  const pts = page.corners.map(toView);
  let index = -1;
  let best = e.pointerType === 'touch' ? TOUCH_HIT_R : HIT_R;
  pts.forEach((p, i) => {
    const dist = Math.hypot(p.x - e.offsetX, p.y - e.offsetY);
    if (dist <= best) {
      best = dist;
      index = i;
    }
  });
  if (index < 0) return;
  // Anchor on the grab point and the corner's current position; the corner
  // does not snap under the finger, it only follows scaled-down movement.
  drag = {
    index,
    gain: e.pointerType === 'touch' ? DRAG_GAIN_TOUCH : DRAG_GAIN_MOUSE,
    startX: e.offsetX,
    startY: e.offsetY,
    origViewX: pts[index].x,
    origViewY: pts[index].y,
  };
  canvas.setPointerCapture(e.pointerId);
  render(); // highlight the handle and show the loupe immediately
}

function onPointerMove(e) {
  const page = selectedPage();
  if (!drag || !page) return;
  moveCorner(page, e);
}

function onPointerUp() {
  if (!drag) return;
  drag = null;
  render();
  emit(); // refresh thumbnail overlay
}

function moveCorner(page, e) {
  const bmp = page.fullBitmap;
  const vx = drag.origViewX + (e.offsetX - drag.startX) * drag.gain;
  const vy = drag.origViewY + (e.offsetY - drag.startY) * drag.gain;
  page.corners[drag.index] = {
    x: Math.min(Math.max(vx / viewScale, 0), bmp.width),
    y: Math.min(Math.max(vy / viewScale, 0), bmp.height),
  };
  render();
  schedulePreview();
}

export function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    renderPreview().catch((err) => console.error('preview failed', err));
  }, 100);
}

async function renderPreview() {
  const page = selectedPage();
  if (!page) {
    previewCanvas.width = previewCanvas.height = 0;
    return;
  }
  const cv = await cvReady();
  if (selectedPage() !== page) return; // selection changed while loading
  const procCorners = page.corners.map((c) => ({ x: c.x / page.scale, y: c.y / page.scale }));
  const { w, h } = computeOutputSize(procCorners, state.pageFormat, PREVIEW_MAX_SIDE);
  let out = warpToCanvas(cv, page.procCanvas, procCorners, w, h);
  out = applyFilter(cv, out, page.filter);
  out = rotateCanvas(out, page.rotation);
  previewCanvas.width = out.width;
  previewCanvas.height = out.height;
  previewCanvas.getContext('2d').drawImage(out, 0, 0);
}
