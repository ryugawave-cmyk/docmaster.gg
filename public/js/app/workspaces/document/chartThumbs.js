/**
 * Professional Library — premium chart PREVIEW thumbnails.
 *
 * These are PREVIEWS ONLY. They are deliberately separate from the real chart
 * engine (`editor/chartRender.js`): inserting a chart still builds a real editable
 * chart object from `defaultChart(id)` + `renderChartSvg` — the preview image is
 * never used as the inserted chart. This module just makes the library tiles look
 * like premium 3D office-software thumbnails (extrusion, perspective, soft shadows,
 * gradient shading, highlighted edges) for the types that warrant it, while normal
 * 2D charts stay clean and modern.
 *
 * The original chart families have bespoke premium thumbs (below). The EXTENDED library
 * families (financial / business / statistical / hierarchy / project) preview through the
 * REAL engine at thumbnail size, so their tile matches exactly what gets inserted.
 */
import { renderChartSvg, sampleChart } from '../../editor/chartRender.js';

// Consistent preview canvas — every tile shares this viewBox, camera angle,
// lighting and margins so the grid reads as one cohesive, polished set.
export const THUMB_VIEW = { w: 200, h: 128 };

// Professional business palette (blue / orange / yellow / green / red / purple /
// gray) — saturated enough to look colourful, muted enough to look professional.
const PALETTE = ['#4E79C6', '#ED8B4B', '#F4C445', '#5FA65F', '#D9534F', '#8E6FC0', '#8A94A6'];

// The "3D" badge is shown for every genuinely-3D chart TYPE (all such ids end "3d").
export const isThumb3D = (id) => /3d$/i.test(id);

/* -------------------------------- colour utils ---------------------------- */
const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
const hx = (n) => clamp(n).toString(16).padStart(2, '0');
function shade(hex, amt) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= (1 + amt); g *= (1 + amt); b *= (1 + amt); }
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}
const lighten = (c, a) => shade(c, a);
const darken = (c, a) => shade(c, -a);
const r2 = (n) => Math.round(n * 100) / 100;

/* --------------------------------- defs pool ------------------------------ */
function makeDefs() {
  const items = [];
  let seq = 0;
  const id = () => `t${seq++}`;
  return {
    // vertical light→dark gradient (top-lit surfaces)
    vgrad(c0, c1) { const i = id(); items.push(`<linearGradient id="${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></linearGradient>`); return `url(#${i})`; },
    hgrad(c0, c1) { const i = id(); items.push(`<linearGradient id="${i}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></linearGradient>`); return `url(#${i})`; },
    radial(c0, c1) { const i = id(); items.push(`<radialGradient id="${i}" cx="0.35" cy="0.3" r="0.85"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></radialGradient>`); return `url(#${i})`; },
    raw(s) { items.push(s); },
    render() { return items.length ? `<defs>${items.join('')}</defs>` : ''; },
  };
}

/** A soft contact shadow on the "floor" beneath a 3D object. */
function floorShadow(cx, cy, rx, ry = rx * 0.28) {
  return `<ellipse cx="${r2(cx)}" cy="${r2(cy)}" rx="${r2(rx)}" ry="${r2(ry)}" fill="#0b1220" opacity="0.16" filter="url(#blur)"/>`;
}

const svgWrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${THUMB_VIEW.w} ${THUMB_VIEW.h}" preserveAspectRatio="xMidYMid meet" font-family="Inter, Arial, sans-serif">${inner}</svg>`;

/* --------------------------------- polar ---------------------------------- */
const cosd = (d) => Math.cos((d * Math.PI) / 180);
const sind = (d) => Math.sin((d * Math.PI) / 180);
const ptOnEllipse = (cx, cy, rx, ry, deg) => [cx + rx * cosd(deg), cy + ry * sind(deg)];

