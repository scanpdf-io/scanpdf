// Automatic paper-sheet corner detection. Runs on the downscaled procCanvas;
// the caller scales results back to full-resolution coordinates.
//
// Several binarization strategies run in parallel (edges, brightness Otsu,
// low-saturation mask, adaptive threshold); every plausible quadrilateral
// candidate is scored and the best one wins. This is much more robust on real
// photos (paper on a wooden desk, soft shadows, another sheet peeking out)
// than a single Canny pass.

const MIN_AREA_FRAC = 0.15; // sheet must cover >= 15% of the frame
const MAX_AREA_FRAC = 0.995;

// Every cv.Mat / cv.MatVector allocated through track() is deleted on exit —
// OpenCV.js WASM memory is not garbage-collected.
export function withMats(fn) {
  const mats = [];
  const track = (m) => {
    mats.push(m);
    return m;
  };
  try {
    return fn(track);
  } finally {
    for (const m of mats) {
      try {
        m.delete();
      } catch (_) {
        /* already deleted */
      }
    }
  }
}

export function fallbackCorners(w, h, inset = 0.05) {
  const ix = w * inset;
  const iy = h * inset;
  return [
    { x: ix, y: iy },
    { x: w - ix, y: iy },
    { x: w - ix, y: h - iy },
    { x: ix, y: h - iy },
  ];
}

