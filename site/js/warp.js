// Perspective correction and output page sizing, shared by the live preview
// (procCanvas resolution) and the PDF export (full resolution).

import { withMats } from './detect.js';

const RATIOS = {
  a4: 210 / 297,
  letter: 8.5 / 11,
};

// Output pixel size for a detected quad. Side lengths of the quad recover the
// true sheet aspect for near-frontal shots; 'a4'/'letter' snap the ratio to
// the paper format (portrait vs landscape chosen by the measured ratio).
export function computeOutputSize(corners, format, maxSide = 2600) {
  const [tl, tr, br, bl] = corners;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = Math.max(d(tl, tr), d(bl, br), 8);
  let h = Math.max(d(tl, bl), d(tr, br), 8);

  const r = RATIOS[format];
  if (r) {
    const long = Math.max(w, h);
    const measured = w / h;
    const portrait = Math.abs(Math.log(measured / r)) <= Math.abs(Math.log(measured * r));
    if (portrait) {
      h = long;
      w = long * r;
    } else {
      w = long;
      h = long * r;
    }
  }

  const s = Math.min(1, maxSide / Math.max(w, h));
  return {
    w: Math.max(1, Math.round(w * s)),
    h: Math.max(1, Math.round(h * s)),
  };
}

// Warps the quad from sourceCanvas into a new outW×outH canvas.
export function warpToCanvas(cv, sourceCanvas, corners, outW, outH) {
  return withMats((track) => {
    const src = track(cv.imread(sourceCanvas));
    const dst = track(new cv.Mat());
    const [tl, tr, br, bl] = corners;
    const srcQuad = track(cv.matFromArray(4, 1, cv.CV_32FC2, [
      tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
    ]));
    const dstQuad = track(cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0, outW, 0, outW, outH, 0, outH,
    ]));
    const M = track(cv.getPerspectiveTransform(srcQuad, dstQuad));
    cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_LINEAR, cv.BORDER_REPLICATE);

    const out = document.createElement('canvas');
    cv.imshow(out, dst);
    return out;
  });
}
