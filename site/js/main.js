// Bootstrap: file intake (picker + drag&drop + share target), EXIF-corrected
// decoding, downscaling, the sequential detection queue, and toolbar wiring.

import {
  state, subscribe, emit, getPage, selectedPage, indexOfPage, movePage, removePage,
  duplicatePage, enterSplit, setSplitDir, cancelSplit, applySplit,
} from './state.js';
import { cvReady } from './cv-loader.js';
import { detectCorners, fallbackCorners } from './detect.js';
import { initEditor, schedulePreview } from './editor.js';
import { initPagesUI } from './pages-ui.js';
import { isReordering } from './reorder.js';
import { exportPdf } from './export.js';
import { t } from './i18n.js';
import { formatBytes } from './format.js';
import { toast, announce } from './toast.js';
import { takeSharedFiles } from './share-target.js';

const MAX_FULL_SIDE = 3500;
const MAX_PROC_SIDE = 1000;
const PAGE_FORMAT_KEY = 'scanpdf-page-format';
const TARGET_SIZE_KEY = 'scanpdf-target-size';
const DESHADOW_KEY = 'scanpdf-deshadow';

const $ = (id) => document.getElementById(id);

const fileInput = $('file-input');
const cameraInput = $('camera-input');
const saveBtn = $('save-btn');
const toolbar = $('page-toolbar');
const splitBar = $('split-toolbar');
const splitDirInputs = Array.from(document.querySelectorAll('input[name="split-dir"]'));
const filterInputs = Array.from(document.querySelectorAll('input[name="filter"]'));
const deshadowBtn = $('deshadow-btn');
const exportOverlay = $('export-overlay');
const exportStatus = $('export-status');
const exportBar = $('export-bar');

// The landing (hero) and the workspace (rail) each have their own pair.
const ADD_BUTTONS = ['add-btn', 'hero-add-btn'];
const CAMERA_BUTTONS = ['camera-btn', 'hero-camera-btn'];

let layoutEl, viewToggle, viewEditorBtn, viewPreviewBtn;
// What new pages start with: the last position of the lighting switch.
let deshadowDefault = false;

init();

function init() {
  // First subscriber on purpose: the workspace layout has to be in place
  // before the editor measures its container for the first page.
  subscribe(syncEmptyState);
  initEditor();
  initPagesUI();
  setupEngineWarmUp();

  for (const id of ADD_BUTTONS) $(id).addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });
  for (const id of CAMERA_BUTTONS) $(id).addEventListener('click', () => cameraInput.click());
  cameraInput.addEventListener('change', () => {
    addFiles(cameraInput.files);
    cameraInput.value = '';
  });

  setupDragAndDrop();
  setupToolbar();
  setupViewToggle();
  subscribe(syncControls);
  syncControls();
  setupOfflineEngine();
  consumeShare();
}

/* ---------- Engine warm-up ---------- */

// The OpenCV build is ~10MB, so it is not fetched on page load: visitors who
// arrive from search and only read would pay for it without ever scanning.
// The first sign of intent starts it instead. Hovering a button or dragging a
// file over the window happens seconds before a file is actually chosen, so
// the download still overlaps the file picker and nothing feels slower.
let warmUpStarted = false;

function warmUp() {
  if (warmUpStarted) return;
  warmUpStarted = true;
  const status = toast(t('engineLoading'), { type: 'busy' });
  cvReady().then(
    () => {
      status.close();
      // A first visit loads the engine before the service worker controls
      // the page, so that download went past its cache.
      requestEngineCache();
    },
    (err) => {
      status.update(t('engineFailed'), { type: 'error' });
      console.error(err);
    },
  );
}

function setupEngineWarmUp() {
  for (const id of [...ADD_BUTTONS, ...CAMERA_BUTTONS]) {
    const el = $(id);
    el.addEventListener('pointerenter', warmUp, { once: true });
    el.addEventListener('pointerdown', warmUp, { once: true });
    el.addEventListener('focus', warmUp, { once: true });
  }
  window.addEventListener('dragover', warmUp, { once: true });
  window.addEventListener('paste', warmUp, { once: true });
  fileInput.addEventListener('change', warmUp, { once: true });
  cameraInput.addEventListener('change', warmUp, { once: true });
}

/* ---------- Offline engine ---------- */