/* ============================ pie / doughnut ============================== */
// strength: 0 = flat premium 2D disc; 1 = moderate 3D; 2 = strong 3D.
function thumbPie(typeId, { strength = 0, doughnut = false, explode = false } = {}) {
  const defs = makeDefs();
  defs.raw('<filter id="blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.4"/></filter>');
  const cx = 100, rx = strength ? 52 : 48;
  const ry = strength ? rx * 0.6 : rx;              // squash → tilt/perspective
  const cy = strength ? 58 : 64;
  const depth = strength === 2 ? 18 : strength === 1 ? 12 : 0;
  const innerR = doughnut ? rx * 0.5 : 0;
  const innerRy = doughnut ? ry * 0.5 : 0;

  const fracs = [0.30, 0.24, 0.19, 0.15, 0.12];
  const start = -128;
  const ranges = [];
  let acc = 0;
  fracs.forEach((f, i) => { const a0 = start + acc * 360; acc += f; const a1 = start + acc * 360; ranges.push({ a0, a1, mid: (a0 + a1) / 2, c: PALETTE[i] }); });

  const explodeVec = (mid) => {
    if (!explode) return [0, 0];
    const off = 8;
    return [off * cosd(mid), off * sind(mid) * (ry / rx)];
  };

  const parts = [];
  // Floor contact shadow.
  if (strength) parts.push(floorShadow(cx, cy + ry + depth + 4, rx * 1.02));

  // Front extruded walls (only the front semicircle, t∈[0,180]) built by stepping
  // so each slice keeps its own darker side colour — reads as a solid 3D disc.
  if (strength) {
    const step = 4;
    const relOf = (a) => ((a - start) % 360 + 360) % 360;
    const colorAt = (a) => {
      const rel = relOf(a);
      for (const s of ranges) { if (rel >= relOf(s.a0) - 0.001 && rel < relOf(s.a0) + (s.a1 - s.a0)) return s; }
      return ranges[ranges.length - 1];
    };
    const wall = (rr, ry2, tone) => {
      for (let a = 0; a < 180; a += step) {
        const b = Math.min(180, a + step);
        const s = colorAt((a + b) / 2);
        const [ox, oy] = explodeVec(s.mid);
        const [x0, y0] = ptOnEllipse(cx + ox, cy + oy, rr, ry2, a);
        const [x1, y1] = ptOnEllipse(cx + ox, cy + oy, rr, ry2, b);
        const g = defs.vgrad(darken(s.c, tone), darken(s.c, tone + 0.22));
        parts.push(`<path d="M ${r2(x0)} ${r2(y0)} L ${r2(x1)} ${r2(y1)} L ${r2(x1)} ${r2(y1 + depth)} L ${r2(x0)} ${r2(y0 + depth)} Z" fill="${g}"/>`);
      }
    };
    wall(rx, ry, 0.16);                        // outer wall
    if (doughnut) wall(innerR, innerRy, 0.30); // inner wall (darker) for the hole
  }

  // Top faces (bright, gradient-shaded), with white separators for crisp slices.
  for (const s of ranges) {
    const [ox, oy] = explodeVec(s.mid);
    const large = (s.a1 - s.a0) > 180 ? 1 : 0;
    const [x0, y0] = ptOnEllipse(cx + ox, cy + oy, rx, ry, s.a0);
    const [x1, y1] = ptOnEllipse(cx + ox, cy + oy, rx, ry, s.a1);
    const fill = defs.vgrad(lighten(s.c, strength ? 0.24 : 0.16), strength ? s.c : darken(s.c, 0.04));
    let d;
    if (doughnut) {
      const [ix1, iy1] = ptOnEllipse(cx + ox, cy + oy, innerR, innerRy, s.a1);
      const [ix0, iy0] = ptOnEllipse(cx + ox, cy + oy, innerR, innerRy, s.a0);
      d = `M ${r2(x0)} ${r2(y0)} A ${rx} ${ry} 0 ${large} 1 ${r2(x1)} ${r2(y1)} L ${r2(ix1)} ${r2(iy1)} A ${innerR} ${innerRy} 0 ${large} 0 ${r2(ix0)} ${r2(iy0)} Z`;
    } else {
      d = `M ${r2(cx + ox)} ${r2(cy + oy)} L ${r2(x0)} ${r2(y0)} A ${rx} ${ry} 0 ${large} 1 ${r2(x1)} ${r2(y1)} Z`;
    }
    parts.push(`<path d="${d}" fill="${fill}" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>`);
  }

  // Glossy top highlight (subtle reflection on the bright surface).
  const hl = defs.radial('rgba(255,255,255,0.55)', 'rgba(255,255,255,0)');
  parts.push(`<ellipse cx="${cx - rx * 0.22}" cy="${cy - ry * 0.34}" rx="${r2(rx * 0.7)}" ry="${r2(ry * 0.5)}" fill="${hl}" opacity="0.7"/>`);

  return svgWrap(defs.render() + parts.join(''));
}

