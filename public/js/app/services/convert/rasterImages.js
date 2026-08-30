/**
 * Recover embedded images (logos, seals, photograph, stamps) from a page raster.
 *
 * When a PDF is imported, its pages are flattened to a background raster and the
 * original embedded images are lost as discrete objects (see editor/pdfImport.js).
 * The faithful DOCX layout still wants those images back as real, editable Word
 * pictures. Since we only have the raster, we RECOVER them: mark every region the
 * text layer already covers, then find the remaining dense, blocky ink clusters —
 * a photograph or logo is a solid rectangular mass, whereas table borders are thin
 * hollow outlines and coloured heading bars are short — and crop each cluster out.
 *
 * This is deliberately conservative: it would rather miss a faint logo than crop a
 * table border or a heading bar and pass it off as a picture. Everything is
 * wrapped so any failure yields "no images" and never breaks the conversion.
 *
 * Needs the DOM (canvas), so it runs only in the browser, before `modelToDocx`.
 */
import { detectTableRegions } from './reconstruct.js';
import { normHex, hasComplexScript } from './model.js';

/**
 * Pre-mask a page raster for the position-faithful ("Exact Match") DOCX.
 *
 * That mode lays the page raster down as a full-page backdrop and overlays each
 * text run as a floating box FILLED with its sampled background colour, which in
 * Word/LibreOffice hides the same glyph baked into the raster. Google Docs, though,
 * does NOT honour a floating text box's fill or z-order the same way, so the baked
 * glyph shows through the overlay and every line appears doubled/ghosted.
 *
 * The robust fix is to erase the text from the raster ITSELF before embedding it:
 * paint each overlaid run's footprint with its sampled `boxBg` (the same colour the
 * overlay box uses, sampled from the page behind the glyph, so it blends into any
 * background — white paper, the green banner, a coloured bar). The overlay boxes
 * still carry the editable text, but there is no longer a baked glyph left to bleed
 * through — the page is clean in Google Docs AND identical in Word.
 *
 * Only IMPORTED runs are erased (user-added text was never baked into the raster),
 * and only where a clean mask colour exists. Needs the DOM (canvas). Best-effort:
 * any failure returns the page's original background unchanged.
 *
 * @param {{PW:number,PH:number,pages:{bg?:string|null,w?:number,h?:number,objects:any[]}[]}} model
 * @param {{protect?:Array<Array<{x:number,y:number,w:number,h:number}>>}} [opts]
 *   `protect[pageIndex]` lists page-coord rectangles whose text must NOT be erased —
 *   labels that are PART OF an illustration/diagram (they stay baked as picture).
 * @returns {Promise<(string|null)[]>} one cleaned background data URL per page (or the original)
 */
export async function maskExtractedText(model, opts = {}) {
  const out = [];
  const protect = opts.protect || [];
  const pagesArr = model.pages || [];
  for (let i = 0; i < pagesArr.length; i += 1) {
    const pg = pagesArr[i];
    try { out.push(pg.bg ? await maskPage(pg, model, protect[i] || null) : (pg.bg || null)); }
    catch { out.push(pg.bg || null); }
  }
  return out;
}

/** True when an object's rectangle centre lies inside any protected region. */
function inProtected(o, protect) {
  if (!protect || !protect.length) return false;
  const cx = (o.x || 0) + (o.w || 0) / 2, cy = (o.y || 0) + (o.h || 0) / 2;
  return protect.some((r) => cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h);
}

