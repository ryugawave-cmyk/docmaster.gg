/**
 * PDF export — flatten the editor to a PDF (dependency-free).
 *
 * MVP goal: reliably produce a PDF where the user's edits (replaced text/numbers,
 * deleted values) are visible. We render each page to a canvas — the original
 * page raster, plus every object composited on top exactly as shown (imported
 * runs the user edited are masked + re-drawn; untouched imported runs are left to
 * the raster) — encode it as JPEG, and hand-write a minimal PDF that embeds one
 * image per page. This is WYSIWYG and robust; the trade-off is that exported text
 * isn't selectable, which is fine for form/value editing.
 *
 * `buildPdf()` is pure byte assembly (unit-testable in Node); `exportEditorToPdf()`
 * needs the DOM/canvas and drives the compositing.
 */
import { shapeSvgMarkup } from './blankPdfEditor.js';
import { stampSvgMarkup } from './stampLibrary.js';

const PX_TO_PT = 72 / 96;   // CSS px (@96dpi) → PDF points
const RENDER_SCALE = 2;     // canvas oversample for crisp text/edits
const JPEG_QUALITY = 0.92;

/* --------------------------- emptiness guard ---------------------------- */
// Whether the export will actually PAINT anything. This mirrors `drawObject`
// exactly (see below): an empty text box, an imported-but-unrevealed run, a
// srcless image, or a draw/link object all composite to nothing. Callers use
// this to refuse a download that would produce silent white pages — which reads
// to the user as a broken "empty PDF". Pure (no DOM), so it is Node-testable.
function hasInk(html) {
  if (!html) return false;
  if (/<img\b/i.test(String(html))) return true; // inline image counts as content
  return /\S/.test(String(html).replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' '));
}
function hasMask(obj) {
  return (obj.highlight && obj.highlight !== 'transparent')
    || (obj.boxBg && obj.boxBg !== 'transparent');
}
export function objectRenders(obj) {
  switch (obj && obj.type) {
    case 'text':
    case 'comment':
      if (obj.imported && !obj.revealed) return false; // baked into the raster
      return hasInk(obj.text) || hasMask(obj);
    case 'image': return !!obj.src;
    case 'shape':
    case 'stamp': return true;
    default: return false; // draw / link / signature are not composited
  }
}
export function modelHasVisibleContent(model) {
  return !!model && (model.pages || []).some(
    (p) => p.bg || (p.objects || []).some(objectRenders),
  );
}

/**
 * @param {{PW:number,PH:number,pages:{bg:string|null,objects:object[]}[]}} model
 * @returns {Promise<Blob>}
 */
/**
 * Composite one page (its raster background + every object) onto a fresh canvas
 * at `scale`. Each page uses its OWN width/height (falling back to the document
 * size) so a merged/converted document with mixed page sizes exports correctly.
 * @returns {Promise<{canvas:HTMLCanvasElement,pw:number,ph:number,pxW:number,pxH:number}>}
 */
export async function renderPageCanvas(pg, model, s) {
  const pw = pg.w || model.PW, ph = pg.h || model.PH;
  const pxW = Math.max(1, Math.round(pw * s)), pxH = Math.max(1, Math.round(ph * s));
  const canvas = document.createElement('canvas');
  canvas.width = pxW; canvas.height = pxH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pxW, pxH);
  if (pg.bg) await drawRaster(ctx, pg.bg, 0, 0, pxW, pxH);
  for (const obj of (pg.objects || [])) {
    try { await drawObject(ctx, obj, s); } catch { /* skip an object that fails to render */ }
  }
  return { canvas, pw, ph, pxW, pxH };
}

/**
 * @param {{PW:number,PH:number,pages:{bg:string|null,w?:number,h?:number,objects:object[]}[]}} model
 * @param {{scale?:number,quality?:number,pageIndices?:number[],
 *   onPage?:(info:{index:number,pw:number,ph:number,filter:string,sig:object|null})=>void}} [opts]
 *   scale — canvas oversample (lower = smaller file, for Compress);
 *   quality — JPEG quality 0..1; pageIndices — export only these pages (Split/Extract);
 *   onPage — fired per page with its dimensions, chosen codec and a cheap visual
 *   fingerprint (see `pageSignature`) so the compressor can verify the output
 *   page-by-page against a reference render without decoding the PDF back.
 * @returns {Promise<Blob>}
 */
