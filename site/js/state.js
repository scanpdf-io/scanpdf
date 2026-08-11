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
  pageFormat: 'a4', // 'a4' | 'letter' | 'auto'
  jpegQuality: 0.85,
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