async function maskPage(pg, model, protect) {
  const pageW = pg.w || model.PW;
  const img = await loadImage(pg.bg);
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  if (!W || !H) return pg.bg;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);

  const scale = W / pageW; // raster px per page px
  let painted = 0;
  for (const o of (pg.objects || [])) {
    if (o.type !== 'text' && o.type !== 'comment') continue;
    if (!o.imported) continue;                         // user-added text isn't baked in
    // A label that is PART OF an illustration/diagram must stay baked in the picture,
    // so never erase it (the caller keeps it as image, not as an overlay text box).
    if (inProtected(o, protect)) continue;
    // Complex-script runs (Devanagari & other Indic, Arabic, …) are left BAKED in
    // the Exact-layout DOCX (docx.js skips their scrambled editable overlay), so we
    // must NOT erase them here — doing so would blank out the only correct copy.
    if (hasComplexScript(o.text)) continue;
    const bg = normHex(o.boxBg);
    if (!bg) continue;                                 // no clean mask colour → leave baked
    // Erase every imported run's footprint, whether it is re-typed by an overlay
    // box or was deleted by the user — either way the baked glyph must not remain.
    // Same footprint the overlay box uses in docx.js `absoluteBody`, +1 px slack so
    // no anti-aliased glyph edge survives around the erased rectangle.
    const fs = o.fontSize || 14;
    const w = Math.max(o.w || 0, fs * 0.5);
    const h = Math.max(o.h || 0, fs * 1.1);
    ctx.fillStyle = `#${bg}`;
    ctx.fillRect(
      Math.round((o.x || 0) * scale) - 1, Math.round((o.y || 0) * scale) - 1,
      Math.round(w * scale) + 2, Math.round(h * scale) + 2,
    );
    painted += 1;
  }
  if (!painted) return pg.bg; // nothing extractable to erase → keep the original raster
  return canvas.toDataURL('image/jpeg', 0.92);
}

/**
 * @param {{PW:number,PH:number,pages:{bg?:string|null,w?:number,h?:number,objects:any[]}[]}} model
 * @returns {Promise<Array<Array<{src:string,x:number,y:number,w:number,h:number}>>>}
 *   One array of recovered images per page (page-pixel coordinates).
 */
export async function extractBakedImages(model) {
  const out = [];
  for (const pg of (model.pages || [])) {
    try {
      out.push(pg.bg ? await extractPage(pg, model) : []);
    } catch {
      out.push([]); // never let recovery failure abort the conversion
    }
  }
  return out;
}

