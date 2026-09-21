// Page enhancement applied to the warped canvas (in place): the colour
// filters and the lighting correction, plus the post-warp rotation helper.

import { withMats } from './detect.js';

// The background is estimated on a fixed-size copy, so the kernels cover the
// same part of the sheet in the 900px preview and in the 2600px export.
const BG_SIDE = 400; // long side of the working copy
const BG_CLOSE = 7; // ~5mm on A4: erases text strokes
const BG_MEDIAN = 15; // ~11mm: what the closing left of bold type
const BG_SMOOTH = 5;
// Times the mean background. Anything darker is content (a photo, a solid
// fill) rather than shadow, so the gain stops growing there.
const BG_FLOOR = 0.45;

export function applyFilter(cv, canvas, filter, deshadow = false) {
  // B&W always evens the light: it is what whitens the paper.
  const even = deshadow || filter === 'bw';
  if (filter === 'color' && !even) return canvas;
  return withMats((track) => {
    const src = track(cv.imread(canvas));
    let img = track(new cv.Mat());
    cv.cvtColor(src, img, filter === 'color' ? cv.COLOR_RGBA2RGB : cv.COLOR_RGBA2GRAY);

    if (even) img = evenLighting(cv, img, track);
    // "Scan look": a mild contrast push on the already flat page keeps text
    // anti-aliased.
    if (filter === 'bw') img.convertTo(img, -1, 1.4, -80);

    cv.imshow(canvas, img);
    return canvas;
  });
}

// Removes shadows and slow gradients such as the shading along a book's
// spine: the paper's brightness is estimated with the text erased, then the
// page is divided by it. Per channel, so a lamp's colour cast goes as well.
function evenLighting(cv, img, track) {
  const s = Math.min(1, BG_SIDE / Math.max(img.cols, img.rows));
  const size = new cv.Size(Math.max(1, Math.round(img.cols * s)), Math.max(1, Math.round(img.rows * s)));
  const small = track(new cv.Mat());
  cv.resize(img, small, size, 0, 0, cv.INTER_AREA);

  // Closing rather than dilating: a shadow's edge stays where it is, which
  // keeps the halo along it thin.
  const kernel = track(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(BG_CLOSE, BG_CLOSE)));
  cv.morphologyEx(small, small, cv.MORPH_CLOSE, kernel);
  cv.medianBlur(small, small, BG_MEDIAN);
  cv.GaussianBlur(small, small, new cv.Size(BG_SMOOTH, BG_SMOOTH), 0);

  // cv.max takes no scalar in OpenCV.js, hence the constant Mat. The floor
  // also rules out a zero divisor, which would turn the pixel black.
  const floorOf = (v) => Math.max(1, v * BG_FLOOR);
  const mean = cv.mean(small);
  const floor = track(
    new cv.Mat(small.rows, small.cols, small.type(), new cv.Scalar(floorOf(mean[0]), floorOf(mean[1]), floorOf(mean[2]), 255)),
  );
  cv.max(small, floor, small);

  const bg = track(new cv.Mat());
  cv.resize(small, bg, new cv.Size(img.cols, img.rows), 0, 0, cv.INTER_LINEAR);
  const out = track(new cv.Mat());
  cv.divide(img, bg, out, 255);
  return out;
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
