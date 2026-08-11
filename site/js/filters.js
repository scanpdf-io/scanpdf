// Page enhancement filters applied to the warped canvas (in place), plus the
// post-warp rotation helper.

import { withMats } from './detect.js';

export function applyFilter(cv, canvas, filter) {
  if (filter === 'color') return canvas;
  return withMats((track) => {
    const src = track(cv.imread(canvas));
    const gray = track(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    let out = gray;
    if (filter === 'bw') {
      // "Scan look": background division flattens shadows and whitens the
      // paper while keeping text anti-aliased, then a mild contrast push.
      const bg = track(new cv.Mat());
      cv.GaussianBlur(gray, bg, new cv.Size(41, 41), 0);
      const flat = track(new cv.Mat());
      cv.divide(gray, bg, flat, 255);
      flat.convertTo(flat, -1, 1.4, -80);
      out = flat;
    }

    cv.imshow(canvas, out);
    return canvas;
  });
}

export function rotateCanvas(canvas, rotation) {
  if (!rotation) return canvas;
  const swap = rotation % 180 !== 0;
  const out = document.createElement('canvas');
  out.width = swap ? canvas.height : canvas.width;
  out.height = swap ? canvas.width : canvas.height;
  const ctx = out.getContext('2d');
  ctx.translate(out.width / 2, out.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return out;
}