/* =============================== columns ================================== */
// variant: 'simple' | 'clustered' | 'stacked' | 'pct' — each gets a distinct
// silhouette so the library reads as varied, not repeated. `d3` = extruded 3D.
function thumbColumn(typeId, { variant = 'simple', d3 = false } = {}) {
  const defs = makeDefs();
  defs.raw('<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-color="#0b1220" flood-opacity="0.15"/></filter>');
  const base = 104, left = 30, right = 186;
  const parts = [gridAndAxis(defs, left, right, base, d3 ? 26 : 20)];

  if (d3) {
    const dx = 10, dy = -7;
    if (variant === 'clustered') {
      const groups = [[46, 32], [68, 52], [56, 40], [82, 62]];
      const n = groups.length, slot = (right - left) / n, gW = slot * 0.6, bw = gW / 2 - 1;
      groups.forEach((gv, i) => {
        const gx = left + slot * i + (slot - gW) / 2;
        parts.push(box3d(defs, gx, base - gv[0], bw, gv[0], PALETTE[0], dx, dy));
        parts.push(box3d(defs, gx + bw + 2, base - gv[1], bw, gv[1], PALETTE[1], dx, dy));
      });
    } else if (variant === 'stacked' || variant === 'pct') {
      const cols = variant === 'pct'
        ? [[0.5, 0.3, 0.2], [0.4, 0.35, 0.25], [0.55, 0.25, 0.2], [0.45, 0.3, 0.25], [0.5, 0.28, 0.22]].map((p) => p.map((f) => f * (base - 30)))
        : [[24, 18, 10], [30, 22, 14], [26, 16, 12], [34, 24, 16], [28, 20, 12]];
      const n = cols.length, slot = (right - left) / n, bw = slot * 0.5;
      cols.forEach((segs, i) => {
        const x = left + slot * i + (slot - bw) / 2; let yb = base;
        segs.forEach((h, k) => { yb -= h; parts.push(box3d(defs, x, yb, bw, h, PALETTE[k], dx, dy, k === segs.length - 1)); });
      });
    } else {
      const n = 5, H = [42, 66, 54, 80, 60], slot = (right - left) / n, bw = slot * 0.52;
      for (let i = 0; i < n; i += 1) parts.push(box3d(defs, left + slot * i + (slot - bw) / 2, base - H[i], bw, H[i], PALETTE[i % PALETTE.length], dx, dy));
    }
    return svgWrap(defs.render() + parts.join(''));
  }

  // One column = a stack of {h, c} segments (bottom→top) sharing a soft shadow.
  const drawCol = (x, w, segs) => {
    let y = base; const rects = [];
    segs.forEach((s, idx) => {
      y -= s.h;
      const g = defs.vgrad(lighten(s.c, 0.22), s.c);
      rects.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(s.h)}" ${idx === segs.length - 1 ? 'rx="2.5"' : ''} fill="${g}"/>`);
    });
    rects.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="3" rx="1.5" fill="rgba(255,255,255,0.5)"/>`);
    parts.push(`<g filter="url(#soft)">${rects.join('')}</g>`);
  };

  if (variant === 'clustered') {
    const groups = [[46, 32], [68, 52], [56, 40], [82, 62]];
    const n = groups.length, slot = (right - left) / n, gW = slot * 0.62, bw = gW / 2 - 1;
    groups.forEach((g, i) => {
      const gx = left + slot * i + (slot - gW) / 2;
      drawCol(gx, bw, [{ h: g[0], c: PALETTE[0] }]);
      drawCol(gx + bw + 2, bw, [{ h: g[1], c: PALETTE[1] }]);
    });
  } else if (variant === 'stacked') {
    const cols = [[24, 18, 10], [30, 22, 14], [26, 16, 12], [34, 24, 16], [28, 20, 12]];
    const n = cols.length, slot = (right - left) / n, bw = slot * 0.56;
    cols.forEach((segH, i) => drawCol(left + slot * i + (slot - bw) / 2, bw, segH.map((h, k) => ({ h, c: PALETTE[k] }))));
  } else if (variant === 'pct') {
    const FH = base - 22;
    const props = [[0.5, 0.3, 0.2], [0.4, 0.35, 0.25], [0.55, 0.25, 0.2], [0.45, 0.3, 0.25], [0.5, 0.28, 0.22]];
    const n = props.length, slot = (right - left) / n, bw = slot * 0.56;
    props.forEach((p, i) => drawCol(left + slot * i + (slot - bw) / 2, bw, p.map((f, k) => ({ h: f * FH, c: PALETTE[k] }))));
  } else {
    const H = [42, 66, 54, 80, 60], n = H.length, slot = (right - left) / n, bw = slot * 0.6;
    H.forEach((h, i) => drawCol(left + slot * i + (slot - bw) / 2, bw, [{ h, c: PALETTE[i % PALETTE.length] }]));
  }
  return svgWrap(defs.render() + parts.join(''));
}

/* ================================= bars =================================== */
function thumbBar(typeId, { variant = 'simple', d3 = false } = {}) {
  const defs = makeDefs();
  defs.raw('<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="1.5" flood-color="#0b1220" flood-opacity="0.15"/></filter>');
  const axisX = 34, top = 20, bottom = 108, right = 186;
  const parts = [`<line x1="${axisX}" y1="${top - 4}" x2="${axisX}" y2="${bottom + 4}" stroke="#cbd5e1" stroke-width="1.2"/>`];

  if (d3) {
    const dx = 9, dy = -7;
    if (variant === 'clustered') {
      const groups = [[150, 108], [96, 132], [128, 80]];
      const n = groups.length, slot = (bottom - top) / n, gH = slot * 0.6, bh = gH / 2 - 1;
      groups.forEach((gv, i) => {
        const gy = top + slot * i + (slot - gH) / 2;
        parts.push(barBox3d(defs, axisX, gy, gv[0], bh, PALETTE[0], dx, dy));
        parts.push(barBox3d(defs, axisX, gy + bh + 2, gv[1], bh, PALETTE[1], dx, dy));
      });
    } else if (variant === 'stacked' || variant === 'pct') {
      const bars = variant === 'pct'
        ? [[0.5, 0.3, 0.2], [0.4, 0.35, 0.25], [0.55, 0.25, 0.2], [0.45, 0.3, 0.25]].map((p) => p.map((f) => f * (right - axisX)))
        : [[70, 50, 30], [46, 34, 20], [60, 42, 26], [38, 26, 14]];
      const n = bars.length, slot = (bottom - top) / n, bh = slot * 0.5;
      bars.forEach((segs, i) => {
        const y = top + slot * i + (slot - bh) / 2; let x = axisX;
        segs.forEach((w, k) => { parts.push(barBox3d(defs, x, y, w, bh, PALETTE[k], dx, dy, k === segs.length - 1)); x += w; });
      });
    } else {
      const n = 4, W = [150, 96, 128, 72], slot = (bottom - top) / n, bh = slot * 0.5;
      for (let i = 0; i < n; i += 1) parts.push(barBox3d(defs, axisX, top + slot * i + (slot - bh) / 2, W[i], bh, PALETTE[i % PALETTE.length], dx, dy));
    }
    return svgWrap(defs.render() + parts.join(''));
  }

  // One bar = a row of {w, c} segments (left→right) sharing a soft shadow.
  const drawBar = (y, h, segs) => {
    let x = axisX; const rects = [];
    segs.forEach((s, idx) => {
      const g = defs.hgrad(lighten(s.c, 0.2), s.c);
      rects.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(s.w)}" height="${r2(h)}" ${idx === segs.length - 1 ? 'rx="2.5"' : ''} fill="${g}"/>`);
      x += s.w;
    });
    rects.push(`<rect x="${axisX}" y="${r2(y)}" width="${r2(segs.reduce((a, s) => a + s.w, 0))}" height="2.5" rx="1.2" fill="rgba(255,255,255,0.4)"/>`);
    parts.push(`<g filter="url(#soft)">${rects.join('')}</g>`);
  };

  if (variant === 'clustered') {
    const groups = [[150, 108], [96, 132], [128, 80]];
    const n = groups.length, slot = (bottom - top) / n, gH = slot * 0.64, bh = gH / 2 - 1;
    groups.forEach((g, i) => {
      const gy = top + slot * i + (slot - gH) / 2;
      drawBar(gy, bh, [{ w: g[0], c: PALETTE[0] }]);
      drawBar(gy + bh + 2, bh, [{ w: g[1], c: PALETTE[1] }]);
    });
  } else if (variant === 'stacked') {
    const bars = [[70, 50, 30], [46, 34, 20], [60, 42, 26], [38, 26, 14]];
    const n = bars.length, slot = (bottom - top) / n, bh = slot * 0.56;
    bars.forEach((segW, i) => drawBar(top + slot * i + (slot - bh) / 2, bh, segW.map((w, k) => ({ w, c: PALETTE[k] }))));
  } else if (variant === 'pct') {
    const FW = right - axisX;
    const props = [[0.5, 0.3, 0.2], [0.4, 0.35, 0.25], [0.55, 0.25, 0.2], [0.45, 0.3, 0.25]];
    const n = props.length, slot = (bottom - top) / n, bh = slot * 0.56;
    props.forEach((p, i) => drawBar(top + slot * i + (slot - bh) / 2, bh, p.map((f, k) => ({ w: f * FW, c: PALETTE[k] }))));
  } else {
    const W = [150, 96, 128, 72], n = W.length, slot = (bottom - top) / n, bh = slot * 0.58;
    W.forEach((w, i) => drawBar(top + slot * i + (slot - bh) / 2, bh, [{ w, c: PALETTE[i % PALETTE.length] }]));
  }
  return svgWrap(defs.render() + parts.join(''));
}