// Returns { ok, corners: [TL, TR, BR, BL] } in procCanvas coordinates.
// Pass an array as `debug` to collect every scored candidate (for tuning).
export function detectCorners(cv, procCanvas, debug) {
  const W = procCanvas.width;
  const H = procCanvas.height;
  const frameArea = W * H;

  const best = withMats((track) => {
    const src = track(cv.imread(procCanvas));
    const gray = track(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = track(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const k3 = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
    const k5 = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5)));
    const binaries = [];

    // A: edges, thresholds derived from overall brightness. Dilation closes
    // small gaps in the page outline.
    const mean = cv.mean(blur)[0];
    const edgesSharp = track(new cv.Mat()); // undilated copy for line ranking
    cv.Canny(blur, edgesSharp, Math.max(10, 0.66 * mean), Math.min(255, 1.33 * mean));
    const edges = track(new cv.Mat());
    cv.dilate(edgesSharp, edges, k3, new cv.Point(-1, -1), 2);
    binaries.push(edges);

    // A2: much more sensitive edges — catches faint paper-on-paper borders
    // (a sheet lying on another sheet), at the cost of extra noise. Candidates
    // are still filtered by geometry + edge support, so noise is survivable.
    const edgesLow = track(new cv.Mat());
    cv.Canny(blur, edgesLow, Math.max(5, 0.2 * mean), Math.max(15, 0.55 * mean));
    cv.dilate(edgesLow, edgesLow, k3, new cv.Point(-1, -1), 2);
    binaries.push(edgesLow);

    // B: brightness Otsu — paper is usually the brightest large blob.
    const otsu = track(new cv.Mat());
    cv.threshold(blur, otsu, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(otsu, otsu, cv.MORPH_CLOSE, k5);
    binaries.push(otsu);

    // C: low saturation AND high value — paper is colorless and bright,
    // desks/tables are usually colored (wood, cloth). Very effective when
    // brightness alone doesn't separate the sheet.
    const rgb = track(new cv.Mat());
    const hsv = track(new cv.Mat());
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const ch = track(new cv.MatVector());
    cv.split(hsv, ch);
    const sat = track(ch.get(1));
    const val = track(ch.get(2));
    const satMask = track(new cv.Mat());
    const valMask = track(new cv.Mat());
    const paperMask = track(new cv.Mat());
    cv.threshold(sat, satMask, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    cv.threshold(val, valMask, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.bitwise_and(satMask, valMask, paperMask);
    cv.morphologyEx(paperMask, paperMask, cv.MORPH_CLOSE, k5);
    binaries.push(paperMask);

    // D: adaptive threshold — last resort for low-contrast scenes.
    const ad = track(new cv.Mat());
    cv.adaptiveThreshold(blur, ad, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 31, 10);
    cv.morphologyEx(ad, ad, cv.MORPH_CLOSE, k3);
    binaries.push(ad);

    const labels = ['edges', 'edgesLow', 'otsu', 'saturation', 'adaptive'];
    let winner = null;
    binaries.forEach((bin, bi) => {
      // Support is measured against the sensitive edge map: it also contains
      // faint paper-on-paper borders, while smooth paper stays empty.
      for (const cand of candidatesFrom(cv, bin, frameArea, edgesLow, track)) {
        if (debug) debug.push({ ...cand, strategy: labels[bi] });
        if (!winner || cand.score > winner.score) winner = cand;
      }
    });

    // Hough-line candidates: edges are fitted independently as straight lines
    // and corners come from their intersections. Survives broken outlines and
    // occluded corners, where contour-based candidates fall apart.
    for (const em of [edges, edgesLow]) {
      for (const quad of lineQuadCandidates(cv, em, edgesSharp, W, H, track)) {
        const cand = scoreQuad(orderCorners(quad), frameArea, edgesLow);
        if (!cand) continue;
        if (debug) debug.push({ ...cand, strategy: 'hough' });
        if (!winner || cand.score > winner.score) winner = cand;
      }
    }

    // Final refinement: tuck each side inward until no background pixels are
    // enclosed — matters when a sheet edge is not perfectly straight (curled
    // paper), where the best straight line still clips the background.
    if (winner) {
      const refMask = track(new cv.Mat());
      cv.bitwise_or(otsu, paperMask, refMask);
      winner = { ...winner, corners: shrinkToPaper(winner.corners, refMask, W, H) };
    }
    return winner;
  });

  if (best) return { ok: true, corners: best.corners };
  return { ok: false, corners: fallbackCorners(W, H) };
}

// ---------- Hough-line candidates ----------

// Detects long near-horizontal / near-vertical segments, keeps the strongest
// distinct lines per side of the frame, and emits every top×bottom×left×right
// intersection quad. Geometry filtering + scoring happens in scoreQuad.
function lineQuadCandidates(cv, edgeMap, sharpMap, W, H, track) {
  const minDim = Math.min(W, H);
  const linesMat = track(new cv.Mat());
  // Small maxLineGap on purpose: a generous gap chains text rows into long
  // bogus diagonals. Real edges broken by glare still surface as separate
  // segments that collapse into one line via rho/angle dedup below.
  cv.HoughLinesP(edgeMap, linesMat, 1, Math.PI / 180, 50, minDim * 0.25, minDim * 0.025);

  const horiz = [];
  const vert = [];
  for (let i = 0; i < linesMat.rows; i++) {
    const x1 = linesMat.data32S[i * 4];
    const y1 = linesMat.data32S[i * 4 + 1];
    const x2 = linesMat.data32S[i * 4 + 2];
    const y2 = linesMat.data32S[i * 4 + 3];
    const len = Math.hypot(x2 - x1, y2 - y1);
    let ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
    if (ang < 0) ang += 180;
    const seg = { x1, y1, x2, y2, len, ang };
    if ((ang <= 35 || ang >= 145) && len >= W * 0.3) horiz.push(seg);
    else if (ang >= 55 && ang <= 125 && len >= H * 0.3) vert.push(seg);
  }

  // A real sheet edge is a continuous crisp line; accidental Hough chains
  // (through text, texture) mostly cross smooth paper. Rank lines by their
  // own support on the undilated edge map, not by raw length.
  const segQuality = (s) => {
    const steps = Math.max(10, Math.floor(s.len / 3));
    const { cols, rows, data } = sharpMap;
    let hits = 0;
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(s.x1 + ((s.x2 - s.x1) * i) / steps);
      const y = Math.round(s.y1 + ((s.y2 - s.y1) * i) / steps);
      let found = false;
      for (let dy = -2; dy <= 2 && !found; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rows) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < cols && data[yy * cols + xx]) {
            found = true;
            break;
          }
        }
      }
      if (found) hits++;
    }
    return hits / (steps + 1);
  };

  // Collapse near-identical lines (same angle & offset), keep the strongest.
  const dedupe = (segs) => {
    const seen = new Map();
    for (const s of segs) {
      s.support = segQuality(s);
      if (s.support < 0.35) continue;
      s.rank = s.len * s.support * s.support;
      const nx = -(s.y2 - s.y1);
      const ny = s.x2 - s.x1;
      const nlen = Math.hypot(nx, ny) || 1;
      const rho = Math.abs((s.x1 * nx + s.y1 * ny) / nlen);
      const key = `${Math.round(s.ang / 4)}:${Math.round(rho / (minDim * 0.02))}`;
      const prev = seen.get(key);
      if (!prev || s.rank > prev.rank) seen.set(key, s);
    }
    return [...seen.values()].sort((a, b) => b.rank - a.rank);
  };

  const hs = dedupe(horiz);
  const vs = dedupe(vert);
  const midY = (s) => (s.y1 + s.y2) / 2;
  const midX = (s) => (s.x1 + s.x2) / 2;
  const tops = hs.filter((s) => midY(s) < H * 0.5).slice(0, 6);
  const bottoms = hs.filter((s) => midY(s) >= H * 0.5).slice(0, 6);
  const lefts = vs.filter((s) => midX(s) < W * 0.5).slice(0, 6);
  const rights = vs.filter((s) => midX(s) >= W * 0.5).slice(0, 6);

  const quads = [];
  for (const t of tops) {
    for (const b of bottoms) {
      for (const l of lefts) {
        for (const r of rights) {
          const tl = lineIntersect(t, l);
          const tr = lineIntersect(t, r);
          const br = lineIntersect(b, r);
          const bl = lineIntersect(b, l);
          if (!tl || !tr || !br || !bl) continue;
          const pts = [tl, tr, br, bl];
          // Corners may lie slightly outside the frame (occluded corner), but
          // far-out intersections are degenerate.
          if (pts.some((p) => p.x < -W * 0.06 || p.x > W * 1.06 || p.y < -H * 0.06 || p.y > H * 1.06)) continue;
          quads.push(pts.map((p) => ({
            x: Math.min(Math.max(p.x, 0), W - 1),
            y: Math.min(Math.max(p.y, 0), H - 1),
          })));
        }
      }
    }
  }
  return quads;
}