// The service worker keeps the app shell for offline use from the first
// visit, but not the engine, for the reason above. It is stored once there is
// intent: a scan (see warmUp), a share, or the app being installed.
function requestEngineCache() {
  navigator.serviceWorker?.ready.then((reg) => reg.active?.postMessage({ type: 'cache-engine' }));
}

function setupOfflineEngine() {
  if (!('serviceWorker' in navigator)) return;

  // Sent by sw.js at the moment the engine cache becomes complete.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'engine-cached') toast(t('offlineReady'), { type: 'ok' });
  });

  window.addEventListener('appinstalled', requestEngineCache);
  // Covers an install made from a reading page, and iOS, which has no
  // appinstalled event.
  if (matchMedia('(display-mode: standalone)').matches && !navigator.connection?.saveData) {
    (window.requestIdleCallback ?? setTimeout)(requestEngineCache);
  }
}

/* ---------- File intake ---------- */

// Files can be dropped anywhere on the window; body.dragover shows the
// full-window drop overlay. dragenter/dragleave fire for every element the
// pointer crosses, hence the depth counter.
function setupDragAndDrop() {
  let depth = 0;
  const hasFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  const end = () => {
    depth = 0;
    document.body.classList.remove('dragover');
  };
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    document.body.classList.add('dragover');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) end();
  });
  window.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    end();
    addFiles(e.dataTransfer.files);
  });
}

// Photos sent from another app through "Share -> ScanPDF" (share-target.js).
async function consumeShare() {
  const shared = await takeSharedFiles();
  if (!shared) return;
  if (shared.failed || !shared.files.length) {
    toast(t('shareFailed'), { type: 'error' });
    return;
  }
  warmUp();
  await addFiles(shared.files);
}

async function addFiles(fileList) {
  const all = Array.from(fileList);
  const files = all.filter((f) => f.type.startsWith('image/'));
  if (files.length < all.length) {
    toast(t('filesSkipped', { n: all.length - files.length }), { type: 'error' });
  }
  for (const file of files) {
    try {
      const page = await createPage(file);
      state.pages.push(page);
      if (!state.selectedId) state.selectedId = page.id;
      emit();
      queueDetect(page.id);
    } catch (err) {
      console.error(`Could not load ${file.name}`, err);
      toast(t('imageLoadFailed', { name: file.name }), { type: 'error' });
    }
  }
}

async function createPage(file) {
  const bmp = await loadBitmap(file);
  const s = Math.min(1, MAX_PROC_SIDE / Math.max(bmp.width, bmp.height));
  const proc = document.createElement('canvas');
  proc.width = Math.max(1, Math.round(bmp.width * s));
  proc.height = Math.max(1, Math.round(bmp.height * s));
  proc.getContext('2d').drawImage(bmp, 0, 0, proc.width, proc.height);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    fullBitmap: bmp,
    procCanvas: proc,
    scale: bmp.width / proc.width,
    corners: fallbackCorners(bmp.width, bmp.height),
    rotation: 0,
    filter: 'color',
    deshadow: deshadowDefault,
    detectOk: false,
    detecting: true,
  };
}

// EXIF-corrected decode, downscaled to MAX_FULL_SIDE to bound WASM memory
// during the full-res warp.
async function loadBitmap(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (_) {
    bmp = await bitmapViaImg(file); // older Safari: <img> applies EXIF itself
  }
  const long = Math.max(bmp.width, bmp.height);
  if (long <= MAX_FULL_SIDE) return bmp;
  const s = MAX_FULL_SIDE / long;
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const scaled = await createImageBitmap(c);
  c.width = c.height = 0;
  return scaled;
}

function bitmapViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      createImageBitmap(img).then(resolve, reject).finally(() => URL.revokeObjectURL(url));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decode failed'));
    };
    img.src = url;
  });
}

/* ---------- Detection queue (sequential) ---------- */

const detectQueue = [];
let detectRunning = false;

function queueDetect(id) {
  detectQueue.push(id);
  runDetectQueue();
}

async function runDetectQueue() {
  if (detectRunning) return;
  detectRunning = true;
  try {
    while (detectQueue.length) {
      const page = getPage(detectQueue.shift());
      if (!page) continue;
      try {
        const cv = await cvReady();
        const res = detectCorners(cv, page.procCanvas);
        page.corners = res.corners.map((c) => ({ x: c.x * page.scale, y: c.y * page.scale }));
        page.detectOk = res.ok;
      } catch (err) {
        console.error('Corner detection failed', err);
        page.detectOk = false;
      }
      page.detecting = false;
      emit();
    }
  } finally {
    detectRunning = false;
  }
}

