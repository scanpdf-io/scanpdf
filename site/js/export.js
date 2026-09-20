// Multi-page PDF assembly. Pages are rendered sequentially at full resolution
// to bound peak memory and drive the progress bar. With a size limit set, a
// second pass recompresses the pages to fit it.

import { state } from './state.js';
import { t } from './i18n.js';
import { cvReady } from './cv-loader.js';
import { computeOutputSize, warpToCanvas } from './warp.js';
import { applyFilter, rotateCanvas } from './filters.js';

const EXPORT_MAX_SIDE = 2600;
const AUTO_DPI = 200;
const PAGE_PTS = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

// Fitting a size limit (state.targetBytes). Quality is lowered first, down to
// Q_MIN; past that the page is downscaled instead, because a smaller sharp
// page reads better than a large smeared one. MIN_SIDE (~85 DPI on A4) with
// Q_FLOOR is the point where text stops being legible - compression never
// goes below it, even if that means missing the limit.
const Q_MIN = 0.45;
const Q_FLOOR = 0.3;
const MIN_SIDE = 1000;
const MAX_SHRINK_STEP = 0.85;
const SEARCH_STEPS = 5;
const CLOSE_ENOUGH = 0.92; // stop searching once a page fills this much of its budget
// Headroom for the PDF structure around the JPEGs, plus a safety margin.
const PDF_BASE_BYTES = 2048;
const PDF_PAGE_BYTES = 1024;
const TARGET_MARGIN = 0.98;

// Resolves to { bytes, target, fits }: the saved size, the limit that was
// asked for (0 = none) and whether the file ended up within it. The file is
// downloaded either way.
export async function exportPdf(onProgress) {
  if (!window.PDFLib) throw new Error('pdf-lib is not loaded');
  const cv = await cvReady();

  const target = state.targetBytes;
  const total = state.pages.length;
  // With a limit set the bar is split between the two passes, so it never
  // runs backwards when the second one turns out to be needed.
  const report = (i, compressing) => {
    if (!onProgress) return;
    const done = i / total;
    const fraction = target ? (compressing ? 0.5 + done / 2 : done / 2) : done;
    onProgress({ i: i + 1, n: total, compressing, fraction });
  };

  // Pass 1: every page at full resolution and default quality. Only the
  // JPEGs are kept, so peak memory stays at one page's worth of pixels.
  const items = [];
  for (let i = 0; i < total; i++) {
    const page = state.pages[i];
    report(i, false);
    await nextFrame(); // let the progress UI paint

    const canvas = renderPage(cv, page);
    const blob = await encode(canvas, defaultQuality(page));
    // The sheet size comes from the full-resolution pixels; a page that gets
    // downscaled in pass 2 must not shrink on paper.
    items.push({ blob, pts: pagePoints(canvas.width, canvas.height) });
    canvas.width = canvas.height = 0;
  }

  // Pass 2, only when over the limit: re-render each page and fit it into its
  // share of the budget. Shares follow the pass 1 sizes - a busy photo needs
  // more bytes than a near-blank sheet - and whatever a page leaves unused
  // rolls over to the pages after it.
  const overhead = PDF_BASE_BYTES + PDF_PAGE_BYTES * total;
  let weight = items.reduce((sum, item) => sum + item.blob.size, 0);
  if (target && weight + overhead > target) {
    let avail = target * TARGET_MARGIN - overhead;
    for (let i = 0; i < total; i++) {
      const page = state.pages[i];
      report(i, true);
      await nextFrame();

      const size = items[i].blob.size;
      const budget = Math.max(1, (avail * size) / weight);
      items[i].blob = await fitPage(renderPage(cv, page), defaultQuality(page), budget);
      avail -= items[i].blob.size;
      weight -= size;
    }
  }

  const bytes = await assemble(items);
  download(new Blob([bytes], { type: 'application/pdf' }));
  return { bytes: bytes.byteLength, target, fits: !target || bytes.byteLength <= target };
}

// JPEG artifacts hit hard text edges harder — use higher quality for B&W.
function defaultQuality(page) {
  return page.filter === 'bw' ? 0.9 : state.jpegQuality;
}

// Full-res source -> warp -> filter -> rotate.
function renderPage(cv, page) {
  const src = document.createElement('canvas');
  src.width = page.fullBitmap.width;
  src.height = page.fullBitmap.height;
  src.getContext('2d').drawImage(page.fullBitmap, 0, 0);
  const { w, h } = computeOutputSize(page.corners, state.pageFormat, EXPORT_MAX_SIDE);
  let out = warpToCanvas(cv, src, page.corners, w, h);
  src.width = src.height = 0;
  out = applyFilter(cv, out, page.filter);
  return rotateCanvas(out, page.rotation);
}

function encode(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', quality);
  });
}

// The best-looking JPEG of the canvas that fits the budget, or the smallest
// one allowed when nothing does. Consumes the canvas.
async function fitPage(canvas, maxQuality, budget) {
  for (;;) {
    const long = Math.max(canvas.width, canvas.height);
    const atFloor = long <= MIN_SIDE;
    const minQuality = atFloor ? Q_FLOOR : Q_MIN;
    let fit = await encode(canvas, minQuality);

    if (fit.size > budget && !atFloor) {
      // JPEG size goes roughly with the pixel count, hence the square root.
      const wanted = Math.sqrt(budget / fit.size) * 0.95;
      canvas = scaleCanvas(canvas, Math.max(MIN_SIDE / long, Math.min(MAX_SHRINK_STEP, wanted)));
      continue;
    }

    if (fit.size <= budget) {
      // Binary search for the highest quality that still fits.
      let lo = minQuality;
      let hi = maxQuality;
      for (let k = 0; k < SEARCH_STEPS && fit.size < budget * CLOSE_ENOUGH; k++) {
        const quality = (lo + hi) / 2;
        const blob = await encode(canvas, quality);
        if (blob.size <= budget) {
          fit = blob;
          lo = quality;
        } else {
          hi = quality;
        }
      }
    }
    canvas.width = canvas.height = 0;
    return fit;
  }
}

function scaleCanvas(canvas, factor) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(canvas.width * factor));
  out.height = Math.max(1, Math.round(canvas.height * factor));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  canvas.width = canvas.height = 0;
  return out;
}

function pagePoints(width, height) {
  if (state.pageFormat === 'auto') return [(width * 72) / AUTO_DPI, (height * 72) / AUTO_DPI];
  const [shortPt, longPt] = PAGE_PTS[state.pageFormat];
  return height >= width ? [shortPt, longPt] : [longPt, shortPt];
}

async function assemble(items) {
  const { PDFDocument } = window.PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle(t('pdfTitle'));
  doc.setProducer('ScanPDF (local)');
  doc.setCreator('ScanPDF (local)');

  for (const { blob, pts } of items) {
    const jpg = await doc.embedJpg(await blob.arrayBuffer());
    const [pw, ph] = pts;
    const pdfPage = doc.addPage([pw, ph]);
    pdfPage.drawImage(jpg, { x: 0, y: 0, width: pw, height: ph });
  }
  return doc.save();
}

function download(blob) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `scan-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.pdf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
}