async function extractPage(pg, model) {
  const pageW = pg.w || model.PW, pageH = pg.h || model.PH;
  const img = await loadImage(pg.bg);
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  if (!W || !H) return [];
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(img, 0, 0, W, H);
  const px = ctx.getImageData(0, 0, W, H).data;

  const scale = W / pageW;                 // raster px per page px
  const cell = Math.max(4, Math.round(scale * 3));
  const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);

  // 1) Ink map: a cell is "inked" if enough of its pixels are clearly non-white.
  const inked = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      inked[r * cols + c] = cellHasInk(px, W, H, c * cell, r * cell, cell) ? 1 : 0;
    }
  }

  // 2a) Text mask: clear every cell the text layer already covers (+1 cell pad),
  // so recovered clusters are the NON-text graphics only.
  const runs = [];
  for (const o of (pg.objects || [])) {
    if (o.type !== 'text' && o.type !== 'comment') continue;
    if (!o.text || !String(o.text).replace(/<[^>]+>/g, '').trim()) continue;
    runs.push({ x: o.x || 0, y: o.y || 0, w: o.w || 0, h: o.h || 0, fontSize: o.fontSize || 12 });
    markRect(inked, cols, rows,
      Math.floor((o.x * scale) / cell) - 1, Math.floor((o.y * scale) / cell) - 1,
      Math.ceil(((o.x + (o.w || 0)) * scale) / cell) + 1,
      Math.ceil(((o.y + (o.h || 0)) * scale) / cell) + 1);
  }

  // 2b) Clear detected TABLE regions, but PER CELL — not the whole bounding box.
  // Grid lines and empty/label cells are sparse ink that would bridge nearby
  // pictures into one blob, so we clear them; but a cell that is densely inked is
  // an embedded picture (a candidate photo, seal or QR sitting inside the grid) and
  // must survive — clearing the whole bbox is exactly what used to erase the photos
  // in a form's cells. (Flat colour fills that happen to be dense are dropped later
  // by the regionStd gate, so preserving them here is safe.)
  for (const region of detectTableRegions(runs, pageW)) {
    if (!region.cols.length || !region.rows.length) continue;
    for (const row of region.rows) {
      for (const col of region.cols) {
        // Non-overlapping cell rect (no padding) so clearing one cell never bleeds
        // into a dense neighbour — otherwise a sparse label cell would erase the
        // edge of the photo beside it.
        const c0 = Math.round((col.x * scale) / cell);
        const r0 = Math.round((row.y * scale) / cell);
        const c1 = Math.round(((col.x + col.w) * scale) / cell) - 1;
        const r1 = Math.round(((row.y + row.h) * scale) / cell) - 1;
        if (cellInkFraction(inked, cols, rows, c0, r0, c1, r1) < 0.45) markRect(inked, cols, rows, c0, r0, c1, r1);
      }
    }
  }

  // 2c) Clear regions already recovered as REAL embedded images (XObjects lifted
  // at import — see pdfImport.extractImageRects), so this heuristic pass only
  // SUPPLEMENTS them with graphics they can't represent (e.g. vector-drawn logos
  // or signatures) and never emits a duplicate crop of an image we already have.
  for (const im of (pg.images || [])) {
    markRect(inked, cols, rows,
      Math.floor((im.x * scale) / cell) - 1, Math.floor((im.y * scale) / cell) - 1,
      Math.ceil(((im.x + im.w) * scale) / cell) + 1, Math.ceil(((im.y + im.h) * scale) / cell) + 1);
  }

  // 3) Remove long, thin lines (box/table/cell borders and rules). Left in, a box
  // border bridges to a picture sitting inside/next to it under dilation, producing
  // one huge component = the whole box mis-recovered as an "image". Borders are long
  // and 1–few cells thick; photos/QR are thick blocks and signatures are short
  // strokes, so both survive.
  removeThinLines(inked, cols, rows, Math.round(cols * 0.22), 3);

  // 4) Dilate so a signature's separate strokes (and a QR's modules) merge into a
  // single region instead of fragmenting, then take connected components.
  const merged = dilate(inked, cols, rows, 2);
  const comps = connectedComponents(merged, cols, rows);

  const images = [];
  for (const comp of comps) {
    const bw = comp.maxC - comp.minC + 1, bh = comp.maxR - comp.minR + 1;
    const wPx = (bw * cell) / scale, hPx = (bh * cell) / scale;
    const fill = comp.count / (bw * bh);
    const areaFrac = (wPx * hPx) / (pageW * pageH);
    // Keep photo (dense), QR (dense) AND signature (sparse strokes, but a compact,
    // blocky region) — while rejecting the artefacts a form raster is full of:
    if (wPx < 26 || hPx < 20) continue;                       // too small to be a picture
    if (comp.count < 8) continue;
    if (hPx < 30 && wPx > pageW * 0.32) continue;             // horizontal bar / rule
    if (wPx < 30 && hPx > pageH * 0.32) continue;             // vertical rule
    if (areaFrac > 0.10 && fill < 0.22) continue;             // large + hollow = table frame
    if (fill < 0.05) continue;                                // essentially empty
    if (areaFrac > 0.16) continue;                            // too big to be an embedded picture
    if (wPx > pageW * 0.9 && hPx > pageH * 0.9) continue;     // whole-page block ≠ image

    const sx = comp.minC * cell, sy = comp.minR * cell;
    const sw = Math.min(W - sx, bw * cell), sh = Math.min(H - sy, bh * cell);
    // A real picture (photo, logo, stamp, QR, signature) has internal CONTRAST; a
    // flat colour box fill or bar has std ≈ 0. The threshold is deliberately LOW so
    // a real photo is never dropped — flat fills sit far below it. Empty *bordered*
    // boxes are handled by the earlier defences (light fills don't count as ink, and
    // form boxes are detected+cleared as tables), not by this gate.
    if (regionStd(px, W, H, sx, sy, sw, sh) < 12) continue;
    // A SMALL region whose interior has almost no edges is a flat/two-tone colour
    // box (a grey placeholder rectangle, a two-cell swatch), not a picture: its high
    // std comes from a single grey↔white boundary, not from real content. A QR, photo
    // or signature is full of edges, so this only trips on near-featureless boxes —
    // and only for small regions, so a large photo is never at risk.
    if (areaFrac < 0.03 && regionDetail(px, W, H, sx, sy, sw, sh) < 0.03) continue;

    const crop = document.createElement('canvas');
    crop.width = sw; crop.height = sh;
    crop.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    images.push({
      src: crop.toDataURL('image/jpeg', 0.85),
      x: Math.round(sx / scale), y: Math.round(sy / scale),
      w: Math.round(sw / scale), h: Math.round(sh / scale),
    });
    if (images.length >= 12) break; // pathological-page guard
  }
  return images;
}

