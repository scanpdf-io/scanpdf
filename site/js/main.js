// Bootstrap: file intake (picker + drag&drop), EXIF-corrected decoding,
// downscaling, the sequential detection queue, and toolbar wiring.

import { state, subscribe, emit, getPage, selectedPage } from './state.js';
import { cvReady } from './cv-loader.js';
import { detectCorners, fallbackCorners } from './detect.js';
import { initEditor, schedulePreview } from './editor.js';
import { initPagesUI } from './pages-ui.js';
import { exportPdf } from './export.js';

const MAX_FULL_SIDE = 3500;
const MAX_PROC_SIDE = 1000;

const $ = (id) => document.getElementById(id);

const fileInput = $('file-input');
const cameraInput = $('camera-input');
const engineStatus = $('engine-status');
const saveBtn = $('save-btn');
const toolbar = $('page-toolbar');
const filterSelect = $('filter-select');
const exportOverlay = $('export-overlay');
const exportStatus = $('export-status');
const exportBar = $('export-bar');

let layoutEl, viewToggle, viewEditorBtn, viewPreviewBtn;

init();

function init() {
  initEditor();
  initPagesUI();

  // Warm up the OpenCV engine right away — it is ~10MB of WASM.
  cvReady().then(
    () => {
      engineStatus.textContent = 'Engine ready';
      engineStatus.classList.add('ready');
      setTimeout(() => (engineStatus.hidden = true), 2500);
    },
    (err) => {
      engineStatus.textContent = 'Engine failed to load';
      console.error(err);
    },
  );

  $('add-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });
  $('camera-btn').addEventListener('click', () => cameraInput.click());
  cameraInput.addEventListener('change', () => {
    addFiles(cameraInput.files);
    cameraInput.value = '';
  });
  $('dropzone').addEventListener('click', () => fileInput.click());

  setupDragAndDrop();
  setupToolbar();
  setupViewToggle();
  subscribe(syncControls);
  syncControls();
}

/* ---------- File intake ---------- */

function setupDragAndDrop() {
  const dropzone = $('dropzone');
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) dropzone.classList.remove('dragover');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
  for (const file of files) {
    try {
      const page = await createPage(file);
      state.pages.push(page);
      if (!state.selectedId) state.selectedId = page.id;
      emit();
      queueDetect(page.id);
    } catch (err) {
      console.error(`Could not load ${file.name}`, err);
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

  filterSelect.addEventListener('change', () => {
    const page = selectedPage();
    if (!page) return;
    page.filter = filterSelect.value;
    emit();
  });

  $('filter-all').addEventListener('click', () => {
    for (const page of state.pages) page.filter = filterSelect.value;
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

  $('page-format').addEventListener('change', (e) => {
    state.pageFormat = e.target.value;
    emit();
  });

  saveBtn.addEventListener('click', onSave);
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

function syncControls() {
  const page = selectedPage();
  toolbar.hidden = !page;
  if (page) filterSelect.value = page.filter;
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
    await exportPdf((i, n) => {
      exportStatus.textContent = `Exporting page ${i} of ${n}…`;
      exportBar.style.width = `${Math.round(((i - 1) / n) * 100)}%`;
    });
    exportBar.style.width = '100%';
  } catch (err) {
    console.error('Export failed', err);
    alert(`Export failed: ${err.message}`);
  } finally {
    exportOverlay.hidden = true;
  }
}
