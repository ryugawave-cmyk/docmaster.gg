/**
 * Categorized stamp library + professional SVG stamp renderer.
 *
 * A stamp object carries only DATA — `{ text, style, color }` — and is rendered
 * to SVG on demand by `stampSvgMarkup(obj)`. The same renderer feeds three
 * places: the editable canvas node (blankPdfEditor), the library panel
 * thumbnails (blankEditorShell) and the PDF export rasteriser (pdfExport), so a
 * stamp looks identical wherever it appears.
 *
 * Styles are vector designs sized to a fixed viewBox; the editor resizes stamps
 * with a LOCKED aspect ratio, so `preserveAspectRatio="none"` never distorts the
 * artwork — the box always matches the design's proportions.
 */

/* ------------------------------ SVG helpers ------------------------------ */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FONT = 'font-family="Arial Black, Arial Narrow, Arial, sans-serif" font-weight="800"';

function wrap(w, h, inner) {
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

/** A 5-point star path centred at (cx,cy) with outer radius r. */
function star(cx, cy, r, color) {
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${color}"/>`;
}

function fittedText(x, y, tl, size, color, text, fill) {
  return `<text x="${x}" y="${y}" ${FONT} font-size="${size}" fill="${fill || color}" `
    + `text-anchor="middle" dominant-baseline="central" letter-spacing="0.5" `
    + `textLength="${tl}" lengthAdjust="spacingAndGlyphs">${esc(text)}</text>`;
}

/* ------------------------------ stamp styles ----------------------------- */

function rectStamp(text, color, { double = true, radius = 4, dashed = false } = {}) {
  const W = 300, H = 116, sw = 6;
  const dash = dashed ? ' stroke-dasharray="16 11"' : '';
  const outer = `<rect x="${sw / 2}" y="${sw / 2}" width="${W - sw}" height="${H - sw}" rx="${radius}" `
    + `fill="none" stroke="${color}" stroke-width="${sw}"${dash}/>`;
  const inner = double
    ? `<rect x="${sw + 6}" y="${sw + 6}" width="${W - 2 * (sw + 6)}" height="${H - 2 * (sw + 6)}" `
      + `rx="${Math.max(0, radius - 3)}" fill="none" stroke="${color}" stroke-width="2.5"/>`
    : '';
  const pad = double ? 46 : 34;
  return wrap(W, H, outer + inner + fittedText(W / 2, H / 2, W - pad * 2, 50, color, text));
}

function ribbonStamp(text, color) {
  const W = 330, H = 116, my = 30, x0 = 48, x1 = W - 48;
  const band = `<rect x="${x0}" y="${my}" width="${x1 - x0}" height="${H - 2 * my}" fill="${color}"/>`;
  const tail = (bx, dir) =>
    `<path d="M${bx} ${my} L${bx + dir * 34} ${my} L${bx + dir * 16} ${H / 2} L${bx + dir * 34} ${H - my} L${bx} ${H - my} Z" `
    + `fill="${color}" opacity="0.72"/>`;
  const txt = fittedText(W / 2, H / 2, x1 - x0 - 34, 40, color, text, '#ffffff');
  return wrap(W, H, tail(x0, -1) + tail(x1, 1) + band + txt);
}

function sealStamp(text, color) {
  const S = 210, c = S / 2;
  const rings = `<circle cx="${c}" cy="${c}" r="98" fill="none" stroke="${color}" stroke-width="6"/>`
    + `<circle cx="${c}" cy="${c}" r="82" fill="none" stroke="${color}" stroke-width="2.5"/>`;
  const stars = star(c, 28, 11, color) + star(c, S - 28, 11, color);
  const dots = `<circle cx="30" cy="${c}" r="3.4" fill="${color}"/><circle cx="${S - 30}" cy="${c}" r="3.4" fill="${color}"/>`;
  return wrap(S, S, rings + stars + dots + fittedText(c, c, 124, 34, color, text));
}

/** Public: render a stamp object's SVG markup (used on-canvas, in the panel and export). */
export function stampSvgMarkup(obj) {
  const color = obj.color || '#dc2626';
  const text = (obj.text || '').toUpperCase();
  switch (obj.style) {
    case 'rect': return rectStamp(text, color, { double: false });
    case 'rounded': return rectStamp(text, color, { double: true, radius: 18 });
    case 'dashed': return rectStamp(text, color, { double: false, dashed: true });
    case 'ribbon': return ribbonStamp(text, color);
    case 'seal': return sealStamp(text, color);
    case 'double':
    default: return rectStamp(text, color, { double: true });
  }
}

/** Natural pixel box for a style (kept proportional to its viewBox). */
export function stampSize(style) {
  if (style === 'seal') return { w: 148, h: 148 };
  if (style === 'ribbon') return { w: 190, h: 68 };
  return { w: 182, h: 70 };
}

/** Build a ready-to-insert stamp definition from a label + style + colour. */
export function makeStampDef(text, style = 'double', color = '#dc2626') {
  const { w, h } = stampSize(style);
  return { text, style, color, w, h };
}

/* ---------------------------- library contents --------------------------- */

const GREEN = '#059669';
const RED = '#dc2626';
const AMBER = '#d97706';
const BLUE = '#2563eb';
const SLATE = '#475569';

// Each entry: [label, style, color]
const CATEGORIES = [
  {
    id: 'office', name: 'Office', items: [
      ['APPROVED', 'double', GREEN], ['REJECTED', 'double', RED],
      ['PAID', 'double', GREEN], ['RECEIVED', 'double', BLUE],
      ['REVIEWED', 'double', BLUE], ['VERIFIED', 'seal', GREEN],
      ['COMPLETED', 'double', GREEN], ['FINAL', 'rect', SLATE],
      ['DRAFT', 'dashed', AMBER], ['VOID', 'double', RED],
    ],
  },
  {
    id: 'business', name: 'Business', items: [
      ['CONFIDENTIAL', 'ribbon', RED], ['URGENT', 'ribbon', RED],
      ['COPY', 'rect', SLATE], ['ORIGINAL', 'double', BLUE],
      ['CANCELLED', 'double', RED], ['PENDING', 'dashed', AMBER],
      ['ARCHIVED', 'rect', SLATE], ['PROCESSED', 'double', GREEN],
      ['INVOICE PAID', 'double', GREEN], ['REFUNDED', 'double', BLUE],
    ],
  },
  {
    id: 'qa', name: 'QA / Inspection', items: [
      ['PASSED', 'seal', GREEN], ['FAILED', 'seal', RED],
      ['QC APPROVED', 'seal', GREEN], ['INSPECTED', 'seal', BLUE],
      ['TESTED', 'seal', BLUE],
    ],
  },
  {
    id: 'gov', name: 'Government', items: [
      ['CERTIFIED', 'seal', GREEN], ['AUTHORIZED', 'seal', BLUE],
      ['OFFICIAL', 'seal', SLATE], ['REGISTERED', 'seal', BLUE],
      ['NOTARIZED', 'seal', SLATE],
    ],
  },
];

/** Categorised library: `[{ id, name, stamps: [def, …] }]`. */
export const STAMP_CATEGORIES = CATEGORIES.map((c) => ({
  id: c.id,
  name: c.name,
  stamps: c.items.map(([text, style, color]) => makeStampDef(text, style, color)),
}));

/** Flat list of every built-in stamp def. */
export const ALL_STAMPS = STAMP_CATEGORIES.flatMap((c) => c.stamps);
