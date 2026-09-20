// Page formats offered in the "Page size" select (templates/app.html), as
// [short side, long side] in millimetres. 'auto' is not listed: it keeps the
// proportions of the photographed sheet instead of snapping to a format.
//
// Orientation is never stored here. warp.js picks portrait or landscape from
// the measured quad, so a bank card comes out landscape and a letter upright.

export const FORMATS = {
  // ISO paper
  a3: [297, 420],
  a4: [210, 297],
  a5: [148, 210],
  a6: [105, 148],
  b5: [176, 250],
  // US paper
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
  tabloid: [279.4, 431.8],
  // Cards and IDs. 'id-card' is ISO/IEC 7810 ID-1 (bank cards, driving
  // licences, most national ID cards), 'passport' is ID-3 (the data page).
  'id-card': [53.98, 85.6],
  passport: [88, 125],
  'business-card': [55, 85],
  'business-card-us': [50.8, 88.9],
  // Photo prints
  'photo-10x15': [101.6, 152.4],
  'photo-13x18': [127, 177.8],
  'photo-20x25': [203.2, 254],
  // Other
  'envelope-dl': [110, 220],
  'index-card': [76.2, 127],
  'sheet-music': [228.6, 304.8],
  square: [210, 210],
};

const MM_TO_PT = 72 / 25.4;

// Short side / long side, or undefined for 'auto'.
export function formatRatio(id) {
  const mm = FORMATS[id];
  return mm && mm[0] / mm[1];
}

// [short, long] in PDF points, or undefined for 'auto'.
export function formatPoints(id) {
  const mm = FORMATS[id];
  return mm && [mm[0] * MM_TO_PT, mm[1] * MM_TO_PT];
}