/* ---------- Toolbar ---------- */

function setupToolbar() {
  // Phones have no room for both rotations in the dock: one is in the menu.
  for (const id of ['rotate-ccw', 'menu-rotate-ccw']) {
    $(id).addEventListener('click', () => rotate(-90));
  }
  $('rotate-cw').addEventListener('click', () => rotate(90));

  for (const input of filterInputs) {
    input.addEventListener('change', () => {
      const page = selectedPage();
      if (!page || !input.checked) return;
      page.filter = input.value;
      emit();
    });
  }

  $('filter-all').addEventListener('click', () => {
    const current = selectedPage();
    if (!current) return;
    for (const page of state.pages) {
      page.filter = current.filter;
      page.deshadow = current.deshadow;
    }
    emit();
  });

  setupDeshadow();

  $('redetect-btn').addEventListener('click', () => {
    const page = selectedPage();
    if (!page) return;
    page.detecting = true;
    emit();
    queueDetect(page.id);
  });

  $('reset-corners-btn').addEventListener('click', () => {
    const page = selectedPage();
    if (!page) return;
    page.corners = fallbackCorners(page.fullBitmap.width, page.fullBitmap.height, 0.02);
    page.detectOk = true;
    emit();
  });

  const moveSelected = (dir) => {
    const i = indexOfPage(state.selectedId);
    if (movePage(i, i + dir)) {
      announce(t('pageMoved', { i: i + dir + 1, n: state.pages.length }));
    }
  };
  $('move-earlier-btn').addEventListener('click', () => moveSelected(-1));
  $('move-later-btn').addEventListener('click', () => moveSelected(1));
  for (const id of ['delete-btn', 'menu-delete-btn']) {
    $(id).addEventListener('click', () => removePage(state.selectedId));
  }

  // Not while a thumbnail is being dragged: the drop is committed by index,
  // and a page inserted meanwhile would shift it (same for the split below).
  $('duplicate-btn').addEventListener('click', () => {
    if (isReordering()) return;
    const i = duplicatePage(state.selectedId);
    if (i >= 0) announce(t('pageDuplicated', { i: i + 1, n: state.pages.length }));
  });
  setupSplit();

  rememberSelect($('page-format'), PAGE_FORMAT_KEY, (value, changed) => {
    state.pageFormat = value;
    if (changed) emit();
  });
  setupTargetSize();

  saveBtn.addEventListener('click', onSave);
}

// Splitting is a mode of the editor (state.split): the split bar replaces the
// dock until the line is confirmed or dropped.
function setupSplit() {
  const moreSummary = document.querySelector('#more-menu > summary');

  $('split-btn').addEventListener('click', () => {
    if (isReordering() || !enterSplit(state.selectedId)) return;
    setPreviewMode(false); // phones: the line is drawn in the editor pane
    $('split-apply-btn').focus(); // Enter confirms
  });
  for (const input of splitDirInputs) {
    input.addEventListener('change', () => {
      if (input.checked) setSplitDir(input.value);
    });
  }
  const cancel = () => {
    cancelSplit();
    moreSummary.focus();
  };
  $('split-cancel-btn').addEventListener('click', cancel);
  $('split-apply-btn').addEventListener('click', () => {
    if (isReordering()) return;
    const i = applySplit();
    if (i < 0) return;
    announce(t('pageSplit', { i: i + 1, j: i + 2, n: state.pages.length }));
    moreSummary.focus();
  });

  // Escape leaves the mode, unless it is already closing a menu (menus.js)
  // or something else owns the screen.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state.split) return;
    if (document.querySelector('details.menu[open]') || isReordering() || !exportOverlay.hidden) return;
    e.preventDefault();
    cancel();
  }, true);
}

// The export settings are remembered between visits: whoever needs A5, or
// "under 2 MB" for a portal, usually needs it every time. The template's
// default option is never stored, so it can change later without leaving
// stale choices behind.
function rememberSelect(select, key, apply) {
  const fallback = select.value;
  let saved = null;
  try {
    saved = localStorage.getItem(key);
  } catch (_) {
    // Storage blocked: start from the default.
  }
  if (saved && Array.from(select.options).some((option) => option.value === saved)) {
    select.value = saved;
  }
  apply(select.value, false);

  select.addEventListener('change', () => {
    apply(select.value, true);
    try {
      if (select.value === fallback) localStorage.removeItem(key);
      else localStorage.setItem(key, select.value);
    } catch (_) {
      // Storage blocked: the choice still holds for this page view.
    }
  });
}

