// Application state: ordered page list + a tiny pub/sub.
//
// page = {
//   id, name,
//   fullBitmap,   // ImageBitmap, EXIF-corrected, long side <= 3500px
//   procCanvas,   // downscaled copy (<= 1000px) for detection & previews
//   scale,        // procCanvas px -> fullBitmap px factor
//   corners,      // [TL, TR, BR, BL] as {x, y} in fullBitmap coordinates
//   rotation,     // 0 | 90 | 180 | 270, applied after warp
//   filter,       // 'color' | 'gray' | 'bw'
//   deshadow,     // true => even out the lighting (shadows, book-fold shading)
//   detectOk,     // false => fallback corners were used
//   detecting,    // true while queued for auto-detection
// }
//
// Duplicates and the halves of a split page share fullBitmap and procCanvas
// (a second copy of a photo would cost tens of megabytes), so the bitmap is
// closed only with the last page that uses it.

import { splitQuads, defaultDir } from './split.js';

export const state = {
  pages: [],
  selectedId: null,
  pageFormat: 'auto', // 'auto' or a key of FORMATS (formats.js)
  jpegQuality: 0.85,
  targetBytes: 0, // maximum PDF size in bytes; 0 = no limit
  split: null, // the dividing line while the selected page is being split (split.js)
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
  // Split mode belongs to the selected page: selecting another page or
  // deleting this one ends it, whoever caused that.
  if (state.split && state.split.pageId !== state.selectedId) state.split = null;
  for (const fn of listeners) fn();
}

export function getPage(id) {
  return state.pages.find((p) => p.id === id) || null;
}

export function selectedPage() {
  return getPage(state.selectedId);
}

export function indexOfPage(id) {
  return state.pages.findIndex((p) => p.id === id);
}

/** Move a page to a new position in the document. Returns false if nothing moved. */
export function movePage(from, to) {
  const last = state.pages.length - 1;
  if (from < 0 || from > last) return false;
  to = Math.min(Math.max(to, 0), last);
  if (to === from) return false;
  const [page] = state.pages.splice(from, 1);
  state.pages.splice(to, 0, page);
  emit();
  return true;
}

/** Delete a page; the selection moves to its neighbour. */
export function removePage(id) {
  const i = indexOfPage(id);
  if (i < 0) return;
  const [page] = state.pages.splice(i, 1);
  const shared = state.pages.some((p) => p.fullBitmap === page.fullBitmap);
  if (!shared && page.fullBitmap && page.fullBitmap.close) page.fullBitmap.close();
  if (state.selectedId === id) {
    const next = state.pages[Math.min(i, state.pages.length - 1)];
    state.selectedId = next ? next.id : null;
  }
  emit();
}

/** Insert a copy right after the page and select it. Returns the copy's index, or -1. */
export function duplicatePage(id) {
  const i = indexOfPage(id);
  // A copy of a page that is still queued would never get its own result.
  if (i < 0 || state.pages[i].detecting) return -1;
  const page = state.pages[i];
  const copy = { ...page, id: crypto.randomUUID(), corners: page.corners.map((c) => ({ ...c })) };
  state.pages.splice(i + 1, 0, copy);
  state.selectedId = copy.id;
  emit();
  return i + 1;
}

/* ---------- Split mode ---------- */

export function enterSplit(id) {
  const page = getPage(id);
  if (!page || page.detecting || id !== state.selectedId) return false;
  state.split = { pageId: id, dir: defaultDir(page.corners), a: 0.5, b: 0.5 };
  emit();
  return true;
}

export function setSplitDir(dir) {
  if (!state.split || state.split.dir === dir) return;
  state.split = { ...state.split, dir, a: 0.5, b: 0.5 };
  emit();
}

export function cancelSplit() {
  if (!state.split) return;
  state.split = null;
  emit();
}

/**
 * Replace the page with its two halves. The page itself becomes the first one
 * (keeping its id keeps the selection and the keyboard focus); the second is
 * inserted after it. Returns the index of the first half, or -1.
 */
export function applySplit() {
  const split = state.split;
  const i = split ? indexOfPage(split.pageId) : -1;
  if (i < 0) return -1;
  const page = state.pages[i];
  const [first, second] = splitQuads(page.corners, split, page.rotation);
  page.corners = first;
  page.detectOk = true;
  state.pages.splice(i + 1, 0, { ...page, id: crypto.randomUUID(), corners: second });
  state.split = null;
  emit();
  return i;
}