/* --------- 3D box primitives (front + top + side faces, lit) --------- */
// capTop=false omits the lit top face so stacked segments below the crown tile seamlessly.
function box3d(defs, x, y, w, h, c, dx, dy, capTop = true) {
  const front = defs.vgrad(lighten(c, 0.16), darken(c, 0.06));
  const top = lighten(c, 0.32);
  const side = defs.vgrad(darken(c, 0.14), darken(c, 0.34));
  return `<g filter="url(#soft)">`
    + (capTop ? `<path d="M ${r2(x)} ${r2(y)} l ${dx} ${dy} l ${r2(w)} 0 l ${-dx} ${-dy} Z" fill="${top}"/>` : '')
    + `<path d="M ${r2(x + w)} ${r2(y)} l ${dx} ${dy} l 0 ${r2(h)} l ${-dx} ${-dy} Z" fill="${side}"/>`
    + `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="${front}"/>`
    + `<rect x="${r2(x)}" y="${r2(y)}" width="2" height="${r2(h)}" fill="rgba(255,255,255,0.28)"/>`
    + `</g>`;
}
// capEnd=false omits the right-end face so stacked horizontal segments tile seamlessly.
function barBox3d(defs, x, y, w, h, c, dx, dy, capEnd = true) {
  const front = defs.hgrad(lighten(c, 0.14), darken(c, 0.08));
  const top = lighten(c, 0.3);
  const side = defs.vgrad(darken(c, 0.16), darken(c, 0.34));
  return `<g filter="url(#soft)">`
    + `<path d="M ${r2(x)} ${r2(y)} l ${dx} ${dy} l ${r2(w)} 0 l ${-dx} ${-dy} Z" fill="${top}"/>`
    + (capEnd ? `<path d="M ${r2(x + w)} ${r2(y)} l ${dx} ${dy} l 0 ${r2(h)} l ${-dx} ${-dy} Z" fill="${side}"/>` : '')
    + `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="${front}"/>`
    + `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="2" fill="rgba(255,255,255,0.3)"/>`
    + `</g>`;
}

