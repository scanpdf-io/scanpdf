// Multi-page PDF assembly. Pages are rendered sequentially at full resolution
// to bound peak memory and drive the progress bar.

import { state } from './state.js';
import { cvReady } from './cv-loader.js';
import { computeOutputSize, warpToCanvas } from './warp.js';
import { applyFilter, rotateCanvas } from './filters.js';

const EXPORT_MAX_SIDE = 2600;
const AUTO_DPI = 200;
const PAGE_PTS = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

export async function exportPdf(onProgress) {
  if (!window.PDFLib) throw new Error('pdf-lib is not loaded');
  const { PDFDocument } = window.PDFLib;
  const cv = await cvReady();

  const doc = await PDFDocument.create();
  doc.setTitle('Scanned document');
  doc.setProducer('ScanPDF (local)');
  doc.setCreator('ScanPDF (local)');

  const total = state.pages.length;
  for (let i = 0; i < total; i++) {
    const page = state.pages[i];
    if (onProgress) onProgress(i + 1, total);
    await nextFrame(); // let the progress UI paint

    // Full-res source -> warp -> filter -> rotate.
    const src = document.createElement('canvas');
    src.width = page.fullBitmap.width;
    src.height = page.fullBitmap.height;
    src.getContext('2d').drawImage(page.fullBitmap, 0, 0);
    const { w, h } = computeOutputSize(page.corners, state.pageFormat, EXPORT_MAX_SIDE);
    let out = warpToCanvas(cv, src, page.corners, w, h);
    src.width = src.height = 0;
    out = applyFilter(cv, out, page.filter);
    out = rotateCanvas(out, page.rotation);

    // JPEG artifacts hit hard text edges harder — use higher quality for B&W.
    const quality = page.filter === 'bw' ? 0.9 : state.jpegQuality;
    const blob = await new Promise((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', quality);
    });
    out.width = out.height = 0;

    const jpg = await doc.embedJpg(await blob.arrayBuffer());
    let pw, ph;
    if (state.pageFormat === 'auto') {
      pw = (jpg.width * 72) / AUTO_DPI;
      ph = (jpg.height * 72) / AUTO_DPI;
    } else {
      const [shortPt, longPt] = PAGE_PTS[state.pageFormat];
      const portrait = jpg.height >= jpg.width;
      pw = portrait ? shortPt : longPt;
      ph = portrait ? longPt : shortPt;
    }
    const pdfPage = doc.addPage([pw, ph]);
    pdfPage.drawImage(jpg, { x: 0, y: 0, width: pw, height: ph });
  }

  const bytes = await doc.save();
  download(new Blob([bytes], { type: 'application/pdf' }));
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