// Intersection of the infinite lines through two segments.
function lineIntersect(s1, s2) {
  const d = (s1.x1 - s1.x2) * (s2.y1 - s2.y2) - (s1.y1 - s1.y2) * (s2.x1 - s2.x2);
  if (Math.abs(d) < 1e-9) return null;
  const a = s1.x1 * s1.y2 - s1.y1 * s1.x2;
  const b = s2.x1 * s2.y2 - s2.y1 * s2.x2;
  return {
    x: (a * (s2.x1 - s2.x2) - (s1.x1 - s1.x2) * b) / d,
    y: (a * (s2.y1 - s2.y2) - (s1.y1 - s1.y2) * b) / d,
  };
}

// ---------- inward refinement ----------

// Moves each quad side inward (along its normal) until the strip just inside
// the side is paper according to the mask, so a curled or bowed sheet edge
// never leaves background inside the frame. Uses a high percentile of the
// per-sample penetration depths (robust to mask noise) and caps the inset.
function shrinkToPaper(corners, mask, W, H) {
  const data = mask.data;
  const isPaper = (x, y) => {
    const xx = Math.round(x);
    const yy = Math.round(y);
    if (xx < 0 || yy < 0 || xx >= W || yy >= H) return false;
    return data[yy * W + xx] > 0;
  };

  // If the mask does not even recognize the quad interior as paper (dark or
  // colored documents), refinement would be destructive — skip it.
  let inPaper = 0;
  let total = 0;
  for (let si = 0.3; si <= 0.7; si += 0.1) {
    for (let ti = 0.3; ti <= 0.7; ti += 0.1) {
      const topX = corners[0].x + (corners[1].x - corners[0].x) * si;
      const topY = corners[0].y + (corners[1].y - corners[0].y) * si;
      const botX = corners[3].x + (corners[2].x - corners[3].x) * si;
      const botY = corners[3].y + (corners[2].y - corners[3].y) * si;
      total++;
      if (isPaper(topX + (botX - topX) * ti, topY + (botY - topY) * ti)) inPaper++;
    }
  }
  if (inPaper / total < 0.6) return corners;

  const maxInset = 0.05 * Math.min(W, H);
  const sides = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len; // inward normal for clockwise TL,TR,BR,BL order
    const ny = dx / len;

    const depths = [];
    const S = 28;
    for (let s = 2; s < S - 1; s++) {
      const t = s / S;
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      let d = maxInset;
      for (let m = 0; m <= maxInset; m += 1.5) {
        if (isPaper(px + nx * (m + 1), py + ny * (m + 1)) && isPaper(px + nx * (m + 3), py + ny * (m + 3))) {
          d = m;
          break;
        }
      }
      depths.push(d);
    }
    depths.sort((p, q) => p - q);
    const inset = depths.length ? depths[Math.min(depths.length - 1, Math.floor(depths.length * 0.95))] : 0;
    sides.push({ x1: a.x + nx * inset, y1: a.y + ny * inset, x2: b.x + nx * inset, y2: b.y + ny * inset });
  }

  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = lineIntersect(sides[(i + 3) % 4], sides[i]);
    out.push(p ? {
      x: Math.min(Math.max(p.x, 0), W - 1),
      y: Math.min(Math.max(p.y, 0), H - 1),
    } : corners[i]);
  }
  return out;
}