/* -------------------- shared clean 2D axis + gridlines -------------------- */
function gridAndAxis(defs, left, right, base, topPad) {
  const out = [];
  for (let i = 1; i <= 3; i += 1) {
    const y = base - ((base - topPad) * i) / 3.4;
    out.push(`<line x1="${left}" y1="${r2(y)}" x2="${right}" y2="${r2(y)}" stroke="#eef2f7" stroke-width="1"/>`);
  }
  out.push(`<line x1="${left}" y1="${base}" x2="${right}" y2="${base}" stroke="#cbd5e1" stroke-width="1.2"/>`);
  out.push(`<line x1="${left}" y1="20" x2="${left}" y2="${base}" stroke="#cbd5e1" stroke-width="1.2"/>`);
  return out.join('');
}

/* ================================= line ================================== */
function thumbLine(typeId, { markers = false, smooth = true, area = false, stacked = false } = {}) {
  const defs = makeDefs();
  const left = 28, right = 188, base = 104, top = 20;
  const parts = [gridAndAxis(defs, left, right, base, top)];
  // Stacked lines are cumulative, so the upper line sits clearly above the lower.
  const seriesData = stacked
    ? [[20, 16, 24, 18, 14, 10], [44, 40, 52, 42, 38, 30]]
    : [[38, 26, 44, 30, 20, 14], [58, 50, 64, 40, 46, 30]];
  const n = seriesData[0].length;
  const px = (i) => left + ((right - left) * i) / (n - 1);
  const py = (v) => base - v;
  seriesData.forEach((vals, si) => {
    const c = PALETTE[si === 0 ? 0 : 3];
    const pts = vals.map((v, i) => [px(i), py(v)]);
    const d = smooth ? smoothPath(pts) : pts.map((p, i) => `${i ? 'L' : 'M'} ${r2(p[0])} ${r2(p[1])}`).join(' ');
    if (area) {
      const g = defs.vgrad(lighten(c, 0.1) + '', c);
      parts.push(`<path d="${d} L ${r2(px(n - 1))} ${base} L ${r2(px(0))} ${base} Z" fill="${g}" fill-opacity="0.28"/>`);
    }
    parts.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>`);
    if (markers) pts.forEach((p) => parts.push(`<circle cx="${r2(p[0])}" cy="${r2(p[1])}" r="3.2" fill="#fff" stroke="${c}" stroke-width="2"/>`));
  });
  return svgWrap(defs.render() + parts.join(''));
}
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M ${r2(pts[0][0])} ${r2(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${r2(c1x)} ${r2(c1y)}, ${r2(c2x)} ${r2(c2y)}, ${r2(p2[0])} ${r2(p2[1])}`;
  }
  return d;
}

/* ================================= area ================================== */
// variant: 'simple' (one translucent area) | 'stacked' (two layers) |
// 'pct' (two layers filling the full height).
function thumbArea(typeId, { variant = 'stacked' } = {}) {
  const defs = makeDefs();
  const left = 28, right = 188, base = 104, top = 20;
  const parts = [gridAndAxis(defs, left, right, base, top)];

  if (variant === 'simple') {
    const vals = [30, 44, 34, 54, 40, 60];
    const n = vals.length, px = (i) => left + ((right - left) * i) / (n - 1), c = PALETTE[0];
    const up = vals.map((v, i) => `${i ? 'L' : 'M'} ${r2(px(i))} ${r2(base - v)}`).join(' ');
    const g = defs.vgrad(lighten(c, 0.28), c);
    parts.push(`<path d="${up} L ${r2(px(n - 1))} ${base} L ${r2(px(0))} ${base} Z" fill="${g}" fill-opacity="0.75"/>`);
    parts.push(`<path d="${up}" fill="none" stroke="${darken(c, 0.06)}" stroke-width="2"/>`);
    return svgWrap(defs.render() + parts.join(''));
  }

  const FH = base - top - 4;
  const s1 = [16, 20, 14, 22, 18, 24], s2 = [24, 18, 28, 20, 26, 20];
  const n = s1.length, px = (i) => left + ((right - left) * i) / (n - 1);
  const cum = new Array(n).fill(0);
  const layers = variant === 'pct'
    ? [s1.map((v, i) => (v / (s1[i] + s2[i])) * FH), s2.map((v, i) => (v / (s1[i] + s2[i])) * FH)]
    : [s1, s2];
  layers.forEach((vals, si) => {
    const c = PALETTE[si === 0 ? 0 : 1];
    const base0 = cum.slice();
    const tops = vals.map((v, i) => (cum[i] += v));
    let d = tops.map((v, i) => `${i ? 'L' : 'M'} ${r2(px(i))} ${r2(base - v)}`).join(' ');
    for (let i = n - 1; i >= 0; i -= 1) d += ` L ${r2(px(i))} ${r2(base - base0[i])}`;
    const g = defs.vgrad(lighten(c, 0.18), c);
    parts.push(`<path d="${d} Z" fill="${g}" fill-opacity="0.92" stroke="${darken(c, 0.06)}" stroke-width="1.4"/>`);
  });
  return svgWrap(defs.render() + parts.join(''));
}

/* =============================== scatter ================================= */
function thumbScatter(typeId, { lines = false, bubble = false } = {}) {
  const defs = makeDefs();
  const left = 30, right = 188, base = 104, top = 20;
  const parts = [gridAndAxis(defs, left, right, base, top)];
  const pts = [[0.1, 0.3], [0.24, 0.55], [0.36, 0.4], [0.5, 0.72], [0.62, 0.5], [0.76, 0.82], [0.88, 0.66]];
  const px = (t) => left + (right - left) * t;
  const py = (t) => base - (base - top) * t;
  if (lines) parts.push(`<path d="${pts.map((p, i) => `${i ? 'L' : 'M'} ${r2(px(p[0]))} ${r2(py(p[1]))}`).join(' ')}" fill="none" stroke="${PALETTE[0]}" stroke-width="2"/>`);
  pts.forEach((p, i) => {
    const c = PALETTE[i % PALETTE.length];
    const rr = bubble ? 4 + (i % 4) * 3 : 4.5;
    const g = defs.radial(lighten(c, 0.35), c);
    parts.push(`<circle cx="${r2(px(p[0]))}" cy="${r2(py(p[1]))}" r="${rr}" fill="${g}" fill-opacity="${bubble ? 0.7 : 0.95}" stroke="${darken(c, 0.12)}" stroke-width="1"/>`);
  });
  return svgWrap(defs.render() + parts.join(''));
}

/* =============================== radar =================================== */
function thumbRadar() {
  const defs = makeDefs();
  const cx = 100, cy = 66, r = 44, n = 5;
  const parts = [];
  for (let ring = 1; ring <= 3; ring += 1) {
    const rr = (r * ring) / 3;
    const poly = Array.from({ length: n }, (_, i) => ptOnEllipse(cx, cy, rr, rr, -90 + (360 * i) / n)).map((p) => `${r2(p[0])},${r2(p[1])}`).join(' ');
    parts.push(`<polygon points="${poly}" fill="none" stroke="#e6eaf1" stroke-width="1"/>`);
  }
  for (let i = 0; i < n; i += 1) { const [x, y] = ptOnEllipse(cx, cy, r, r, -90 + (360 * i) / n); parts.push(`<line x1="${cx}" y1="${cy}" x2="${r2(x)}" y2="${r2(y)}" stroke="#e6eaf1" stroke-width="1"/>`); }
  const shapes = [[0.9, 0.6, 0.8, 0.5, 0.7], [0.5, 0.85, 0.55, 0.75, 0.6]];
  shapes.forEach((vals, si) => {
    const c = PALETTE[si === 0 ? 0 : 3];
    const poly = vals.map((v, i) => ptOnEllipse(cx, cy, r * v, r * v, -90 + (360 * i) / n)).map((p) => `${r2(p[0])},${r2(p[1])}`).join(' ');
    const g = defs.radial(lighten(c, 0.3), c);
    parts.push(`<polygon points="${poly}" fill="${g}" fill-opacity="0.28" stroke="${c}" stroke-width="2"/>`);
  });
  return svgWrap(defs.render() + parts.join(''));
}

/* =============================== funnel ================================== */
function thumbFunnel() {
  const defs = makeDefs();
  const cx = 100, top = 22, rowH = 17, n = 5;
  const widths = [140, 112, 86, 60, 34];
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    const y0 = top + rowH * i;
    const y1 = y0 + rowH - 3;
    const w0 = widths[i], w1 = widths[Math.min(n - 1, i + 1)];
    const c = PALETTE[i % PALETTE.length];
    const g = defs.hgrad(lighten(c, 0.2), c);
    parts.push(`<path d="M ${r2(cx - w0 / 2)} ${y0} L ${r2(cx + w0 / 2)} ${y0} L ${r2(cx + w1 / 2)} ${y1} L ${r2(cx - w1 / 2)} ${y1} Z" fill="${g}"/>`);
  }
  return svgWrap(defs.render() + parts.join(''));
}