/* -------------------------------- helpers -------------------------------- */

function cellHasInk(px, W, H, x0, y0, cell) {
  let ink = 0, seen = 0;
  const step = Math.max(1, Math.round(cell / 4));
  for (let y = y0; y < y0 + cell && y < H; y += step) {
    for (let x = x0; x < x0 + cell && x < W; x += step) {
      const i = (y * W + x) * 4;
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      seen += 1;
      // Threshold at 225, not 240: LIGHT box fills (pale lavender/grey form boxes)
      // are ~225-240 and must NOT count as ink, or they form big solid regions that
      // get mis-recovered as pictures. Real graphics carry darker/saturated pixels.
      if (lum < 225) ink += 1;
    }
  }
  return seen > 0 && ink / seen > 0.18;
}

/** Std-dev of luminance over a sampled region — a picture's internal contrast is
 *  high; a flat colour fill or bar is near-zero. */
function regionStd(px, W, H, x, y, w, h) {
  // Sample the INTERIOR (inset ~20% past any border). A bordered but flat-filled box
  // — a grey/pale placeholder rectangle in a clean digital PDF — has a near-zero
  // interior std even though its dark border alone would lift the full-region std
  // over the gate and get it mis-recovered as a picture. A real photo/QR/signature
  // carries contrast through its interior, so it still passes.
  const ix = Math.round(Math.min(w, h) * 0.2);
  let x0 = x, y0 = y, w0 = w, h0 = h;
  if (w - 2 * ix >= 6 && h - 2 * ix >= 6) { x0 = x + ix; y0 = y + ix; w0 = w - 2 * ix; h0 = h - 2 * ix; }
  let n = 0, sum = 0, sum2 = 0;
  const stepX = Math.max(1, Math.round(w0 / 40)), stepY = Math.max(1, Math.round(h0 / 40));
  for (let yy = y0; yy < y0 + h0 && yy < H; yy += stepY) {
    for (let xx = x0; xx < x0 + w0 && xx < W; xx += stepX) {
      const i = (yy * W + xx) * 4;
      const l = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      sum += l; sum2 += l * l; n += 1;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

/** Fraction of interior sample points that sit on a hard luminance edge. A picture,
 *  QR or signature stroke is full of edges (high); a flat or two-plateau colour box
 *  has almost none (a single boundary line). Interior-only, so a border doesn't
 *  count. Used to reject small featureless boxes that pass the std gate. */
function regionDetail(px, W, H, x, y, w, h) {
  const ix = Math.round(Math.min(w, h) * 0.2);
  let x0 = x, y0 = y, w0 = w, h0 = h;
  if (w - 2 * ix >= 6 && h - 2 * ix >= 6) { x0 = x + ix; y0 = y + ix; w0 = w - 2 * ix; h0 = h - 2 * ix; }
  const stepX = Math.max(1, Math.round(w0 / 48)), stepY = Math.max(1, Math.round(h0 / 48));
  const lum = (xx, yy) => { const i = (yy * W + xx) * 4; return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; };
  let edges = 0, n = 0;
  for (let yy = y0; yy + stepY < y0 + h0 && yy + stepY < H; yy += stepY) {
    for (let xx = x0; xx + stepX < x0 + w0 && xx + stepX < W; xx += stepX) {
      const l = lum(xx, yy);
      if (Math.abs(l - lum(xx + stepX, yy)) > 28 || Math.abs(l - lum(xx, yy + stepY)) > 28) edges += 1;
      n += 1;
    }
  }
  return n ? edges / n : 0;
}

function markRect(grid, cols, rows, c0, r0, c1, r1) {
  for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r += 1) {
    for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c += 1) grid[r * cols + c] = 0;
  }
}

/** Fraction of a grid rectangle that is inked (0..1) — used to tell a dense
 *  embedded picture (keep) from an empty/border/label table cell (clear). */
function cellInkFraction(grid, cols, rows, c0, r0, c1, r1) {
  let on = 0, total = 0;
  for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r += 1) {
    for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c += 1) { total += 1; if (grid[r * cols + c]) on += 1; }
  }
  return total ? on / total : 0;
}

