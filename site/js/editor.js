// Corner editor: the source photo with a draggable quad overlay and a loupe
// while dragging, plus the debounced live "scan preview" pane. While a page
// is being split (state.split) the corners rest and the dividing line is
// dragged instead: either end along its edge of the quad, or the whole line.

import { state, selectedPage, subscribe, emit } from './state.js';
import { cvReady } from './cv-loader.js';
import { computeOutputSize, warpToCanvas } from './warp.js';
import { applyFilter, rotateCanvas } from './filters.js';
import { overlayColors } from './icons.js';
import { splitEdges, splitLine, splitQuads, projectOnEdge } from './split.js';

// Finger-friendly sizes on touch devices; the loupe sits further from the
// corner so the dragging finger does not cover it.
const COARSE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const HANDLE_R = COARSE ? 13 : 10;
const HIT_R = COARSE ? 28 : 24;
const TOUCH_HIT_R = 40;
const LOUPE_R = COARSE ? 78 : 65;
const LOUPE_OFFSET = COARSE ? 130 : 90;
const PREVIEW_MAX_SIDE = 900;
const LINE_HIT = COARSE ? 18 : 10; // grabbing the dividing line between its handles
const PREVIEW_GAP = 0.03; // between the halves of a split preview, of the longer side

// Corner dragging is relative to the grab point, scaled down so the corner
// moves slower than the finger/cursor — the finger no longer has to sit
// exactly on the target, which makes precise aiming much easier. Touch is
// slowed the most since the fingertip hides the corner.
const DRAG_GAIN_TOUCH = 0.45;
const DRAG_GAIN_MOUSE = 0.8;

// The "drag the corners" tip is shown until the first corner drag, once per
// browser. Storage can be unavailable (private mode); then it is per visit.
const HINT_KEY = 'scanpdf-hint-seen';
let hintSeen = false;
try {
  hintSeen = localStorage.getItem(HINT_KEY) === '1';
} catch (_) { /* ignore */ }

let canvas, ctx, wrap, stage, dropzone, hint, splitHint, previewCanvas, previewWrap;
let viewScale = 1; // fullBitmap px -> CSS px
let viewW = 0;
let viewH = 0;
// A corner: { kind: 'corner', index, gain, startX, startY, origViewX, origViewY }
// The dividing line: { kind: 'split', ends, gain, startX, startY, orig }, where
// ends lists the ends being moved (0, 1 or both) and orig their view positions.
let drag = null;
let lastPageId = null;
let lastSplit = false;
let previewTimer = 0;

export function initEditor() {
  canvas = document.getElementById('editor-canvas');
  ctx = canvas.getContext('2d');
  wrap = document.getElementById('editor-wrap');
  stage = document.getElementById('stage');
  previewWrap = document.getElementById('preview-wrap');
  dropzone = document.getElementById('dropzone');
  hint = document.getElementById('editor-hint');
  splitHint = document.getElementById('split-hint');
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
  const splitting = !!state.split;
  hint.hidden = !page || hintSeen || splitting;
  splitHint.hidden = !page || !splitting;
  if (id !== lastPageId || splitting !== lastSplit) {
    const pageChanged = id !== lastPageId;
    lastPageId = id;
    lastSplit = splitting;
    endDrag();
    if (pageChanged) fit();
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
  const pad = getComputedStyle(wrap);
  const padX = parseFloat(pad.paddingLeft) + parseFloat(pad.paddingRight);
  const padY = parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom);
  const availW = Math.max(50, wrap.clientWidth - padX);
  const availH = Math.max(50, wrap.clientHeight - padY);
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

  const colors = overlayColors();
  const pts = page.corners.map(toView);

  // Dim everything outside the quad.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, viewW, viewH);
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = colors.dim;
  ctx.fill('evenodd');
  ctx.restore();

  // Quad edges.
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  if (state.split) {
    renderSplit(page, colors);
    return;
  }

  // Corner handles.
  for (let i = 0; i < 4; i++) drawHandle(pts[i], !!drag && drag.index === i, colors);

  if (drag && drag.kind === 'corner') drawLoupe(page, pts[drag.index], page.corners[drag.index]);
}

