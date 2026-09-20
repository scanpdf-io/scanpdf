// Bootstrap: file intake (picker + drag&drop), EXIF-corrected decoding,
// downscaling, the sequential detection queue, and toolbar wiring.

import { state, subscribe, emit, getPage, selectedPage, indexOfPage, movePage, removePage } from './state.js';
import { cvReady } from './cv-loader.js';
import { detectCorners, fallbackCorners } from './detect.js';
import { initEditor, schedulePreview } from './editor.js';
import { initPagesUI } from './pages-ui.js';
import { exportPdf } from './export.js';
import { t } from './i18n.js';
import { formatBytes } from './format.js';
import { toast, announce } from './toast.js';

const MAX_FULL_SIDE = 3500;
const MAX_PROC_SIDE = 1000;
const TARGET_SIZE_KEY = 'scanpdf-target-size';

const $ = (id) => document.getElementById(id);

const fileInput = $('file-input');
const cameraInput = $('camera-input');
const saveBtn = $('save-btn');
const toolbar = $('page-toolbar');
const filterInputs = Array.from(document.querySelectorAll('input[name="filter"]'));
const exportOverlay = $('export-overlay');
const exportStatus = $('export-status');
const exportBar = $('export-bar');

// The landing (hero) and the workspace (rail) each have their own pair.
const ADD_BUTTONS = ['add-btn', 'hero-add-btn'];
const CAMERA_BUTTONS = ['camera-btn', 'hero-camera-btn'];

let layoutEl, viewToggle, viewEditorBtn, viewPreviewBtn;

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
}

/* ---------- Engine warm-up ---------- */

// The OpenCV build is ~10MB, so it is not fetched on page load: visitors who
// arrive from search and only read would pay for it without ever scanning.
// The first sign of intent starts it instead. Hovering a button or dragging a
// file over the window happens seconds before a file is actually chosen, so
// the download still overlaps the file picker and nothing feels slower.
function setupEngineWarmUp() {
  let started = false;

  const warmUp = () => {
    if (started) return;
    started = true;
    const status = toast(t('engineLoading'), { type: 'busy' });
    cvReady().then(
      () => status.close(),
      (err) => {
        status.update(t('engineFailed'), { type: 'error' });
        console.error(err);
      },
    );
  };

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
  $('rotate-ccw').addEventListener('click', () => rotate(-90));
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
    for (const page of state.pages) page.filter = current.filter;
    emit();
  });

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

  $('page-format').addEventListener('change', (e) => {
    state.pageFormat = e.target.value;
    emit();
  });

  setupTargetSize();

  saveBtn.addEventListener('click', onSave);
}

// The size limit is the one export setting worth remembering: whoever needs
// "under 2 MB" for a portal usually needs it every time.
function setupTargetSize() {
  const select = $('target-size');
  // The template carries plain "2 MB" labels; redo them in the page's locale.
  for (const option of select.options) {
    if (Number(option.value)) option.textContent = `\u2264 ${formatBytes(Number(option.value))}`;
  }

  let saved = null;
  try {
    saved = localStorage.getItem(TARGET_SIZE_KEY);
  } catch (_) {
    // Storage blocked: start without a limit.
  }
  if (saved && Array.from(select.options).some((option) => option.value === saved)) {
    select.value = saved;
  }
  state.targetBytes = Number(select.value);
  select.classList.toggle('is-set', state.targetBytes > 0);

  select.addEventListener('change', () => {
    state.targetBytes = Number(select.value);
    select.classList.toggle('is-set', state.targetBytes > 0);
    try {
      if (state.targetBytes) localStorage.setItem(TARGET_SIZE_KEY, select.value);
      else localStorage.removeItem(TARGET_SIZE_KEY);
    } catch (_) {
      // Storage blocked: the choice still holds for this page view.
    }
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
  toolbar.hidden = !page;
  if (page) {
    for (const input of filterInputs) input.checked = input.value === page.filter;
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
