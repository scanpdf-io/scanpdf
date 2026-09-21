// Splitting one photo into two pages (a book spread, two receipts on one
// sheet). Nothing is cut: both halves keep the source photo and get their own
// quad, with the ends of the dividing line as the two shared corners, so the
// usual warp straightens each half and the corners stay adjustable afterwards.
//
// split = { pageId, dir, a, b }
//   dir   'v' => the line runs from the top edge to the bottom edge,
//         'h' => from the left edge to the right edge (as seen in the editor,
//         which shows the unrotated photo)
//   a, b  position of each end along its edge, 0..1. They move independently,
//         which is what lets the line sit at an angle.

export const SPLIT_MIN = 0.02;
export const SPLIT_MAX = 0.98;

const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

/** The two quad edges the ends of the line slide along: [[from, to], [from, to]]. */
export function splitEdges(corners, dir) {
  const [tl, tr, br, bl] = corners;
  return dir === 'v' ? [[tl, tr], [bl, br]] : [[tl, bl], [tr, br]];
}

/** The ends of the dividing line, in the coordinates of `corners`. */
export function splitLine(corners, split) {
  const [ea, eb] = splitEdges(corners, split.dir);
  return [lerp(ea[0], ea[1], split.a), lerp(eb[0], eb[1], split.b)];
}

/**
 * The quads of the two halves, in the reading order of the output: rotation is
 * applied after the warp, so a page turned upside down reads right half first.
 */
export function splitQuads(corners, split, rotation = 0) {
  const [tl, tr, br, bl] = corners.map((c) => ({ ...c }));
  const [p, q] = splitLine(corners, split);
  const copy = (pt) => ({ ...pt });
  const halves = split.dir === 'v'
    ? [[tl, p, q, bl], [copy(p), tr, br, copy(q)]]
    : [[tl, tr, q, p], [copy(p), copy(q), br, bl]];
  const swap = split.dir === 'v'
    ? rotation === 180 || rotation === 270
    : rotation === 90 || rotation === 180;
  return swap ? halves.reverse() : halves;
}

/** Where along the edge e0 -> e1 the point falls, clamped to the allowed range. */
export function projectOnEdge(pt, e0, e1) {
  const dx = e1.x - e0.x;
  const dy = e1.y - e0.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0.5;
  const t = ((pt.x - e0.x) * dx + (pt.y - e0.y) * dy) / len2;
  return Math.min(Math.max(t, SPLIT_MIN), SPLIT_MAX);
}

/** A spread is wider than tall and splits down the middle; a tall sheet across. */
export function defaultDir(corners) {
  const [tl, tr, br, bl] = corners;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const w = Math.max(d(tl, tr), d(bl, br));
  const h = Math.max(d(tl, bl), d(tr, br));
  return w >= h ? 'v' : 'h';
}