// Shadows come from where someone scans (the same desk, the same lamp), so
// the switch is remembered like the export settings: new pages start with its
// last position. Stored only while on, like every other default.
function setupDeshadow() {
  try {
    deshadowDefault = localStorage.getItem(DESHADOW_KEY) === '1';
  } catch (_) {
    // Storage blocked: start from the default.
  }

  deshadowBtn.addEventListener('click', () => {
    const page = selectedPage();
    if (!page) return;
    page.deshadow = !page.deshadow;
    deshadowDefault = page.deshadow;
    try {
      if (deshadowDefault) localStorage.setItem(DESHADOW_KEY, '1');
      else localStorage.removeItem(DESHADOW_KEY);
    } catch (_) {
      // Storage blocked: the choice still holds for this page view.
    }
    emit();
  });
}

function setupTargetSize() {
  const select = $('target-size');
  // The template carries plain "2 MB" labels; redo them in the page's locale.
  for (const option of select.options) {
    if (Number(option.value)) option.textContent = `\u2264 ${formatBytes(Number(option.value))}`;
  }
  rememberSelect(select, TARGET_SIZE_KEY, (value) => {
    state.targetBytes = Number(value);
    // A remembered limit has to be visible, or it degrades scans silently.
    select.classList.toggle('is-set', state.targetBytes > 0);
  });
}

function rotate(delta) {
  const page = selectedPage();
  if (!page) return;
  page.rotation = (page.rotation + delta + 360) % 360;
  emit();
}

/* ---------- Mobile editor/preview toggle ---------- */

function setupViewToggle() {
  layoutEl = document.querySelector('.layout');
  viewToggle = $('view-toggle');
  viewEditorBtn = $('view-editor-btn');
  viewPreviewBtn = $('view-preview-btn');
  viewEditorBtn.addEventListener('click', () => setPreviewMode(false));
  viewPreviewBtn.addEventListener('click', () => setPreviewMode(true));
}

function setPreviewMode(on) {
  layoutEl.classList.toggle('show-preview', on);
  viewEditorBtn.classList.toggle('active', !on);
  viewPreviewBtn.classList.toggle('active', on);
  if (on) schedulePreview();
}

function syncEmptyState() {
  document.body.classList.toggle('is-empty', state.pages.length === 0);
}

function syncControls() {
  const page = selectedPage();
  toolbar.hidden = !page || !!state.split;
  splitBar.hidden = !page || !state.split;
  if (state.split) {
    for (const input of splitDirInputs) input.checked = input.value === state.split.dir;
  }
  if (page) {
    // A page still queued for detection would get its corners overwritten.
    $('duplicate-btn').disabled = page.detecting;
    $('split-btn').disabled = page.detecting;
    for (const input of filterInputs) input.checked = input.value === page.filter;
    // B&W evens the light by itself. The page keeps its own choice, so it is
    // back when the filter changes.
    const bw = page.filter === 'bw';
    deshadowBtn.setAttribute('aria-pressed', String(page.deshadow || bw));
    deshadowBtn.disabled = bw;
    const i = indexOfPage(page.id);
    $('move-earlier-btn').disabled = i === 0;
    $('move-later-btn').disabled = i === state.pages.length - 1;
  }
  saveBtn.disabled = state.pages.length === 0;
  viewToggle.hidden = state.pages.length === 0;
  if (state.pages.length === 0) setPreviewMode(false);
  schedulePreview();
}

/* ---------- Export ---------- */

async function onSave() {
  if (!state.pages.length) return;
  exportOverlay.hidden = false;
  exportBar.style.width = '0%';
  try {
    const result = await exportPdf(({ i, n, compressing, fraction }) => {
      exportStatus.textContent = t(compressing ? 'compressingPage' : 'exportingPage', { i, n });
      exportBar.style.width = `${Math.round(fraction * 100)}%`;
    });
    exportBar.style.width = '100%';
    const size = formatBytes(result.bytes);
    if (result.fits) toast(t('exportDone', { size }), { type: 'ok' });
    else toast(t('exportOverTarget', { size, target: formatBytes(result.target) }), { type: 'info', sticky: true });
  } catch (err) {
    console.error('Export failed', err);
    toast(t('exportFailed', { message: err.message }), { type: 'error' });
  } finally {
    exportOverlay.hidden = true;
  }
}