export async function exportEditorToPdf(model, opts = {}) {
  const s = opts.scale || RENDER_SCALE;
  const quality = opts.quality || JPEG_QUALITY;
  const indices = opts.pageIndices || model.pages.map((_, i) => i);
  const outPages = [];

  for (const i of indices) {
    const pg = model.pages[i];
    if (!pg) continue;
    const { canvas, pw, ph, pxW, pxH } = await renderPageCanvas(pg, model, s);
    const enc = await encodePage(canvas, quality);
    if (opts.onPage) {
      opts.onPage({ index: i, pw, ph, filter: enc.filter, sig: pageSignature(canvas) });
    }
    outPages.push({
      bytes: enc.bytes,
      filter: enc.filter,
      pxW, pxH,
      ptW: pw * PX_TO_PT,
      ptH: ph * PX_TO_PT,
    });
  }

  return new Blob([buildPdf(outPages)], { type: 'application/pdf' });
}

/**
 * A cheap, comparable fingerprint of a rendered page: the canvas is downsampled
 * to 32×32 and reduced to an ink ratio (non-white fraction), mean luma, and luma
 * range. The compressor compares a compressed page's fingerprint against the
 * full-quality reference to catch pages that came out blank, all-black, or that
 * lost most of their content — i.e. a page-by-page sanity check on the output.
 * Returns null if the canvas is tainted (getImageData throws).
 */
export function pageSignature(canvas) {
  const S = 32;
  const off = document.createElement('canvas');
  off.width = S; off.height = S;
  const c = off.getContext('2d', { alpha: false });
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, S, S);
  c.drawImage(canvas, 0, 0, S, S);
  let data;
  try { data = c.getImageData(0, 0, S, S).data; } catch { return null; }
  let ink = 0, sum = 0, min = 255, max = 0;
  const n = S * S;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    sum += l;
    if (l < min) min = l;
    if (l > max) max = l;
    if (l < 245) ink += 1;
  }
  return { ink: ink / n, mean: sum / n, min, max };
}

/**
 * Encode one page canvas for embedding. We produce a JPEG at the requested
 * quality AND — when the platform and canvas allow it — a LOSSLESS deflated RGB
 * stream, then keep whichever is smaller. Text- and line-art-heavy pages (forms,
 * receipts, screenshots) deflate extremely well and stay pixel-perfect, so they
 * are shipped losslessly instead of picking up JPEG ringing around sharp edges;
 * photographic pages fall back to the smaller JPEG. This is what lets "maximum
 * compression" shrink a document without destroying its text.
 * @returns {Promise<{bytes:Uint8Array,filter:'DCTDecode'|'FlateDecode'}>}
 */
async function encodePage(canvas, quality) {
  const jpeg = dataURLToBytes(canvas.toDataURL('image/jpeg', quality));
  const lossless = await encodeLossless(canvas);
  if (lossless && lossless.length < jpeg.length) {
    return { bytes: lossless, filter: 'FlateDecode' };
  }
  return { bytes: jpeg, filter: 'DCTDecode' };
}

/**
 * Lossless RGB → zlib (FlateDecode) encoding via CompressionStream. Returns null
 * when unavailable (older engine) or when the canvas is tainted by a cross-origin
 * image (getImageData throws) — callers then keep the JPEG. The zlib wrapper that
 * `CompressionStream('deflate')` emits is exactly what PDF /FlateDecode expects.
 */
async function encodeLossless(canvas) {
  if (typeof CompressionStream === 'undefined') return null;
  let rgba;
  try {
    rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  } catch { return null; } // tainted canvas — fall back to JPEG
  const px = canvas.width * canvas.height;
  const rgb = new Uint8Array(px * 3);
  for (let i = 0, j = 0; i < px; i += 1, j += 4) {
    rgb[i * 3] = rgba[j]; rgb[i * 3 + 1] = rgba[j + 1]; rgb[i * 3 + 2] = rgba[j + 2];
  }
  try {
    return await deflate(rgb);
  } catch { return null; }
}

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const chunks = [];
  let total = 0;
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/* ----------------------------- compositing ------------------------------ */