/* ============================= waterfall ================================= */
function thumbWaterfall() {
  const defs = makeDefs();
  const left = 26, base = 104, slot = 32, bw = 20, n = 5;
  const parts = [gridAndAxis(defs, left, 188, base, 20)];
  const deltas = [40, 26, -18, 22, -14];
  let run = 0;
  for (let i = 0; i < n; i += 1) {
    const start = run; run += deltas[i];
    const yTop = base - Math.max(start, run);
    const h = Math.abs(start - run);
    const c = i === 0 ? '#8A94A6' : deltas[i] >= 0 ? '#5FA65F' : '#D9534F';
    const g = defs.vgrad(lighten(c, 0.2), c);
    const x = left + 8 + slot * i;
    parts.push(`<rect x="${r2(x)}" y="${r2(yTop)}" width="${bw}" height="${r2(Math.max(3, h))}" rx="2" fill="${g}"/>`);
    if (i < n - 1) parts.push(`<line x1="${r2(x + bw)}" y1="${r2(base - run)}" x2="${r2(x + slot)}" y2="${r2(base - run)}" stroke="#b8c0cf" stroke-width="1" stroke-dasharray="2 2"/>`);
  }
  return svgWrap(defs.render() + parts.join(''));
}

/* ============================ combination ================================ */
function thumbCombo() {
  const defs = makeDefs();
  defs.raw('<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="1.4" flood-color="#0b1220" flood-opacity="0.16"/></filter>');
  const left = 28, right = 188, base = 104, n = 5;
  const parts = [gridAndAxis(defs, left, right, base, 20)];
  const cols = [40, 60, 50, 74, 58];
  const slot = (right - left) / n;
  const bw = slot * 0.5;
  cols.forEach((h, i) => {
    const x = left + slot * i + (slot - bw) / 2;
    const c = PALETTE[0];
    const g = defs.vgrad(lighten(c, 0.22), c);
    parts.push(`<rect x="${r2(x)}" y="${r2(base - h)}" width="${r2(bw)}" height="${r2(h)}" rx="2.5" fill="${g}" filter="url(#soft)"/>`);
  });
  const line = [56, 72, 64, 86, 78];
  const px = (i) => left + slot * (i + 0.5);
  const d = smoothPath(line.map((v, i) => [px(i), base - v]));
  parts.push(`<path d="${d}" fill="none" stroke="${PALETTE[1]}" stroke-width="2.6" stroke-linejoin="round"/>`);
  line.forEach((v, i) => parts.push(`<circle cx="${r2(px(i))}" cy="${r2(base - v)}" r="3" fill="#fff" stroke="${PALETTE[1]}" stroke-width="2"/>`));
  return svgWrap(defs.render() + parts.join(''));
}

