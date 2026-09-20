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
//   detectOk,     // false => fallback corners were used
//   detecting,    // true while queued for auto-detection
// }

export const state = {
  pages: [],
  selectedId: null,
  pageFormat: 'auto', // 'auto' or a key of FORMATS (formats.js)
  jpegQuality: 0.85,
  targetBytes: 0, // maximum PDF size in bytes; 0 = no limit
};

const listeners = new Set();

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit() {
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
  if (page.fullBitmap && page.fullBitmap.close) page.fullBitmap.close();
  if (state.selectedId === id) {
    const next = state.pages[Math.min(i, state.pages.length - 1)];
    state.selectedId = next ? next.id : null;
  }
  emit();
}