async function drawObject(ctx, obj, s) {
  const x = obj.x * s, y = obj.y * s, w = obj.w * s, h = obj.h * s;

  // Rotation is flattened about the box centre for every vector/raster object,
  // mirroring the on-screen `transform: rotate`. SVG stamps/shapes are rasterised
  // at box size *before* this rotate, so they stay crisp at any angle. Text has no
  // rotate handle and always exports upright.
  const rotated = obj.rotation && obj.type !== 'text' && obj.type !== 'comment';
  if (rotated) {
    const cx = x + w / 2, cy = y + h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((obj.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  try {
    if (obj.type === 'text' || obj.type === 'comment') {
      // Untouched imported text is already in the raster — don't double-draw it.
      if (obj.imported && !obj.revealed) return;
      const mask = maskColor(obj);
      if (mask) { ctx.save(); ctx.globalAlpha = obj.opacity ?? 1; ctx.fillStyle = mask; ctx.fillRect(x, y, w, h); ctx.restore(); }
      drawTextBox(ctx, obj, s);
      return;
    }
    if (obj.type === 'image' && obj.src) {
      const img = await loadImage(obj.src);
      ctx.save();
      ctx.globalAlpha = obj.opacity ?? 1;
      if (obj.radius) roundClip(ctx, x, y, w, h, obj.radius * s);
      // Signatures carry a sampled paper colour: fill the box first so the
      // transparent ink flattens onto matching paper (and hides what was beneath).
      if (obj.boxBg && obj.boxBg !== 'transparent') { ctx.fillStyle = obj.boxBg; ctx.fillRect(x, y, w, h); }
      fitDraw(ctx, img, x, y, w, h, obj.fit || 'contain');
      ctx.restore();
      return;
    }
    if (obj.type === 'shape') {
      let svg = shapeSvgMarkup(obj);
      // The markup has only a viewBox; give the raster explicit pixel dimensions.
      svg = svg.replace('<svg ', `<svg width="${Math.max(1, Math.round(w))}" height="${Math.max(1, Math.round(h))}" `);
      const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      ctx.save();
      ctx.globalAlpha = obj.opacity ?? 1;
      ctx.drawImage(img, x, y, w, h);
      ctx.restore();
      return;
    }
    if (obj.type === 'stamp') {
      let svg = stampSvgMarkup(obj);
      svg = svg.replace('<svg ', `<svg width="${Math.max(1, Math.round(w))}" height="${Math.max(1, Math.round(h))}" `);
      const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      ctx.save();
      ctx.globalAlpha = obj.opacity ?? 1;
      ctx.drawImage(img, x, y, w, h);
      ctx.restore();
      return;
    }
    // draw/link/signature: not part of the text-editing MVP — skipped.
  } finally {
    if (rotated) ctx.restore();
  }
}

/**
 * Render a text box as RICH text: the box HTML is split into character runs, each
 * carrying its own colour/weight/style/size (inline <span style="color…">, <b>,
 * <i>, <u>, <s>, sub/sup, plus <br>/block line breaks). Text with no inline
 * markup renders as one run using the box defaults. Runs are word-wrapped across
 * the box width and drawn individually, so partial (character-level) formatting —
 * e.g. one word coloured differently — is preserved exactly in the exported PDF.
 */
function drawTextBox(ctx, obj, s) {
  const base = {
    color: obj.color || '#111827',
    bold: !!obj.bold, italic: !!obj.italic, underline: !!obj.underline, strike: !!obj.strike,
    fontFamily: obj.fontFamily || 'Arial, sans-serif',
    fontSize: obj.fontSize || 16,
    highlight: null,
  };
  const runs = extractRuns(obj.text, base);
  if (!runs.some((r) => !r.br && /\S/.test(r.text || ''))) return;

  const padX = (obj.imported ? 0 : 4) * s;
  const padY = (obj.imported ? 0 : 2) * s;
  const boxX = obj.x * s, boxY = obj.y * s, boxW = obj.w * s;
  const maxW = boxW - padX * 2;
  const align = obj.align || 'left';
  const lhFactor = obj.lineHeight || 1.2;

  ctx.save();
  ctx.globalAlpha = obj.opacity ?? 1;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const setFont = (st) => { ctx.font = `${st.italic ? 'italic ' : ''}${st.bold ? '700' : '400'} ${st.fontSize * s}px ${st.fontFamily}`; };

  // Logical lines (split on <br>/block breaks); each a list of styled runs.
  const logical = [[]];
  for (const r of runs) {
    if (r.br) { logical.push([]); continue; }
    if (r.text) logical[logical.length - 1].push(r);
  }

  // Tokenise (keeping whitespace) and word-wrap each logical line to the box.
  const visual = [];
  for (const line of logical) {
    const tokens = [];
    for (const run of line) {
      setFont(run);
      for (const piece of run.text.split(/(\s+)/)) {
        if (piece === '') continue;
        tokens.push({ str: piece, st: run, w: ctx.measureText(piece).width });
      }
    }
    if (!tokens.length) { visual.push({ tokens: [], width: 0, maxFs: base.fontSize * s }); continue; }
    let cur = [], curW = 0;
    const flush = () => { visual.push(makeLine(cur, s, base)); cur = []; curW = 0; };
    for (const tk of tokens) {
      if (curW + tk.w > maxW && cur.some((t) => t.str.trim()) && tk.str.trim()) flush();
      cur.push(tk); curW += tk.w;
    }
    if (cur.length) flush();
  }

  let ty = boxY + padY;
  for (const vl of visual) {
    let x = boxX + padX;
    if (align === 'center') x = boxX + boxW / 2 - vl.width / 2;
    else if (align === 'right') x = boxX + boxW - padX - vl.width;
    for (const tk of vl.tokens) {
      setFont(tk.st);
      const fs = tk.st.fontSize * s;
      if (tk.st.highlight) { ctx.save(); ctx.fillStyle = tk.st.highlight; ctx.fillRect(x, ty, tk.w, vl.maxFs); ctx.restore(); }
      ctx.fillStyle = tk.st.color;
      ctx.fillText(tk.str, x, ty);
      if (tk.st.underline) strokeH(ctx, x, ty + fs * 0.92, tk.w, tk.st.color, fs);
      if (tk.st.strike) strokeH(ctx, x, ty + fs * 0.54, tk.w, tk.st.color, fs);
      x += tk.w;
    }
    ty += vl.maxFs * lhFactor;
  }
  ctx.restore();
}

/** Finalise a wrapped visual line: drop trailing whitespace (for width/align)
 *  and record its rendered width + tallest run (for line height). */
function makeLine(tokens, s, base) {
  let end = tokens.length;
  while (end > 0 && !tokens[end - 1].str.trim()) end -= 1;
  const kept = tokens.slice(0, end);
  let width = 0, maxFs = 0;
  for (const tk of kept) { width += tk.w; maxFs = Math.max(maxFs, tk.st.fontSize * s); }
  return { tokens: kept, width, maxFs: maxFs || base.fontSize * s };
}

function strokeH(ctx, x, y, w, color, fs) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, fs * 0.06);
  ctx.beginPath();
  ctx.moveTo(x, Math.round(y) + 0.5);
  ctx.lineTo(x + w, Math.round(y) + 0.5);
  ctx.stroke();
  ctx.restore();
}

function maskColor(obj) {
  if (obj.highlight && obj.highlight !== 'transparent') return obj.highlight;
  if (obj.boxBg && obj.boxBg !== 'transparent') return obj.boxBg;
  return null;
}

const BLOCK_TAGS = new Set(['DIV', 'P', 'LI']);

/**
 * Parse a text box's contenteditable HTML into a flat list of styled runs plus
 * `{br:true}` line-break markers. Each run inherits the box defaults and layers
 * on any tag- or inline-style-based overrides (colour, weight, italic,
 * under/strike, family, size, highlight) it sits inside — the character-level
 * formatting the editor stored. Runs in DOM order === visual order.
 */
function extractRuns(html, base) {
  const runs = [];
  const pushBr = () => { if (runs.length && !runs[runs.length - 1].br) runs.push({ br: true }); };
  if (!html) return [{ ...base, text: '' }];
  const root = document.createElement('div');
  root.innerHTML = String(html);

  const walk = (node, st) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (child.nodeValue) runs.push({ ...st, text: child.nodeValue });
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === 'BR') { pushBr(); continue; }
        const block = BLOCK_TAGS.has(tag);
        if (block) pushBr(); // a block element starts a new line
        const ns = { ...st };
        if (tag === 'B' || tag === 'STRONG') ns.bold = true;
        if (tag === 'I' || tag === 'EM') ns.italic = true;
        if (tag === 'U') ns.underline = true;
        if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') ns.strike = true;
        if (tag === 'SUP' || tag === 'SUB') ns.fontSize = Math.max(6, ns.fontSize * 0.7);
        const cs = child.style;
        if (cs) {
          if (cs.color) ns.color = cs.color;
          if (cs.backgroundColor) ns.highlight = cs.backgroundColor;
          if (cs.fontWeight) ns.bold = /^(bold|[6-9]00)$/.test(cs.fontWeight) ? true : (cs.fontWeight === 'normal' ? false : ns.bold);
          if (cs.fontStyle === 'italic') ns.italic = true; else if (cs.fontStyle === 'normal') ns.italic = false;
          if (cs.fontFamily) ns.fontFamily = cs.fontFamily.replace(/["']/g, '');
          if (/px$/.test(cs.fontSize || '')) ns.fontSize = parseFloat(cs.fontSize) || ns.fontSize;
          const td = cs.textDecorationLine || cs.textDecoration || '';
          if (/underline/.test(td)) ns.underline = true;
          if (/line-through/.test(td)) ns.strike = true;
        }
        if (tag === 'MARK' && !ns.highlight) ns.highlight = '#ffe64d';
        walk(child, ns);
      }
    }
  };
  walk(root, { ...base });
  while (runs.length && runs[runs.length - 1].br) runs.pop(); // drop trailing breaks
  return runs;
}