/* ===== 3D line / area / scatter (match the document renderer's approach) ==== */
function thumbLine3d() {
  const defs = makeDefs();
  const left = 28, right = 188, base = 104, top = 20;
  const parts = [gridAndAxis(defs, left, right, base, top)];
  const series = [[40, 28, 48, 34, 24], [62, 52, 70, 48, 54]];
  const n = series[0].length, px = (i) => left + ((right - left) * i) / (n - 1), py = (v) => base - v;
  const dx = 12, dy = -12;
  series.forEach((vals, si) => {
    const c = PALETTE[si === 0 ? 0 : 3];
    const pts = vals.map((v, i) => [px(i), py(v)]);
    const back = pts.map((p) => [p[0] + dx, p[1] + dy]);
    let band = pts.map((p, i) => `${i ? 'L' : 'M'} ${r2(p[0])} ${r2(p[1])}`).join(' ');
    for (let i = back.length - 1; i >= 0; i -= 1) band += ` L ${r2(back[i][0])} ${r2(back[i][1])}`;
    parts.push(`<path d="${band} Z" fill="${defs.vgrad(lighten(c, 0.3), c)}"/>`);
    parts.push(`<path d="${back.map((p, i) => `${i ? 'L' : 'M'} ${r2(p[0])} ${r2(p[1])}`).join(' ')}" fill="none" stroke="${lighten(c, 0.25)}" stroke-width="1.4"/>`);
    parts.push(`<path d="${pts.map((p, i) => `${i ? 'L' : 'M'} ${r2(p[0])} ${r2(p[1])}`).join(' ')}" fill="none" stroke="${darken(c, 0.06)}" stroke-width="2.6" stroke-linejoin="round"/>`);
  });
  return svgWrap(defs.render() + parts.join(''));
}
function thumbArea3d() {
  const defs = makeDefs();
  const left = 28, right = 188, base = 104, top = 20;
  const parts = [gridAndAxis(defs, left, right, base, top)];
  const vals = [30, 44, 34, 54, 40, 60], n = vals.length, c = PALETTE[0];
  const px = (i) => left + ((right - left) * i) / (n - 1);
  const dx = 14, dy = -14;
  const front = vals.map((v, i) => [px(i), base - v]);
  const bf = vals.map((_, i) => [px(i), base]);
  const back = front.map((p) => [p[0] + dx, p[1] + dy]);
  const bb = bf.map((p) => [p[0] + dx, p[1] + dy]);
  const li = front.length - 1;
  let db = back.map((p, i) => `${i ? 'L' : 'M'} ${r2(p[0])} ${r2(p[1])}`).join(' ');
  for (let i = bb.length - 1; i >= 0; i -= 1) db += ` L ${r2(bb[i][0])} ${r2(bb[i][1])}`;
  parts.push(`<path d="${db} Z" fill="${darken(c, 0.3)}"/>`);
  let st = front.map((p, i) => `${i ? 'L' : 'M'} ${r2(p[0])} ${r2(p[1])}`).join(' ');
  for (let i = front.length - 1; i >= 0; i -= 1) st += ` L ${r2(back[i][0])} ${r2(back[i][1])}`;
  parts.push(`<path d="${st} Z" fill="${defs.vgrad(lighten(c, 0.34), c)}"/>`);
  parts.push(`<path d="M ${r2(front[li][0])} ${r2(front[li][1])} L ${r2(back[li][0])} ${r2(back[li][1])} L ${r2(bb[li][0])} ${r2(bb[li][1])} L ${r2(bf[li][0])} ${r2(bf[li][1])} Z" fill="${darken(c, 0.24)}"/>`);
  let df = front.map((p, i) => `${i ? 'L' : 'M'} ${r2(p[0])} ${r2(p[1])}`).join(' ');
  for (let i = bf.length - 1; i >= 0; i -= 1) df += ` L ${r2(bf[i][0])} ${r2(bf[i][1])}`;
  parts.push(`<path d="${df} Z" fill="${defs.vgrad(lighten(c, 0.16), darken(c, 0.06))}"/>`);
  return svgWrap(defs.render() + parts.join(''));
}
function thumbScatter3d() {
  const defs = makeDefs();
  defs.raw('<filter id="blur" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2"/></filter>');
  const left = 30, right = 188, base = 104, top = 20;
  const parts = [gridAndAxis(defs, left, right, base, top)];
  const pts = [[0.12, 0.32], [0.28, 0.6], [0.4, 0.44], [0.54, 0.74], [0.66, 0.52], [0.8, 0.82]];
  const px = (t) => left + (right - left) * t, py = (t) => base - (base - top) * t;
  pts.forEach((p, i) => {
    const c = PALETTE[i % PALETTE.length], x = px(p[0]), y = py(p[1]), rr = 7 + (i % 3) * 2;
    parts.push(`<ellipse cx="${r2(x)}" cy="${r2(y + rr * 0.9)}" rx="${r2(rr * 0.9)}" ry="${r2(rr * 0.3)}" fill="#0b1220" opacity="0.16" filter="url(#blur)"/>`);
    parts.push(`<circle cx="${r2(x)}" cy="${r2(y)}" r="${rr}" fill="${defs.radial(lighten(c, 0.5), darken(c, 0.28))}"/>`);
    parts.push(`<ellipse cx="${r2(x - rr * 0.3)}" cy="${r2(y - rr * 0.32)}" rx="${r2(rr * 0.3)}" ry="${r2(rr * 0.2)}" fill="#ffffff" opacity="0.5"/>`);
  });
  return svgWrap(defs.render() + parts.join(''));
}

