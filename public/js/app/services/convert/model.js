/**
 * Conversion content model.
 *
 * Every converter (DOCX / XLSX / PPTX / HTML) works from the SAME normalised
 * view of the document, derived from the editor's WYSIWYG export model
 * (`engine.getExportModel()`). We do NOT re-parse the PDF: the editor already
 * holds every text run as a positioned object (imported PDF runs included) plus
 * each page's raster background and any discrete image objects. Reusing that
 * keeps conversions consistent with what the user sees and avoids duplicating
 * extraction logic.
 *
 * The normalised model exposes, per page: positioned text runs (plain text +
 * font metadata), discrete images (NOT the page-background raster), and the page
 * raster itself (used only where a visual backdrop is legitimately wanted, never
 * as a substitute for real text). It also builds a reading-order paragraph
 * stream for the "editable" conversions.
 *
 * @typedef {{ text:string, x:number, y:number, w:number, h:number,
 *   fontSize:number, fontFamily:string, bold:boolean, italic:boolean,
 *   color:string, align:string }} Run
 * @typedef {{ src:string, x:number, y:number, w:number, h:number }} Img
 * @typedef {{ index:number, w:number, h:number, bg:(string|null),
 *   runs:Run[], images:Img[] }} PageContent
 * @typedef {{ type:'heading'|'paragraph'|'bullet', text:string, level:number,
 *   page:number }} Block
 */

