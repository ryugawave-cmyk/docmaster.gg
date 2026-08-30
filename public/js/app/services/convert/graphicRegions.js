/**
 * Detect colourful, blocky vector-graphic / diagram regions from a page raster.
 *
 * A diagram (e.g. the biology cell illustration labelled "CELL • NUCLEUS •
 * ORGANELLES") is drawn as vector shapes, so it isn't an embedded image XObject —
 * yet its labels are PART OF the picture. The positioned PDF → DOC transfer uses the
 * regions found here to keep text (and OCR) inside a diagram BAKED in the raster,
 * instead of lifting it into separate, re-positioned text boxes that break the
 * image-to-text relationship.
 *
 * The gate is deliberately narrow so ordinary content stays fully editable: a region
 * qualifies only when it is a sizeable BLOCK (not the whole page, not a thin bar or
 * rule) that is genuinely COLOURFUL — saturated pixels from drawn shapes. That is
 * what separates a diagram (green/blue/red/purple shapes) from black-on-white body
 * text and grey/black table grids, which carry almost no saturated pixels.
 *
 * Pure (no DOM / no pdfjs): it takes a raw RGBA pixel buffer, so it is unit-testable
 * in Node — see scripts/verify-graphic-regions.mjs. The browser caller in
 * positionedImport.js supplies the pixels from a canvas.
 */

/**
 * @param {Uint8ClampedArray|Uint8Array} data  RGBA pixel buffer of the page raster
 * @param {number} W  raster width in px
 * @param {number} H  raster height in px
 * @param {number} pageW  page width in CSS px (raster maps to page via W/pageW)
 * @returns {{x:number,y:number,w:number,h:number}[]}  diagram regions in PAGE coords
 */
export function detectGraphicRegionsFromPixels(data, W, H, pageW) {
  if (!W || !H || !data || !data.length) return [];
  const scale = W / (pageW || W);                  // raster px per page px
  const cell = Math.max(4, Math.round(scale * 4)); // ~4 page-px analysis cells
  const cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
  const ink = new Uint8Array(cols * rows);         // any non-white content
  const sat = new Uint8Array(cols * rows);         // saturated (colourful) content
  const step = Math.max(1, cell >> 2);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let inked = 0, colored = 0;
      const x0 = c * cell, y0 = r * cell;
      for (let y = y0; y < y0 + cell && y < H; y += step) {
        for (let x = x0; x < x0 + cell && x < W; x += step) {
          const i = (y * W + x) * 4, R = data[i], G = data[i + 1], B = data[i + 2];
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          if (mx < 236) inked = 1;                             // non-white pixel
          if (mx - mn > 40 && mx > 40) { inked = 1; colored = 1; } // saturated colour
        }
      }
      ink[r * cols + c] = inked; sat[r * cols + c] = colored;
    }
  }

  // Grow ink so a diagram's separate shapes/border join into one region, then take
  // connected components. Borders are KEPT (not stripped) so the container encloses
  // its inner labels; greyscale tables are excluded by the colourfulness gate below.
  const merged = dilateGrid(ink, cols, rows, 2);
  const comps = gridComponents(merged, cols, rows);
  const regions = [];
  for (const cmp of comps) {
    const bw = cmp.maxC - cmp.minC + 1, bh = cmp.maxR - cmp.minR + 1;
    const areaFrac = (bw * bh) / (cols * rows);
    if (areaFrac < 0.02 || areaFrac > 0.6) continue;   // tiny mark / (near) whole page or scan
    if (bw < cols * 0.12 || bh < rows * 0.12) continue; // too small in a dimension (a diagram is TALL, not a header bar)
    if (bw / bh > 6 || bh / bw > 6) continue;           // thin bar / rule / narrow column (a diagram is blocky, not wide-flat)
    let inkN = 0, satN = 0;
    for (let r = cmp.minR; r <= cmp.maxR; r += 1) {
      for (let c = cmp.minC; c <= cmp.maxC; c += 1) {
        if (ink[r * cols + c]) { inkN += 1; if (sat[r * cols + c]) satN += 1; }
      }
    }
    if (!inkN || satN / inkN < 0.12) continue;          // greyscale ⇒ text/table, not a diagram
    // Pad a little so labels hugging the inner edge are safely inside the region.
    const px = (cmp.minC * cell) / scale, py = (cmp.minR * cell) / scale;
    const pw = (bw * cell) / scale, ph = (bh * cell) / scale;
    const pad = Math.max(4, ph * 0.02);
    regions.push({
      x: Math.round(px - pad), y: Math.round(py - pad),
      w: Math.round(pw + pad * 2), h: Math.round(ph + pad * 2),
    });
  }
  return regions;
}

/** Separable Chebyshev dilation by `rad` cells (grows ink so nearby marks join). */
function dilateGrid(grid, cols, rows, rad) {
  const tmp = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let on = 0;
      for (let d = -rad; d <= rad && !on; d += 1) { const cc = c + d; if (cc >= 0 && cc < cols && grid[r * cols + cc]) on = 1; }
      tmp[r * cols + c] = on;
    }
  }
  const out = new Uint8Array(cols * rows);
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      let on = 0;
      for (let d = -rad; d <= rad && !on; d += 1) { const rr = r + d; if (rr >= 0 && rr < rows && tmp[rr * cols + c]) on = 1; }
      out[r * cols + c] = on;
    }
  }
  return out;
}

/** 4-connected components of the truthy cells; returns each cell-bbox. */
function gridComponents(grid, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const comps = [];
  const stack = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const idx = r * cols + c;
      if (!grid[idx] || seen[idx]) continue;
      let minR = r, maxR = r, minC = c, maxC = c;
      stack.push(idx); seen[idx] = 1;
      while (stack.length) {
        const p = stack.pop();
        const pr = (p / cols) | 0, pc = p % cols;
        if (pr < minR) minR = pr; if (pr > maxR) maxR = pr;
        if (pc < minC) minC = pc; if (pc > maxC) maxC = pc;
        const nb = [pc > 0 ? p - 1 : -1, pc < cols - 1 ? p + 1 : -1, p - cols, p + cols];
        for (const q of nb) { if (q < 0 || q >= grid.length || seen[q] || !grid[q]) continue; seen[q] = 1; stack.push(q); }
      }
      comps.push({ minR, maxR, minC, maxC });
    }
  }
  return comps;
}