function drawHandle(p, active, colors) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2);
  ctx.fillStyle = active ? colors.accent : colors.handle;
  ctx.fill();
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

// Split mode: the dividing line and its two handles instead of the corners.
function renderSplit(page, colors) {
  const line = splitLine(page.corners, state.split);
  const ends = line.map(toView);

  // A dark casing keeps the dashes visible on white paper and on dark desks.
  ctx.beginPath();
  ctx.moveTo(ends[0].x, ends[0].y);
  ctx.lineTo(ends[1].x, ends[1].y);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.save();
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  const moving = drag && drag.kind === 'split' ? drag.ends : [];
  ends.forEach((p, i) => drawHandle(p, moving.includes(i), colors));

  // The loupe follows a single end; a whole-line drag has no one spot to show.
  if (moving.length === 1) drawLoupe(page, ends[moving[0]], line[moving[0]], line);
}

function drawLoupe(page, viewPt, fullPt, extraLine) {
  const colors = overlayColors();
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
  ctx.strokeStyle = colors.accentSoft;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // The dividing line through the loupe.
  if (extraLine) {
    ctx.beginPath();
    extraLine.forEach((c, i) => {
      const lx = cx + (c.x - fullPt.x) * zoom;
      const ly = cy + (c.y - fullPt.y) * zoom;
      if (i === 0) ctx.moveTo(lx, ly);
      else ctx.lineTo(lx, ly);
    });
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

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
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function onPointerDown(e) {
  const page = selectedPage();
  if (!page) return;
  if (state.split) {
    startSplitDrag(page, e);
    return;
  }
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
    kind: 'corner',
    index,
    gain: e.pointerType === 'touch' ? DRAG_GAIN_TOUCH : DRAG_GAIN_MOUSE,
    startX: e.offsetX,
    startY: e.offsetY,
    origViewX: pts[index].x,
    origViewY: pts[index].y,
  };
  canvas.setPointerCapture(e.pointerId);
  stage.classList.add('corner-dragging'); // the phone view switch steps aside for the loupe
  render(); // highlight the handle and show the loupe immediately
}

function onPointerMove(e) {
  const page = selectedPage();
  if (!drag || !page) return;
  if (drag.kind === 'split') moveSplit(page, e);
  else moveCorner(page, e);
}

function endDrag() {
  drag = null;
  stage.classList.remove('corner-dragging');
}

function onPointerUp() {
  if (!drag) return;
  const wasCorner = drag.kind === 'corner';
  endDrag();
  // Retire the tip only now: hiding it resizes the canvas, which must not
  // happen under a finger that is still dragging.
  if (wasCorner && !hintSeen) {
    hintSeen = true;
    hint.hidden = true;
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch (_) { /* ignore */ }
  }
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

// Either handle, or the line between them, which moves both ends at once.
function startSplitDrag(page, e) {
  const orig = splitLine(page.corners, state.split).map(toView);
  const touch = e.pointerType === 'touch';
  let ends = null;
  let best = touch ? TOUCH_HIT_R : HIT_R;
  orig.forEach((p, i) => {
    const dist = Math.hypot(p.x - e.offsetX, p.y - e.offsetY);
    if (dist <= best) {
      best = dist;
      ends = [i];
    }
  });
  if (!ends) {
    const t = projectOnSegment({ x: e.offsetX, y: e.offsetY }, orig[0], orig[1]);
    const nx = orig[0].x + (orig[1].x - orig[0].x) * t;
    const ny = orig[0].y + (orig[1].y - orig[0].y) * t;
    if (Math.hypot(nx - e.offsetX, ny - e.offsetY) > (touch ? LINE_HIT * 1.5 : LINE_HIT)) return;
    ends = [0, 1];
  }
  drag = {
    kind: 'split',
    ends,
    gain: touch ? DRAG_GAIN_TOUCH : DRAG_GAIN_MOUSE,
    startX: e.offsetX,
    startY: e.offsetY,
    orig,
  };
  canvas.setPointerCapture(e.pointerId);
  stage.classList.add('corner-dragging');
  render();
}

function projectOnSegment(pt, p0, p1) {
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  return Math.min(Math.max(((pt.x - p0.x) * dx + (pt.y - p0.y) * dy) / len2, 0), 1);
}

// Same slowed-down relative movement as a corner, then snapped onto the edge
// of the quad that this end of the line lives on.
function moveSplit(page, e) {
  const split = state.split;
  if (!split) return;
  const edges = splitEdges(page.corners, split.dir);
  const dx = (e.offsetX - drag.startX) * drag.gain;
  const dy = (e.offsetY - drag.startY) * drag.gain;
  for (const i of drag.ends) {
    const target = { x: (drag.orig[i].x + dx) / viewScale, y: (drag.orig[i].y + dy) / viewScale };
    split[i === 0 ? 'a' : 'b'] = projectOnEdge(target, edges[i][0], edges[i][1]);
  }
  render();
  schedulePreview();
}

export function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    renderPreview().catch((err) => {
      previewWrap.classList.remove('is-loading');
      console.error('preview failed', err);
    });
  }, 100);
}