/** Strip HTML to plain text, decoding entities (browser DOM available here). */
export function htmlToPlain(html) {
  if (!html) return '';
  let s = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');
  if (typeof document !== 'undefined') {
    const ta = document.createElement('textarea');
    ta.innerHTML = s;
    s = ta.value;
  } else {
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
  }
  return s.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function fontStack(f) {
  const s = (f || '').toLowerCase();
  if (s.includes('mono') || s.includes('courier')) return 'Consolas';
  if ((s.includes('serif') && !s.includes('sans')) || s.includes('times') || s.includes('georgia')) return 'Times New Roman';
  return 'Calibri';
}

const wmKey = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * A decorative watermark BAND — a phrase repeated back-to-back inside ONE run,
 * e.g. "STAFF SELECTION COMMISSION STAFF SELECTION COMMISSION …". PDF.js often
 * returns a whole side/centre band as a single text item, which slips past the
 * duplicate-run watermark filter and then floods the converted document (a giant
 * horizontal or vertical strip). Detection is GENERIC — a word-phrase (≥2 words,
 * ≥6 chars) that repeats ≥3 times from the start — so no per-document strings and
 * real content (unique lines, short repeats like "NA NA") is never touched.
 */
function isWatermarkBand(text) {
  const words = wmKey(text).split(' ').filter(Boolean);
  if (words.length < 4) return false;
  for (let unit = 1; unit <= Math.floor(words.length / 3); unit += 1) {
    const phrase = words.slice(0, unit).join(' ');
    // A single-word band ("CONFIDENTIAL"×N) must be a long word repeated ≥4×, so
    // short repeats like "NA NA NA" survive; multi-word phrases need ≥6 chars, ≥3×.
    const minLen = unit === 1 ? 8 : 6;
    const minReps = unit === 1 ? 4 : 3;
    if (phrase.length < minLen) continue;
    let reps = 0;
    while ((reps + 1) * unit <= words.length
      && words.slice(reps * unit, (reps + 1) * unit).join(' ') === phrase) reps += 1;
    if (reps >= minReps) return true;
  }
  return false;
}

/** Remove watermark runs before any converter sees them: an in-run repeated band
 *  (isWatermarkBand) or the SAME long run duplicated ≥5× across the page. */
function stripWatermarks(runs) {
  const freq = new Map();
  for (const r of runs) { const k = wmKey(r.text); if (k.length >= 8) freq.set(k, (freq.get(k) || 0) + 1); }
  return runs.filter((r) => {
    if (isWatermarkBand(r.text)) return false;
    const k = wmKey(r.text);
    return !(k.length >= 8 && (freq.get(k) || 0) >= 5);
  });
}

/**
 * Normalise the editor export model into per-page content.
 * @param {{PW:number,PH:number,pages:{bg?:string|null,w?:number,h?:number,objects:any[]}[]}} model
 * @param {string} [name]
 */
export function buildContentModel(model, name = 'document') {
  const PW = model.PW, PH = model.PH;
  const pages = (model.pages || []).map((p, index) => {
    const w = p.w || PW, h = p.h || PH;
    const runs = [];
    const images = [];
    for (const o of (p.objects || [])) {
      if (o.type === 'text' || o.type === 'comment') {
        const text = htmlToPlain(o.text);
        if (!text.trim()) continue;
        runs.push({
          text,
          x: o.x || 0, y: o.y || 0, w: o.w || 0, h: o.h || 0,
          fontSize: o.fontSize || 16,
          fontFamily: fontStack(o.fontFamily),
          bold: !!o.bold,
          italic: !!o.italic,
          color: normHex(o.color) || '111827',
          align: o.align || 'left',
          // `boxBg` is the page colour sampled behind an imported run; the
          // position-faithful DOCX fills the text box with it to mask the glyph
          // baked into the page-background raster (so editing hides the original).
          boxBg: o.imported ? (normHex(o.boxBg) || '') : '',
          imported: !!o.imported,
        });
      } else if (o.type === 'image' && o.src) {
        images.push({ src: o.src, x: o.x || 0, y: o.y || 0, w: o.w || 0, h: o.h || 0 });
      }
    }
    // Images recovered from an imported PDF's page (real embedded XObjects at their
    // exact position/size — logos, signatures, seals, barcodes, photos). Kept off
    // the editable object layer, so pull them straight from the page here.
    for (const im of (p.images || [])) {
      if (im && im.src) images.push({ src: im.src, x: im.x || 0, y: im.y || 0, w: im.w || 0, h: im.h || 0 });
    }
    // Reading order: top-to-bottom, then left-to-right.
    const kept = stripWatermarks(runs);
    kept.sort((a, b) => (Math.abs(a.y - b.y) > Math.min(a.h, b.h) * 0.6 ? a.y - b.y : a.x - b.x));
    return { index, w, h, bg: p.bg || null, runs: kept, images };
  });

  const hasText = pages.some((p) => p.runs.length > 0);
  const hasImages = pages.some((p) => p.images.length > 0);
  return {
    name: (name || 'document').replace(/\.[^.]+$/, ''),
    PW, PH, pages, hasText, hasImages,
    blocks: buildBlocks(pages),
  };
}

/**
 * Group positioned runs into a reading-order block stream (headings, paragraphs,
 * bullet items) for the "editable" conversions. Lines on the same baseline are
 * merged; a larger vertical gap starts a new paragraph; a notably larger font
 * becomes a heading; a leading bullet/number becomes a list item.
 * @returns {Block[]}
 */
function buildBlocks(pages) {
  const blocks = [];
  // Establish a body font size (median) to judge what counts as a heading.
  const sizes = [];
  for (const p of pages) for (const r of p.runs) sizes.push(r.fontSize);
  sizes.sort((a, b) => a - b);
  const body = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 16;

  for (const p of pages) {
    // Merge runs into lines by y proximity.
    const lines = [];
    for (const r of p.runs) {
      const last = lines[lines.length - 1];
      // Track the line's height so same-baseline runs actually group (without an
      // `h` the tolerance is NaN and every run becomes its own line/paragraph).
      if (last && Math.abs(r.y - last.y) <= Math.min(r.h, last.h) * 0.6) {
        last.parts.push(r);
        last.y = (last.y + r.y) / 2;
        last.h = Math.max(last.h, r.h);
      } else {
        lines.push({ y: r.y, h: r.h, parts: [r] });
      }
    }
    let prevBottom = null;
    for (const line of lines) {
      line.parts.sort((a, b) => a.x - b.x);
      const parts = coalesceLineRuns(line.parts);
      const text = parts.map((r) => r.text.replace(/\n/g, ' ')).join(' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const size = Math.max(...parts.map((r) => r.fontSize));
      const bold = parts.every((r) => r.bold);
      const top = Math.min(...parts.map((r) => r.y));
      const gap = prevBottom == null ? 0 : top - prevBottom;
      prevBottom = Math.max(...parts.map((r) => r.y + r.h));

      const bulletMatch = text.match(/^\s*([•\-\*]|\d+[.)])\s+(.*)$/);
      if (bulletMatch) {
        blocks.push({ type: 'bullet', text: bulletMatch[2], level: 0, page: p.index });
        continue;
      }
      const isHeading = (size >= body * 1.35 || (bold && size >= body * 1.1)) && text.length <= 120;
      if (isHeading) {
        const level = size >= body * 1.9 ? 1 : size >= body * 1.5 ? 2 : 3;
        blocks.push({ type: 'heading', text, level, page: p.index });
      } else {
        // Big vertical gap → new paragraph; otherwise append to the running one.
        const last = blocks[blocks.length - 1];
        if (last && last.type === 'paragraph' && gap > 0 && gap < body * 0.9 && last.page === p.index) {
          last.text += ' ' + text;
        } else {
          blocks.push({ type: 'paragraph', text, level: 0, page: p.index });
        }
      }
    }
  }
  return blocks;
}

/**
 * Coalesce a line's runs (already sorted left-to-right, sharing a baseline) into
 * contiguous text segments.
 *
 * PDF text extraction — and some editors — split a single word or phrase into
 * several adjacent runs with NO real gap between them (kerning pairs, form-field
 * glyphs, ligatures). Joined naively that yields torn words ("state" → "stat e")
 * and, worse, phantom table columns when each fragment's x is clustered as its
 * own column. We merge neighbours whose horizontal gap is smaller than a real
 * column separator into one run, inserting a space only where the gap (or
 * existing whitespace) marks a genuine word break. The merged run keeps the
 * FIRST fragment's style/position, extended to cover the whole segment.
 *
 * @param {Run[]} runs runs on one baseline, sorted ascending by x
 * @returns {Run[]}
 */
export function coalesceLineRuns(runs) {
  const out = [];
  for (const r of runs) {
    const prev = out[out.length - 1];
    if (prev) {
      const fs = Math.max(prev.fontSize || 12, r.fontSize || 12);
      const gap = r.x - (prev.x + (prev.w || 0));
      // A column separator is a gap wider than ~1.2 em; anything tighter belongs
      // to the same text segment and must not spawn a new cell/column.
      if (gap <= fs * 1.2) {
        // A real inter-word space is ≥ ~0.2 em; a mid-word glyph split is ≈ 0 em.
        // 0.15 em sits between them with margin, biased (like pdfminer) toward
        // KEEPING spaces — a dropped space ("dueis") reads worse than a stray one.
        const space = gap > fs * 0.15 || /\s$/.test(prev.text) || /^\s/.test(r.text);
        prev.text = prev.text.replace(/\s+$/, '') + (space ? ' ' : '') + r.text.replace(/^\s+/, '');
        const right = Math.max(prev.x + (prev.w || 0), r.x + (r.w || 0));
        prev.w = right - prev.x;
        prev.h = Math.max(prev.h || 0, r.h || 0);
        prev.y = Math.min(prev.y, r.y);
        continue;
      }
    }
    out.push({ ...r });
  }
  return out;
}

/**
 * True when a string contains complex-script text — Indic (Devanagari, Bengali,
 * Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala), plus
 * Arabic/Syriac/Hebrew/Thaana and the SE-Asian shaping scripts (Thai, Lao,
 * Tibetan, Myanmar, Khmer). These are extracted from a PDF glyph-by-glyph with
 * unreliable ToUnicode mapping and ordering: vowel signs (matras) detach or
 * reorder and conjuncts drop glyphs, so a per-run editable overlay SCRAMBLES the
 * text. On an imported page the script is already drawn correctly in the page
 * raster, so the position-faithful ("Exact") DOCX leaves such runs BAKED —
 * rasterImages keeps them in the raster and docx skips their overlay box —
 * instead of covering good pixels with an editable-but-wrong overlay.
 *
 * NOT flagged (they extract & render fine as normal editable runs): Latin with
 * diacritics (German ä/ö/ü/ß, Spanish ñ, French ç, Polish, Turkish, Vietnamese),
 * Greek, Cyrillic, and CJK (Chinese/Japanese/Korean).
 */
export function hasComplexScript(text) {
  return /[֐-ݏހ-޿ऀ-႟ក-៿]/.test(String(text == null ? '' : text));
}

export function normHex(c) {
  if (!c) return '';
  const m = String(c).trim().match(/^#?([0-9a-f]{6})$/i);
  if (m) return m[1].toLowerCase();
  const m3 = String(c).trim().match(/^#?([0-9a-f]{3})$/i);
  if (m3) return m3[1].split('').map((x) => x + x).join('').toLowerCase();
  return '';
}

/* -------- unit conversions shared by the OOXML converters -------- */
export const PX_TO_PT = 72 / 96;          // CSS px (@96dpi) → points
export const PX_TO_TWIP = (72 / 96) * 20; // px → twips (1/20 pt)
export const PX_TO_EMU = 9525;            // px → EMU (914400/96)

/** Escape text for XML content/attributes. */
export function xml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