/** Clear long, thin runs of ink — i.e. straight border/rule lines — while leaving
 *  thick blocks (photos/QR) and short strokes (signatures) intact. A run counts as
 *  a line if it is ≥ `minLen` cells long and, at each cell, no more than `maxThick`
 *  cells thick in the perpendicular direction. Cleared cells are collected first so
 *  the thickness test always reads the ORIGINAL grid (no cascading erosion). */
function removeThinLines(grid, cols, rows, minLen, maxThick) {
  const clear = [];
  const vThick = (r, c) => {
    let n = 1;
    for (let rr = r - 1; rr >= 0 && grid[rr * cols + c]; rr -= 1) n += 1;
    for (let rr = r + 1; rr < rows && grid[rr * cols + c]; rr += 1) n += 1;
    return n;
  };
  const hThick = (r, c) => {
    let n = 1;
    for (let cc = c - 1; cc >= 0 && grid[r * cols + cc]; cc -= 1) n += 1;
    for (let cc = c + 1; cc < cols && grid[r * cols + cc]; cc += 1) n += 1;
    return n;
  };
  for (let r = 0; r < rows; r += 1) {            // horizontal lines
    let c = 0;
    while (c < cols) {
      if (!grid[r * cols + c]) { c += 1; continue; }
      let c1 = c; while (c1 < cols && grid[r * cols + c1]) c1 += 1;
      if (c1 - c >= minLen) {
        for (let cc = c; cc < c1; cc += 1) if (vThick(r, cc) <= maxThick) clear.push(r * cols + cc);
      }
      c = c1;
    }
  }
  for (let c = 0; c < cols; c += 1) {            // vertical lines
    let r = 0;
    while (r < rows) {
      if (!grid[r * cols + c]) { r += 1; continue; }
      let r1 = r; while (r1 < rows && grid[r1 * cols + c]) r1 += 1;
      if (r1 - r >= minLen) {
        for (let rr = r; rr < r1; rr += 1) if (hThick(rr, c) <= maxThick) clear.push(rr * cols + c);
      }
      r = r1;
    }
  }
  for (const i of clear) grid[i] = 0;
}

/** Morphological dilation by `rad` cells (Chebyshev) — grows ink so nearby marks
 *  join into one component. Separable (horizontal then vertical) to stay cheap. */
function dilate(grid, cols, rows, rad) {
  const tmp = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let on = 0;
      for (let d = -rad; d <= rad && !on; d += 1) {
        const cc = c + d;
        if (cc >= 0 && cc < cols && grid[r * cols + cc]) on = 1;
      }
      tmp[r * cols + c] = on;
    }
  }
  const out = new Uint8Array(cols * rows);
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      let on = 0;
      for (let d = -rad; d <= rad && !on; d += 1) {
        const rr = r + d;
        if (rr >= 0 && rr < rows && tmp[rr * cols + c]) on = 1;
      }
      out[r * cols + c] = on;
    }
  }
  return out;
}

/** 4-connected components of the truthy cells; returns bbox + cell count each. */
function connectedComponents(grid, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const comps = [];
  const stack = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const idx = r * cols + c;
      if (!grid[idx] || seen[idx]) continue;
      let minR = r, maxR = r, minC = c, maxC = c, count = 0;
      stack.push(idx); seen[idx] = 1;
      while (stack.length) {
        const p = stack.pop();
        const pr = (p / cols) | 0, pc = p % cols;
        count += 1;
        if (pr < minR) minR = pr; if (pr > maxR) maxR = pr;
        if (pc < minC) minC = pc; if (pc > maxC) maxC = pc;
        const nb = [p - 1, p + 1, p - cols, p + cols];
        if (pc === 0) nb[0] = -1;
        if (pc === cols - 1) nb[1] = -1;
        for (const q of nb) {
          if (q < 0 || q >= grid.length || seen[q] || !grid[q]) continue;
          seen[q] = 1; stack.push(q);
        }
      }
      comps.push({ minR, maxR, minC, maxC, count });
    }
  }
  return comps;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}