async function renderPreview() {
  const page = selectedPage();
  if (!page) {
    previewCanvas.width = previewCanvas.height = 0;
    previewWrap.classList.remove('is-loading');
    return;
  }
  // Spinner until the engine (a ~10MB download) has drawn the first result.
  if (previewCanvas.width === 0) previewWrap.classList.add('is-loading');
  const cv = await cvReady();
  if (selectedPage() !== page) return; // selection changed while loading
  const procCorners = page.corners.map((c) => ({ x: c.x / page.scale, y: c.y / page.scale }));
  const split = state.split;
  previewWrap.classList.toggle('is-split', !!split);
  if (split) {
    drawSplitPreview(cv, page, splitQuads(procCorners, split, page.rotation), split.dir);
  } else {
    const out = renderQuad(cv, page, procCorners);
    previewCanvas.width = out.width;
    previewCanvas.height = out.height;
    previewCanvas.getContext('2d').drawImage(out, 0, 0);
  }
  previewWrap.classList.remove('is-loading');
}

function renderQuad(cv, page, procCorners) {
  const { w, h } = computeOutputSize(procCorners, state.pageFormat, PREVIEW_MAX_SIDE);
  let out = warpToCanvas(cv, page.procCanvas, procCorners, w, h);
  out = applyFilter(cv, out, page.filter, page.deshadow);
  return rotateCanvas(out, page.rotation);
}

// Both future pages in reading order, laid out the way they lie in the photo
// once it is rotated: side by side, or one above the other.
function drawSplitPreview(cv, page, quads, dir) {
  const [a, b] = quads.map((q) => renderQuad(cv, page, q));
  const sideBySide = (dir === 'v') === (page.rotation % 180 === 0);
  const gap = Math.round(Math.max(a.width, a.height, b.width, b.height) * PREVIEW_GAP);
  const pctx = previewCanvas.getContext('2d');
  if (sideBySide) {
    previewCanvas.width = a.width + gap + b.width;
    previewCanvas.height = Math.max(a.height, b.height);
    pctx.drawImage(a, 0, Math.round((previewCanvas.height - a.height) / 2));
    pctx.drawImage(b, a.width + gap, Math.round((previewCanvas.height - b.height) / 2));
  } else {
    previewCanvas.width = Math.max(a.width, b.width);
    previewCanvas.height = a.height + gap + b.height;
    pctx.drawImage(a, Math.round((previewCanvas.width - a.width) / 2), 0);
    pctx.drawImage(b, Math.round((previewCanvas.width - b.width) / 2), a.height + gap);
  }
}