function fitDraw(ctx, img, x, y, w, h, fit) {
  if (fit === 'fill' || !img.width || !img.height) { ctx.drawImage(img, x, y, w, h); return; }
  const ir = img.width / img.height;
  let dw = w, dh = w / ir;
  if (fit === 'cover' ? dh < h : dh > h) { dh = h; dw = h * ir; }
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function roundClip(ctx, x, y, w, h, r) { roundRectPath(ctx, x, y, w, h, r); ctx.clip(); }

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
async function drawRaster(ctx, url, x, y, w, h) {
  const img = await loadImage(url);
  ctx.drawImage(img, x, y, w, h);
}

/* --------------------------- minimal PDF writer -------------------------- */

export function dataURLToBytes(url) {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * Assemble a PDF that embeds one image per page. Each page's `filter` picks the
 * image codec: 'DCTDecode' (JPEG bytes) or 'FlateDecode' (deflated raw RGB);
 * defaults to DCTDecode.
 * @param {{bytes:Uint8Array,pxW:number,pxH:number,ptW:number,ptH:number,filter?:string}[]} pages
 * @returns {Uint8Array}
 */
export function buildPdf(pages) {
  const enc = new TextEncoder();
  const parts = [];
  let length = 0;
  const put = (data) => { const u8 = typeof data === 'string' ? enc.encode(data) : data; parts.push(u8); length += u8.length; };

  const objCount = 2 + pages.length * 3;
  const offsets = new Array(objCount + 1).fill(0);
  const mark = (n) => { offsets[n] = length; };

  put('%PDF-1.4\n');
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker

  mark(1);
  put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  mark(2);
  put(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);

  pages.forEach((pg, i) => {
    const po = 3 + i * 3, co = 4 + i * 3, io = 5 + i * 3;
    const ptW = round2(pg.ptW), ptH = round2(pg.ptH);

    mark(po);
    put(`${po} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptW} ${ptH}] `
      + `/Resources << /XObject << /Im0 ${io} 0 R >> >> /Contents ${co} 0 R >>\nendobj\n`);

    const stream = `q\n${ptW} 0 0 ${ptH} 0 0 cm\n/Im0 Do\nQ\n`;
    mark(co);
    put(`${co} 0 obj\n<< /Length ${enc.encode(stream).length} >>\nstream\n`);
    put(stream);
    put('endstream\nendobj\n');

    const filter = pg.filter || 'DCTDecode';
    mark(io);
    put(`${io} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pg.pxW} /Height ${pg.pxH} `
      + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /${filter} /Length ${pg.bytes.length} >>\nstream\n`);
    put(pg.bytes);
    put('\nendstream\nendobj\n');
  });

  const xrefOffset = length;
  let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= objCount; n += 1) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  put(xref);
  put(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const out = new Uint8Array(length);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function round2(n) { return Math.round(n * 100) / 100; }