// Plausible quads in one binary image: largest contours -> convex hull ->
// polygon approximation with an escalating tolerance ladder; if the hull
// refuses to collapse to 4 vertices, fall back to its 4 extreme points.
function candidatesFrom(cv, binary, frameArea, edgeMap, track) {
  const out = [];
  const contours = track(new cv.MatVector());
  const hierarchy = track(new cv.Mat());
  cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  const items = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = track(contours.get(i));
    const area = cv.contourArea(c);
    if (area >= frameArea * MIN_AREA_FRAC) items.push({ c, area });
  }
  items.sort((a, b) => b.area - a.area);

  for (const { c } of items.slice(0, 10)) {
    const hull = track(new cv.Mat());
    cv.convexHull(c, hull);
    const peri = cv.arcLength(hull, true);

    let quad = null;
    for (const eps of [0.02, 0.032, 0.05, 0.08]) {
      const approx = track(new cv.Mat());
      cv.approxPolyDP(hull, approx, eps * peri, true);
      if (approx.rows === 4) {
        quad = ptsFromMat(approx);
        break;
      }
    }
    if (!quad) quad = ptsFromMat(hull); // extreme points via orderCorners

    const cand = scoreQuad(orderCorners(quad), frameArea, edgeMap);
    if (cand) out.push(cand);
  }
  return out;
}

function ptsFromMat(mat) {
  const pts = [];
  for (let i = 0; i < mat.rows; i++) {
    pts.push({ x: mat.data32S[i * 2], y: mat.data32S[i * 2 + 1] });
  }
  return pts;
}

// Geometric sanity checks + score. Area dominates; corner angles far from 90°
// reduce the score; a quad hugging the whole frame is penalized so that a
// genuine interior sheet wins whenever one was found. Edge support — the
// fraction of the quad's perimeter lying on real luminance edges — separates
// the true sheet outline from segmentation artifacts (e.g. the convex union
// of two overlapping sheets, whose hull partly crosses smooth paper).
function scoreQuad(corners, frameArea, edgeMap) {
  const area = polyArea(corners);
  if (area < frameArea * MIN_AREA_FRAC || area > frameArea * MAX_AREA_FRAC) return null;

  const minSide = Math.sqrt(frameArea) * 0.08;
  let angleQuality = 1;
  for (let i = 0; i < 4; i++) {
    const p = corners[(i + 3) % 4];
    const q = corners[i];
    const r = corners[(i + 1) % 4];
    if (Math.hypot(q.x - r.x, q.y - r.y) < minSide) return null;
    const a1 = Math.atan2(p.y - q.y, p.x - q.x);
    const a2 = Math.atan2(r.y - q.y, r.x - q.x);
    let ang = (Math.abs(a1 - a2) * 180) / Math.PI;
    if (ang > 180) ang = 360 - ang;
    if (ang < 35 || ang > 145) return null;
    angleQuality *= 1 - (Math.abs(ang - 90) / 90) * 0.5;
  }

  const support = edgeSupport(corners, edgeMap);
  const supportFactor = 0.03 + 0.97 * support ** 4;
  const fullFramePenalty = area > frameArea * 0.94 ? 0.55 : 1;
  return {
    corners,
    score: area * angleQuality * fullFramePenalty * supportFactor,
    areaFrac: area / frameArea,
    support,
    angleQuality,
  };
}

// Fraction of points sampled along the quad perimeter that have a pixel of
// the (dilated) Canny edge map within a small search window — the window
// absorbs the 1–3px offset between a contour hull and the edge centerline.
function edgeSupport(corners, edgeMap) {
  const { cols, rows, data } = edgeMap;
  const R = 3;
  let hits = 0;
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const steps = Math.max(8, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 4));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(a.x + ((b.x - a.x) * s) / steps);
      const y = Math.round(a.y + ((b.y - a.y) * s) / steps);
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      total++;
      let found = false;
      for (let dy = -R; dy <= R && !found; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= rows) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= cols) continue;
          if (data[yy * cols + xx]) {
            found = true;
            break;
          }
        }
      }
      if (found) hits++;
    }
  }
  return total ? hits / total : 0;
}

function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

// Canonical order for a roughly axis-aligned quad; on a hull with more than
// 4 points this picks the 4 extreme corners:
// TL = min(x+y), BR = max(x+y), TR = min(y−x), BL = max(y−x).
function orderCorners(pts) {
  const tl = pts.reduce((a, b) => (a.x + a.y <= b.x + b.y ? a : b));
  const br = pts.reduce((a, b) => (a.x + a.y >= b.x + b.y ? a : b));
  const tr = pts.reduce((a, b) => (a.y - a.x <= b.y - b.x ? a : b));
  const bl = pts.reduce((a, b) => (a.y - a.x >= b.y - b.x ? a : b));
  return [tl, tr, br, bl];
}