/* ------------------------------ dispatch ---------------------------------- */
const RENDERERS = {
  pie: () => thumbPie('pie', { strength: 0 }),
  pie3d: () => thumbPie('pie3d', { strength: 2 }),
  pieExploded: () => thumbPie('pieExploded', { strength: 1, explode: true }),
  pieExploded3d: () => thumbPie('pieExploded3d', { strength: 2, explode: true }),
  doughnut: () => thumbPie('doughnut', { strength: 1, doughnut: true }),
  doughnut3d: () => thumbPie('doughnut3d', { strength: 2, doughnut: true }),
  doughnutExploded: () => thumbPie('doughnutExploded', { strength: 1, doughnut: true, explode: true }),
  doughnutExploded3d: () => thumbPie('doughnutExploded3d', { strength: 2, doughnut: true, explode: true }),

  column: () => thumbColumn('column', { variant: 'simple' }),
  columnClustered: () => thumbColumn('columnClustered', { variant: 'clustered' }),
  columnStacked: () => thumbColumn('columnStacked', { variant: 'stacked' }),
  column100: () => thumbColumn('column100', { variant: 'pct' }),
  column3d: () => thumbColumn('column3d', { d3: true }),
  columnClustered3d: () => thumbColumn('columnClustered3d', { variant: 'clustered', d3: true }),
  columnStacked3d: () => thumbColumn('columnStacked3d', { variant: 'stacked', d3: true }),
  column1003d: () => thumbColumn('column1003d', { variant: 'pct', d3: true }),

  bar: () => thumbBar('bar', { variant: 'simple' }),
  barClustered: () => thumbBar('barClustered', { variant: 'clustered' }),
  barStacked: () => thumbBar('barStacked', { variant: 'stacked' }),
  bar100: () => thumbBar('bar100', { variant: 'pct' }),
  bar3d: () => thumbBar('bar3d', { d3: true }),
  barClustered3d: () => thumbBar('barClustered3d', { variant: 'clustered', d3: true }),
  barStacked3d: () => thumbBar('barStacked3d', { variant: 'stacked', d3: true }),

  line: () => thumbLine('line', { smooth: false }),
  lineMarkers: () => thumbLine('lineMarkers', { markers: true, smooth: false }),
  lineSmooth: () => thumbLine('lineSmooth', { smooth: true }),
  lineStacked: () => thumbLine('lineStacked', { smooth: false, stacked: true }),
  lineArea: () => thumbLine('lineArea', { smooth: true, area: true }),
  line3d: () => thumbLine3d(),

  area: () => thumbArea('area', { variant: 'simple' }),
  areaStacked: () => thumbArea('areaStacked', { variant: 'stacked' }),
  area100: () => thumbArea('area100', { variant: 'pct' }),
  area3d: () => thumbArea3d(),

  scatter: () => thumbScatter('scatter'),
  scatterLines: () => thumbScatter('scatterLines', { lines: true }),
  bubble: () => thumbScatter('bubble', { bubble: true }),
  scatter3d: () => thumbScatter3d(),

  radar: () => thumbRadar(),
  funnel: () => thumbFunnel(),
  waterfall: () => thumbWaterfall(),
  combo: () => thumbCombo(),
};

/** Premium preview SVG (string) for a chart type. Purely a thumbnail. */
export function chartThumb(typeId) {
  const fn = RENDERERS[typeId];
  if (fn) return fn();
  // Extended library types: render the ACTUAL chart small, with text stripped for a
  // clean preview, so the tile faithfully represents what will be inserted.
  const s = sampleChart(typeId);
  Object.assign(s.options, {
    showTitle: false, showLegend: false, showCatLabels: false,
    showDataLabels: false, showPercentLabels: false, showAxisTitles: false,
  });
  return renderChartSvg(s, { width: THUMB_VIEW.w, height: THUMB_VIEW.h });
}
