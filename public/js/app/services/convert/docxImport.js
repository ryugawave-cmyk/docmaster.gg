/**
 * DOCX → Unified Document Model (block/flow) importer.
 *
 * Reads a .docx (a ZIP of OOXML) entirely in the browser and produces the same
 * block model the Document editor edits: headings, paragraphs, lists, tables and
 * inline images with run-level formatting (bold/italic/underline, font, size,
 * colour). Unzipping uses the platform `DecompressionStream` (raw DEFLATE); there
 * is no third-party dependency.
 *
 * Best-effort by design: unknown parts are skipped, never fatal — a document
 * that references features we don't map still imports its text and structure.
 */
import {
  createDocument, createParagraph, createRun, createListBlock,
  createImageBlock, createTableBlock, DEFAULT_MARKS, DEFAULT_PAGE,
} from '../../model/documentModel.js';
import { fitBoxFontToInk } from './positionedImport.js';

const PT_TO_PX = 96 / 72;
const EMU_PER_PX = 9525;                 // OOXML EMU per CSS px @96dpi
// Word's real defaults for a paragraph that carries NO explicit size / spacing, so
// imported text is laid out with Word-like metrics instead of the editor's larger
// "web document" defaults (Inter 16px / line-height 1.4 / 10px after). Getting these
// right is what keeps the imported page COUNT close to the source: the wrong defaults
// inflate every line by ~40% and add a margin after every paragraph, which is what
// turned a 6-page Word file into ~18 editor pages. See readParagraph.
const WORD_DEFAULT_SIZE_PX = Math.round(11 * PT_TO_PX); // 11pt (Calibri body) ≈ 15px
const WORD_DEFAULT_LINE = 1.15;                          // Word "single" renders ≈1.15

/** Debug logging (page size / margins / font sizes / line-heights / image dims) to
 *  diagnose why an import's page count differs from the source. Off by default; turn
 *  on with `localStorage.DOCX_DEBUG = '1'` (browser) or `globalThis.__DOCX_DEBUG = true`. */
function docxDebugOn() {
  try { if (globalThis.__DOCX_DEBUG) return true; } catch { /* no global */ }
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('DOCX_DEBUG') === '1'; } catch { return false; }
}
function dbg(...args) { if (docxDebugOn()) { try { console.log('[docx-import]', ...args); } catch { /* ignore */ } } }
// Cap the per-paragraph debug lines so a long document doesn't flood the console;
// reset at the start of each import (see docxToBlockModel).
let dbgParaBudget = 0;
// Word's 16 named highlight (marker) colours → hex, so an imported <w:highlight> maps
// back to the editor's background-colour highlight model. See blockExport for the inverse.
const HIGHLIGHT_HEX = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff',
  blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080',
  darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000',
  darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};
const PAGE_GAP_PX = 28;                  // must match documentEditor.js PAGE_GAP (page-stack gap)
const TWIP_TO_PX = (tw) => (parseInt(tw, 10) / 20) * PT_TO_PX;   // 20 twips = 1pt
const HALFPT_TO_PX = (hp) => (parseInt(hp, 10) / 2) * PT_TO_PX;  // w:sz is half-points

/** @param {ArrayBuffer} buf @param {string} [title] */
export async function docxToBlockModel(buf, title = 'Document') {
  const files = await unzip(new Uint8Array(buf));
  const dec = new TextDecoder();

  const documentXml = files.get('word/document.xml');
  if (!documentXml) return createDocument({ title, source: 'docx' });

  const xml = new DOMParser().parseFromString(dec.decode(documentXml), 'application/xml');
  const relsXml = files.get('word/_rels/document.xml.rels');
  const rels = relsXml ? parseRels(dec.decode(relsXml)) : {};
  const numbering = files.get('word/numbering.xml') ? parseNumbering(dec.decode(files.get('word/numbering.xml'))) : {};
  // Styles carry the document defaults (font/size/spacing) and named paragraph
  // styles (Heading 1…, etc.). Real-world .docx put most formatting there rather
  // than inline, so resolving them is what keeps sizes and spacing faithful.
  // Theme (theme1.xml) resolves w:themeColor (e.g. accent1) and theme fonts
  // (majorHAnsi/minorHAnsi) that Word's built-in heading styles reference — without
  // it, a blue themed heading and the document's theme body font are lost. Parse it
  // BEFORE styles, since style rPr colours/fonts resolve through it.
  const themeXml = files.get('word/theme/theme1.xml');
  curTheme = themeXml ? parseTheme(dec.decode(themeXml)) : { colors: {}, fonts: {} };
  const stylesXml = files.get('word/styles.xml');
  const styleInfo = stylesXml ? parseStyles(dec.decode(stylesXml)) : { def: {}, byId: {} };

  const body = xml.getElementsByTagName('w:body')[0];
  if (!body) return createDocument({ title, source: 'docx' });

  // Our own PDF→Doc "positioned" Word export (docx.js positionedModelToDocx) encodes
  // each line as a page-anchored text FRAME (w:framePr) over a full-page behindDoc
  // raster, and embeds the ORIGINAL model as a sidecar for a lossless re-import. The
  // generic flow importer below would stack the frames into a column and expose the
  // text-erased raster (the broken re-import), so handle positioned docs specially:
  //   • sidecar present  → restore it verbatim (pixel-perfect), but ADOPT the frames'
  //     current text where it diverged (so edits made in MS Word are not lost to a
  //     stale sidecar);
  //   • no sidecar       → rebuild from the frames (older export / Word dropped it).
  if (isPositionedExport(body)) {
    const reconstructed = reconstructPositioned(body, files, rels, title);
    const sidecarModel = await readSidecarModel(files, dec);
    const doc = (sidecarModel && mergeSidecar(sidecarModel, reconstructed, title)) || reconstructed;
    if (doc) {
      // Match the editable overlay's size to the baked page image, so a DORMANT box
      // (sidecar path — original raster kept) doesn't look smaller when revealed for
      // editing. Enlarge-only; a no-op on the erased-raster reconstruction (no baked
      // glyph to measure) and in Node (no canvas). Never fatal.
      try { await fitBoxFontToInk(doc.pages || [], doc.blocks || []); } catch { /* leave sizes as-is */ }
      return doc;
    }
  }

  // Section properties → page size / margins (twips → px). Falls back to the model
  // default (A4) when absent, so a Letter document with 1" margins reproduces its
  // real content width — which drives wrapping and therefore pagination.
  // Sections carry the page setup. `sections[0]` is page 1's (what the doc opens at);
  // later sections may differ (a landscape page, wider margins, …). We open at the
  // FIRST section's geometry and tag each section-starting block with its own setup
  // (`pageOverride`) so the information survives into the model / export and a future
  // per-section canvas can honour it.
  const sections = readSections(body);
  const page = { ...DEFAULT_PAGE, ...(sections[0] || {}) };

  dbg('page size (px):', { width: page.width, height: page.height, orientation: page.orientation || (page.width > page.height ? 'landscape' : 'portrait') },
    'usable height (px):', page.height - ((page.margins && (page.margins.top + page.margins.bottom)) || (page.margin * 2)));
  dbg('margins (px):', page.margins || { all: page.margin });
  const mixed = sections.some((s) => geomDiffers(s, sections[0]));
  dbg(`sections: ${sections.length || 1}`, mixed ? '(MIXED page setups — opens at section 1; later sections tagged pageOverride)' : '(uniform page setup)');
  if (mixed) sections.forEach((s, i) => dbg(`  section ${i + 1}:`, { width: s.width, height: s.height, margins: s.margins }));
  dbg('doc default font size (px):', styleInfo.def.sizePx ?? `(none → ${WORD_DEFAULT_SIZE_PX})`,
    'family:', styleInfo.def.fontFamily || '(none → editor default)');
  dbg('doc default line-height:', styleInfo.def.lineHeight ?? (styleInfo.def.lineHeightPx != null ? `${styleInfo.def.lineHeightPx}px` : `(none → ${WORD_DEFAULT_LINE})`),
    'spaceBefore:', styleInfo.def.spaceBefore ?? 0, 'spaceAfter:', styleInfo.def.spaceAfter ?? 0);

  // Modal body font size (px), used to infer headings in documents that style
  // their headings with a large/bold font instead of Word heading styles — very
  // common in real-world and exported .docx. Without this the left outline stays
  // empty because nothing is tagged h1/h2/h3.
  const bodySize = computeBodySize(body);
  dbg('modal body size (px):', bodySize);
  dbgParaBudget = docxDebugOn() ? 12 : 0; // log the first dozen paragraphs' metrics

  // Document default run formatting, applied to table cells that carry no inline size
  // so they match the body text (not the model's generic 16px).
  const cellDefaults = {
    fontSize: styleInfo.def.sizePx || WORD_DEFAULT_SIZE_PX,
    fontFamily: styleInfo.def.fontFamily || undefined,
    color: styleInfo.def.color || undefined,
  };

  const blocks = [];
  let pendingList = null; // accumulate consecutive list paragraphs

  const flushList = () => { if (pendingList) { blocks.push(pendingList.block); pendingList = null; } };

  // Page tracking. A source page break (Word section/page break, or the per-page
  // section breaks our PDF→Word "layout" exporter emits) is carried as a forced
  // break on the NEXT block so the editor keeps the source's page count instead of
  // reflowing. `pageIndex` also lets us lift each page's floating images onto their
  // real page in the editor's single continuous page-stack (stride mirrors the
  // editor's page height + PAGE_GAP), so later-page pictures don't pile on page 1.
  const stride = (page.height || DEFAULT_PAGE.height) + PAGE_GAP_PX;
  let pageIndex = 0;
  let pendingBreak = false;
  // Section geometry tracking: we start in section 0 (the primary page). Crossing a
  // SECTION break (not a plain page break) advances into the next section, whose setup
  // is the next entry in `sections`. When that setup differs from page 1's, the next
  // in-flow block is tagged with a `pageOverride` so the change is carried in the model.
  let sectionIndex = 0;
  let pendingSectionGeom = null;
  const enterNextSection = () => {
    sectionIndex += 1;
    const geom = sections[sectionIndex];
    pendingSectionGeom = geom && geomDiffers(geom, sections[0]) ? geom : null;
  };
  // A floating image is positioned absolutely and is excluded from the editor's
  // flow pagination, so a forced break must NOT land on it — it would be ignored
  // and the page wouldn't break. Carry the break to the next in-flow block instead.
  const isFloating = (blk) => blk && blk.type === 'image' && blk.left != null && blk.top != null;
  const applyBreak = (blk) => {
    if (blk && pendingBreak && !isFloating(blk)) { blk.breakBefore = true; pendingBreak = false; }
    // Attach the new section's page setup to the first block of that section so a
    // per-section renderer/exporter can switch geometry there (harmless otherwise).
    if (blk && pendingSectionGeom && !isFloating(blk)) {
      blk.pageOverride = { width: pendingSectionGeom.width, height: pendingSectionGeom.height, margins: pendingSectionGeom.margins };
      pendingSectionGeom = null;
    }
    return blk;
  };
  const placeFloat = (blk) => {
    if (blk && blk.type === 'image' && blk.top != null && pageIndex > 0) blk.top += pageIndex * stride;
    return blk;
  };

  for (const node of Array.from(body.children)) {
    const tag = local(node.tagName);
    if (tag === 'p') {
      const brk = paragraphBreak(node);
      // A page break that STARTS a new page on this paragraph (Word manual page
      // break / "page break before"): advance now so this block sits on the new page.
      if (brk === 'before' || brk === 'manual') { pageIndex += 1; pendingBreak = true; }

      const listInfo = paragraphListInfo(node, numbering);
      if (listInfo) {
        const runs = readRuns(node, files, rels);
        if (!pendingList || pendingList.ordered !== listInfo.ordered) {
          flushList();
          pendingList = { ordered: listInfo.ordered, block: createListBlock({ ordered: listInfo.ordered, items: [] }) };
          pendingList.block.items = [];
          applyBreak(pendingList.block);
        }
        pendingList.block.items.push({ runs: runs.length ? runs : [createRun('')] });
        if (brk === 'section') { flushList(); pageIndex += 1; pendingBreak = true; enterNextSection(); } // section break after the list item
        continue;
      }
      flushList();
      // A paragraph may anchor one or more drawings (inline OR floating). Emit those
      // image blocks first (a side-wrap/float needs to precede the text it wraps),
      // then the paragraph's own text — so an anchored picture never drops the
      // paragraph's words the way "image-only" handling used to.
      const drawings = readDrawings(node, files, rels, page).map(placeFloat);
      const para = readParagraph(node, files, rels, bodySize, styleInfo);
      const hasText = para.runs.some((r) => (r.text || '').trim());
      // A pure break carrier (no text, no image) — a lone `<w:br w:type="page"/>`
      // paragraph, `pageBreakBefore`, or the section-break marker our layout exporter
      // drops between pages — just advances the page; emitting nothing keeps a blank
      // paragraph from opening every page. The break is carried onto the NEXT real
      // block via `pendingBreak`. (A manual/before break already advanced pageIndex
      // above; a section break advances it here.)
      if (!hasText && !drawings.length && brk) {
        if (brk === 'section') { pageIndex += 1; pendingBreak = true; enterNextSection(); }
        continue;
      }
      if (drawings.length) {
        applyBreak(drawings[0]);
        for (const d of drawings) blocks.push(d);
        if (hasText) { applyBreak(para); blocks.push(para); }
      } else {
        applyBreak(para);
        blocks.push(para);
      }
      if (brk === 'section') { pageIndex += 1; pendingBreak = true; enterNextSection(); } // section break trails this paragraph
    } else if (tag === 'tbl') {
      flushList();
      blocks.push(applyBreak(readTable(node, files, rels, cellDefaults)));
    }
  }
  flushList();

  return createDocument({
    title,
    source: 'docx',
    page,
    blocks: blocks.length ? blocks : [createParagraph()],
  });
}

/* ---------------------- positioned (exact-layout) re-import ---------------- */

/** True when this .docx is our positioned export: at least one page-anchored text
 *  frame (w:framePr) AND a full-page behind-text raster (behindDoc anchor). Generic
 *  Word documents essentially never combine both, so this won't misfire on them. */
function isPositionedExport(body) {
  if (!body.getElementsByTagName('w:framePr').length) return false;
  for (const a of Array.from(body.getElementsByTagName('wp:anchor'))) {
    if (a.getAttribute('behindDoc') === '1') return true;
  }
  return false;
}

/** Read the re-import sidecar (the positioned export's ORIGINAL model), gzip'd
 *  (`docmaster/model.json.gz`) or, for older exports, plain (`docmaster/model.json`).
 *  Returns the positioned model, or null when absent/corrupt. */
async function readSidecarModel(files, dec) {
  let bytes = files.get('docmaster/model.json.gz');
  if (bytes) { try { bytes = await gunzip(bytes); } catch { return null; } }
  else bytes = files.get('docmaster/model.json');
  if (!bytes) return null;
  try {
    const m = (JSON.parse(dec.decode(bytes)) || {}).model;
    return (m && m.layout === 'positioned' && Array.isArray(m.blocks)) ? m : null;
  } catch { return null; }
}

/** GUNZIP a byte array via the platform DecompressionStream (browser + Node 18+). */
async function gunzip(u8) {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  w.write(u8); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

/**
 * Build a positioned Document from the sidecar model, keeping it honest about edits
 * made in MS Word. The sidecar carries the ORIGINAL text; the OOXML `w:framePr` frames
 * carry whatever the file currently says. When they diverge (a Word edit), adopt the
 * frames' runs onto the matching sidecar boxes — same exact layout/raster, but the
 * current text. If the box counts differ (lines added/removed in Word), the sidecar's
 * layout is stale, so fall back to the frame reconstruction instead.
 */
export function mergeSidecar(m, reconstructed, title) {
  const mBoxes = (m.blocks || []).filter((b) => b && b.type === 'posbox');
  const rBoxes = reconstructed ? (reconstructed.blocks || []).filter((b) => b && b.type === 'posbox') : [];
  if (rBoxes.length) {
    if (rBoxes.length !== mBoxes.length) return reconstructed; // structure changed in Word
    const txt = (b) => (b.runs || []).map((r) => r.text || '').join('');
    for (let i = 0; i < mBoxes.length; i += 1) {
      if (txt(mBoxes[i]) !== txt(rBoxes[i]) && rBoxes[i].runs && rBoxes[i].runs.length) {
        mBoxes[i].runs = rBoxes[i].runs; // adopt the Word-edited line onto the sidecar box
      }
    }
  }
  const doc = createDocument({ title: m.title || title, source: 'docx', page: m.page, blocks: m.blocks, header: m.header, footer: m.footer });
  doc.layout = 'positioned';
  doc.pages = Array.isArray(m.pages) ? m.pages : [];
  return doc;
}

let posSeq = 0;
/**
 * Rebuild the positioned (exact-layout) document model from our own export — the
 * inverse of docx.js `positionedModelToDocx`. Each Word section is one page: its
 * behindDoc drawing → the page raster (`pages[i].bg`), and every `w:framePr`
 * paragraph → a `posbox` block at its absolute coordinates. Boxes are `revealed`
 * (always visible, transparent fill) because the exported raster has its text erased
 * — there's nothing baked to reveal, so the frames must show at rest.
 */
function reconstructPositioned(body, files, rels, title) {
  const pages = [];
  const blocks = [];
  let pageIndex = 0;
  let curBg = null, curW = null, curH = null, curFrames = [];
  const fw = DEFAULT_PAGE.width, fh = DEFAULT_PAGE.height;

  const finalize = (sectPr) => {
    let w = curW, h = curH;
    const pgSz = sectPr ? child(sectPr, 'pgSz') : null;
    if (pgSz) {
      const pw = attr(pgSz, 'w:w'), ph = attr(pgSz, 'w:h');
      if (pw) w = Math.round(TWIP_TO_PX(pw));
      if (ph) h = Math.round(TWIP_TO_PX(ph));
    }
    if (curBg == null && !curFrames.length) { if (w) curW = w; if (h) curH = h; return; }
    pages.push({ bg: curBg, width: w || fw, height: h || fh });
    for (const fr of curFrames) { fr.page = pageIndex; blocks.push(fr); }
    pageIndex += 1; curBg = null; curFrames = []; curW = w; curH = h;
  };

  for (const node of Array.from(body.children)) {
    const tag = local(node.tagName);
    if (tag === 'sectPr') { finalize(node); continue; }   // final page's body-level section
    if (tag !== 'p') continue;
    const pPr = child(node, 'pPr');
    const framePr = pPr ? child(pPr, 'framePr') : null;
    const sectPr = pPr ? child(pPr, 'sectPr') : null;
    if (framePr) {
      const frame = {
        x: Math.max(0, Math.round(TWIP_TO_PX(attr(framePr, 'w:x') || '0'))),
        y: Math.max(0, Math.round(TWIP_TO_PX(attr(framePr, 'w:y') || '0'))),
        w: Math.max(0, Math.round(TWIP_TO_PX(attr(framePr, 'w:w') || '0'))),
        h: Math.max(0, Math.round(TWIP_TO_PX(attr(framePr, 'w:h') || '0'))),
      };
      const jc = attr(child(pPr, 'jc'), 'w:val');
      const align = jc === 'center' ? 'center' : jc === 'right' ? 'right' : 'left';
      const runs = readRuns(node, files, rels);
      curFrames.push({
        id: `pos-${(++posSeq).toString(36)}`,
        type: 'posbox', page: 0, frame, style: { align },
        fill: '', revealed: true,
        runs: runs.length ? runs : [createRun('')],
      });
      continue;
    }
    if (sectPr) { finalize(sectPr); continue; }            // section-break carrier ends a page
    // Otherwise: the page-background raster paragraph (a behindDoc drawing).
    const draw = node.getElementsByTagName('w:drawing')[0];
    if (draw) {
      const blk = drawingToBlock(draw, files, rels, { width: 0, margin: 0 });
      if (blk && blk.src) { curBg = blk.src; if (blk.width) curW = blk.width; if (blk.height) curH = blk.height; }
    }
  }
  finalize(null); // trailing page if the body didn't end on a section child

  if (!pages.length && !blocks.length) return null; // not actually our export → flow import
  const doc = createDocument({
    title, source: 'docx',
    page: { width: (pages[0] && pages[0].width) || fw, height: (pages[0] && pages[0].height) || fh, margin: 0 },
    blocks: blocks.length ? blocks : undefined,
  });
  doc.layout = 'positioned';
  doc.pages = pages;
  return doc;
}

/* ------------------------------ theme (colours / fonts) ------------------------ */

// The active document theme, set per-import in docxToBlockModel BEFORE styles are
// parsed (style rPr colours/fonts resolve through it). `colors` maps clrScheme slot
// names (dk1/lt1/dk2/lt2/accent1..6/hlink/folHlink) → '#rrggbb'; `fonts` = { major, minor }.
let curTheme = { colors: {}, fonts: {} };

/** Parse theme1.xml → { colors:{slot:'#rrggbb'}, fonts:{major,minor} }. Best-effort. */
function parseTheme(text) {
  const out = { colors: {}, fonts: {} };
  try {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const clr = xml.getElementsByTagName('a:clrScheme')[0] || xml.getElementsByTagName('clrScheme')[0];
    if (clr) {
      for (const slot of Array.from(clr.children)) {
        const name = local(slot.tagName);              // dk1, lt1, accent1, hlink, …
        const srgb = child(slot, 'srgbClr');
        const sys = child(slot, 'sysClr');
        const hex = (srgb && attr(srgb, 'val')) || (sys && (attr(sys, 'lastClr') || attr(sys, 'val')));
        if (hex) out.colors[name] = `#${hex.replace(/^#/, '')}`;
      }
    }
    const fs = xml.getElementsByTagName('a:fontScheme')[0] || xml.getElementsByTagName('fontScheme')[0];
    if (fs) {
      const latinOf = (grp) => { const l = grp && child(grp, 'latin'); return l ? attr(l, 'typeface') : null; };
      const mj = latinOf(child(fs, 'majorFont')); if (mj) out.fonts.major = mj;
      const mn = latinOf(child(fs, 'minorFont')); if (mn) out.fonts.minor = mn;
    }
  } catch { /* leave theme empty */ }
  return out;
}

/** A w:themeColor attribute value (accent1, text1, hyperlink, …) → its theme '#rrggbb'. */
function themeColorHex(name) {
  if (!name) return null;
  const map = {
    text1: 'dk1', background1: 'lt1', text2: 'dk2', background2: 'lt2',
    dark1: 'dk1', light1: 'lt1', dark2: 'dk2', light2: 'lt2',
    hyperlink: 'hlink', followedhyperlink: 'folHlink',
  };
  const key = map[name.toLowerCase()] || name;        // accent1..6/dk1/… pass through
  return curTheme.colors[key] || curTheme.colors[name] || null;
}

/** Apply a w:themeShade (toward black) or w:themeTint (toward white) — both hex 00–FF. */
function applyShadeTint(hex, shade, tint) {
  const h = hex.replace(/^#/, '');
  let r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  if (shade) { const f = parseInt(shade, 16) / 255; r *= f; g *= f; b *= f; }
  else if (tint) { const f = parseInt(tint, 16) / 255; r = r * f + 255 * (1 - f); g = g * f + 255 * (1 - f); b = b * f + 255 * (1 - f); }
  const hh = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${hh(r)}${hh(g)}${hh(b)}`;
}

/** Resolve a `<w:color>` element to '#rrggbb', honouring an explicit w:val, a themed
 *  colour (w:themeColor + optional shade/tint), or null for automatic/none. */
function resolveColorEl(colorEl) {
  if (!colorEl) return null;
  const val = attr(colorEl, 'w:val');
  if (val && val !== 'auto') return `#${val.replace(/^#/, '')}`; // Word pre-resolves themed vals here
  const theme = attr(colorEl, 'w:themeColor');
  if (theme) {
    const base = themeColorHex(theme);
    if (base) {
      const shade = attr(colorEl, 'w:themeShade'), tint = attr(colorEl, 'w:themeTint');
      return (shade || tint) ? applyShadeTint(base, shade, tint) : base;
    }
  }
  return null; // 'auto'/none → let the model default apply
}

/** Resolve a `<w:rFonts>` element to a family name: an explicit ascii/hAnsi face, or a
 *  theme face (majorHAnsi/minorHAnsi/… → the theme's major/minor font). */
function resolveFontEl(f) {
  if (!f) return null;
  const explicit = attr(f, 'w:ascii') || attr(f, 'w:hAnsi');
  if (explicit) return explicit;
  const theme = attr(f, 'w:asciiTheme') || attr(f, 'w:hAnsiTheme');
  if (theme) return /major/i.test(theme) ? (curTheme.fonts.major || null) : (curTheme.fonts.minor || null);
  return null;
}

/* ------------------------- styles / section setup ------------------------- */

/** Parse styles.xml into { def, byId }: document defaults and per-style formatting
 *  (font size in px, family, paragraph spacing/indent), each style noting `basedOn`
 *  so the inheritance chain can be resolved. Best-effort; unknown parts ignored. */
function parseStyles(text) {
  const out = { def: {}, byId: {} };
  try {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const dd = xml.getElementsByTagName('w:docDefaults')[0];
    if (dd) {
      const rpr = dd.getElementsByTagName('w:rPr')[0];
      const ppr = dd.getElementsByTagName('w:pPr')[0];
      Object.assign(out.def, readRunDefaults(rpr), readParaSpacing(ppr));
    }
    for (const st of Array.from(xml.getElementsByTagName('w:style'))) {
      if (attr(st, 'w:type') !== 'paragraph') continue;
      const id = attr(st, 'w:styleId');
      if (!id) continue;
      out.byId[id] = {
        ...readRunDefaults(child(st, 'rPr')),
        ...readParaSpacing(child(st, 'pPr')),
        basedOn: attr(child(st, 'basedOn'), 'w:val') || null,
      };
    }
  } catch { /* leave defaults empty */ }
  return out;
}

/** Merge a paragraph style with everything it is basedOn (root → leaf), so a style
 *  that only overrides, say, spacing still inherits its parent's size. */
function styleChain(styleInfo, id, depth = 0) {
  const s = id && styleInfo.byId[id];
  if (!s || depth > 10) return {};
  const { basedOn, ...own } = s;
  return { ...styleChain(styleInfo, basedOn, depth + 1), ...own };
}

/** { sizePx?, fontFamily?, color? } from an rPr (run properties) — used for document
 *  defaults and named styles, so a heading's colour/font/size defined in its STYLE
 *  (the common case) is inherited by its runs instead of collapsing to the model
 *  default (black / Inter). Theme colours and theme fonts are resolved here too. */
function readRunDefaults(rpr) {
  if (!rpr) return {};
  const o = {};
  const sz = attr(child(rpr, 'sz'), 'w:val');
  if (sz) o.sizePx = Math.round(HALFPT_TO_PX(sz));
  const fam = resolveFontEl(child(rpr, 'rFonts'));
  if (fam) o.fontFamily = fam;
  const col = resolveColorEl(child(rpr, 'color'));
  if (col) o.color = col;
  return o;
}

/** { spaceBefore?, spaceAfter?, lineHeight?|lineHeightPx?, indentLeft? } from a pPr. */
function readParaSpacing(ppr) {
  if (!ppr) return {};
  const o = {};
  const sp = child(ppr, 'spacing');
  if (sp) {
    const before = attr(sp, 'w:before');
    const after = attr(sp, 'w:after');
    if (before != null) o.spaceBefore = Math.round(TWIP_TO_PX(before));
    if (after != null) o.spaceAfter = Math.round(TWIP_TO_PX(after));
    const line = attr(sp, 'w:line');
    if (line != null) {
      const rule = attr(sp, 'w:lineRule') || 'auto';
      if (rule === 'auto') o.lineHeight = parseInt(line, 10) / 240; // 240 = single
      else o.lineHeightPx = Math.round(TWIP_TO_PX(line));           // exact / atLeast
    }
  }
  const ind = child(ppr, 'ind');
  if (ind) {
    const left = attr(ind, 'w:left') ?? attr(ind, 'w:start');
    if (left != null) o.indentLeft = Math.max(0, Math.round(TWIP_TO_PX(left)));
  }
  return o;
}

/** Page size + margin (px) + orientation from ONE `<w:sectPr>` element. */
function readSectGeom(sect) {
  const page = {};
  if (!sect) return page;
  const pgSz = child(sect, 'pgSz');
  if (pgSz) {
    const w = attr(pgSz, 'w:w'); const h = attr(pgSz, 'w:h');
    if (w) page.width = Math.round(TWIP_TO_PX(w));
    if (h) page.height = Math.round(TWIP_TO_PX(h));
    // Orientation: Word writes w:orient AND swaps w/h for landscape, so the raw
    // dimensions already describe the real page box. Trust the dimensions (fall back
    // to w:orient only if they're square/ambiguous), so a landscape page opens wide
    // instead of portrait — otherwise its text overflows and inflates the page count.
    const orient = attr(pgSz, 'w:orient');
    page.orientation = page.width && page.height
      ? (page.width > page.height ? 'landscape' : 'portrait')
      : (orient === 'landscape' ? 'landscape' : 'portrait');
  }
  const pgMar = child(sect, 'pgMar');
  if (pgMar) {
    // Read all four sides so the editor reproduces the document's REAL printable
    // area. Collapsing them to one value (as before) forced the top/bottom margins
    // to the — usually larger — left margin, shrinking the usable page height enough
    // to bump content onto the next page and ignoring the page-setup margins the
    // user sees. `margin` (single) is kept for back-compat / older callers.
    const px = (v) => Math.max(0, Math.round(TWIP_TO_PX(v)));
    const l = attr(pgMar, 'w:left'); const r = attr(pgMar, 'w:right');
    const t = attr(pgMar, 'w:top'); const b = attr(pgMar, 'w:bottom');
    const m = {
      top: t != null ? px(t) : undefined,
      right: r != null ? px(r) : undefined,
      bottom: b != null ? px(b) : undefined,
      left: l != null ? px(l) : undefined,
    };
    // Fill any missing side from another present side (symmetric fallback).
    const any = m.left ?? m.right ?? m.top ?? m.bottom;
    if (any != null) {
      page.margins = {
        top: m.top ?? any, right: m.right ?? any, bottom: m.bottom ?? any, left: m.left ?? any,
      };
      page.margin = page.margins.left; // representative single value
    }
  }
  return page;
}

/** Every section's geometry, in document order. A Word document is a sequence of
 *  SECTIONS, each ended by a `<w:sectPr>` — inline ones (in a paragraph's pPr) end
 *  each earlier section, and the final body-level one ends the last section. So the
 *  NodeList order is [section 1, section 2, …, last section], i.e. `[0]` is page 1's
 *  setup. Returns [] when the body has no section properties at all. */
function readSections(body) {
  return Array.from(body.getElementsByTagName('w:sectPr')).map(readSectGeom);
}

/** Whether two section geometries describe a different page (size or margins) — used
 *  to detect a document that mixes setups (e.g. a landscape page mid-document). */
function geomDiffers(a, b) {
  if (!a || !b) return !!(a || b);
  if (a.width !== b.width || a.height !== b.height) return true;
  const ma = a.margins || {}; const mb = b.margins || {};
  return ma.top !== mb.top || ma.right !== mb.right || ma.bottom !== mb.bottom || ma.left !== mb.left;
}

/** Page size + margin (px) from the body's section properties — the PRIMARY (page 1 /
 *  first section) setup, which is what the document opens at. Was the LAST section,
 *  which opened a multi-section doc at its final section's size/margins by mistake. */
function readPageSetup(body) {
  const sects = readSections(body);
  return sects[0] || {};
}

/* ------------------------------- paragraph -------------------------------- */

function readParagraph(pNode, files, rels, bodySize = 16, styleInfo = { def: {}, byId: {} }) {
  const pPr = child(pNode, 'pPr');
  const jc = pPr ? attr(child(pPr, 'jc'), 'w:val') : '';
  const align = jc === 'both' ? 'justify' : (jc === 'center' || jc === 'right' ? jc : 'left');
  // Effective formatting = document defaults ← paragraph style chain ← inline pPr.
  // This is what makes size/spacing faithful when Word keeps them in the style.
  const styleId = attr(child(pPr, 'pStyle'), 'w:val') || 'Normal';
  const eff = { ...styleInfo.def, ...styleChain(styleInfo, styleId), ...readParaSpacing(pPr) };
  const defaults = {
    // Fall back to Word's real body size (11pt ≈ 15px), NOT the editor's 16px default,
    // so an unspecified run isn't ~9% taller than in Word (which compounds into pages).
    fontSize: eff.sizePx || WORD_DEFAULT_SIZE_PX,
    fontFamily: eff.fontFamily || undefined,
    color: eff.color || undefined,
  };
  const runs = readRuns(pNode, files, rels, defaults);
  // Heading level: prefer an explicit Word style / outline level; otherwise infer
  // it from the paragraph's font size so font-styled headings still populate the
  // document outline (they're the common case — see computeBodySize).
  const tag = explicitHeadingTag(pPr) || inferHeadingTag(runs, bodySize) || 'p';

  // Emit spacing + line-height EXPLICITLY (from the file, else Word's defaults) so the
  // editor's larger "web document" defaults (line-height 1.4 / 10px after, injected by
  // createParagraph) never leak into imported text. That leak is the main reason a
  // 6-page Word doc paginated to ~18 pages: every line was ~40% taller and every
  // paragraph gained a 10px bottom margin the source never had.
  const style = { align };
  style.spaceBefore = eff.spaceBefore != null ? eff.spaceBefore : 0;
  style.spaceAfter = eff.spaceAfter != null ? eff.spaceAfter : 0;
  if (eff.lineHeightPx != null) style.lineHeightPx = eff.lineHeightPx;   // exact/atLeast rule
  else style.lineHeight = eff.lineHeight != null ? eff.lineHeight : WORD_DEFAULT_LINE;
  if (eff.indentLeft) style.indentLeft = eff.indentLeft;

  if (docxDebugOn() && dbgParaBudget > 0) {
    dbgParaBudget -= 1;
    dbg(`para[${tag}] size≈${(runs[0] && runs[0].marks && runs[0].marks.fontSize) || defaults.fontSize}px`,
      'line-height:', style.lineHeightPx != null ? `${style.lineHeightPx}px(exact)` : style.lineHeight,
      'spaceBefore:', style.spaceBefore, 'spaceAfter:', style.spaceAfter,
      'chars:', runs.reduce((n, r) => n + ((r.text || '').length), 0));
  }
  return createParagraph({ tag, style, runs: runs.length ? runs : [createRun('')] });
}

/**
 * Detect a page break associated with a paragraph, returning:
 *   • 'before'  — the paragraph starts a new page (`<w:pageBreakBefore/>`)
 *   • 'manual'  — a manual page break run (`<w:br w:type="page"/>`)
 *   • 'section' — a section break in the paragraph's pPr (`<w:sectPr>`, non-continuous),
 *                 i.e. the paragraph ENDS a section; the next content starts a page.
 *   • null      — no break.
 * Continuous section breaks (same page) are intentionally ignored.
 */
function paragraphBreak(node) {
  const pPr = child(node, 'pPr');
  if (child(pPr, 'pageBreakBefore')) return 'before';
  const sect = child(pPr, 'sectPr');
  if (sect && attr(child(sect, 'type'), 'w:val') !== 'continuous') return 'section';
  for (const br of Array.from(node.getElementsByTagName('w:br'))) {
    if ((br.getAttribute('w:type') || br.getAttribute('type')) === 'page') return 'manual';
  }
  return null;
}

/** Heading level from a paragraph's Word style id or outline level, if any. */
function explicitHeadingTag(pPr) {
  if (!pPr) return null;
  const styleVal = attr(child(pPr, 'pStyle'), 'w:val') || '';
  if (/heading\s*1|heading1|^title$/i.test(styleVal)) return 'h1';
  if (/heading\s*2|heading2|^subtitle$/i.test(styleVal)) return 'h2';
  if (/heading\s*3|heading3/i.test(styleVal)) return 'h3';
  const lvl = attr(child(pPr, 'outlineLvl'), 'w:val');
  if (lvl != null) {
    const n = parseInt(lvl, 10);
    if (n === 0) return 'h1';
    if (n === 1) return 'h2';
    if (n >= 2 && n <= 8) return 'h3';
  }
  return null;
}

/** Infer a heading level from font size for documents that don't use heading
 *  styles: a short paragraph whose dominant run size is meaningfully larger than
 *  the body text is treated as a heading, tiered by how much larger it is. */
function inferHeadingTag(runs, bodySize) {
  let total = 0;
  const byChar = new Map(); // fontSize(px) → chars at that size
  for (const r of runs) {
    const len = (r.text || '').length;
    if (!len) continue;
    const sz = (r.marks && r.marks.fontSize) || bodySize;
    byChar.set(sz, (byChar.get(sz) || 0) + len);
    total += len;
  }
  // Headings are short lines; a long paragraph in a big font is still body text.
  if (!total || total > 200) return null;
  let size = bodySize, most = -1;
  for (const [sz, len] of byChar) if (len > most) { most = len; size = sz; }
  const ratio = size / (bodySize || 16);
  if (ratio >= 1.8) return 'h1';
  if (ratio >= 1.35) return 'h2';
  if (ratio >= 1.15) return 'h3';
  return null;
}

/** Modal body font size (px): the run size that covers the most characters. */
function computeBodySize(body) {
  const byChar = new Map();
  for (const r of Array.from(body.getElementsByTagName('w:r'))) {
    let text = '';
    for (const t of Array.from(r.children)) if (local(t.tagName) === 't') text += t.textContent;
    if (!text.trim()) continue;
    const sz = attr(child(child(r, 'rPr'), 'sz'), 'w:val');
    const px = sz ? Math.round((parseInt(sz, 10) / 2) * PT_TO_PX) : 16;
    byChar.set(px, (byChar.get(px) || 0) + text.length);
  }
  let size = 16, most = -1;
  for (const [px, len] of byChar) if (len > most) { most = len; size = px; }
  return size;
}

function readRuns(container, files, rels, defaults = {}) {
  const runs = [];
  for (const r of Array.from(container.getElementsByTagName('w:r'))) {
    const rPr = child(r, 'rPr');
    const marks = readMarks(rPr, defaults);
    let text = '';
    for (const t of Array.from(r.children)) {
      const tl = local(t.tagName);
      if (tl === 't') text += t.textContent;
      else if (tl === 'tab') text += '\t';
      else if (tl === 'br') text += '\n';
    }
    if (text) runs.push(createRun(text, marks));
  }
  return runs;
}

function readMarks(rPr, defaults = {}) {
  const m = {};
  if (rPr) {
    if (child(rPr, 'b') && attr(child(rPr, 'b'), 'w:val') !== 'false' && attr(child(rPr, 'b'), 'w:val') !== '0') m.bold = true;
    if (child(rPr, 'i') && attr(child(rPr, 'i'), 'w:val') !== 'false' && attr(child(rPr, 'i'), 'w:val') !== '0') m.italic = true;
    const u = child(rPr, 'u');
    if (u && attr(u, 'w:val') && attr(u, 'w:val') !== 'none') m.underline = true;
    const sz = attr(child(rPr, 'sz'), 'w:val');
    if (sz) m.fontSize = Math.round(HALFPT_TO_PX(sz));
    const color = resolveColorEl(child(rPr, 'color'));   // explicit or themed
    if (color) m.color = color;
    const fam = resolveFontEl(child(rPr, 'rFonts'));      // explicit or theme font
    if (fam) m.fontFamily = fam;
    // Text highlighter: a named w:highlight (Word's marker) or, for a non-standard
    // colour, run-level shading (w:shd w:fill). Map either back to the editor's hex bg.
    const hl = attr(child(rPr, 'highlight'), 'w:val');
    if (hl && hl !== 'none') m.highlight = HIGHLIGHT_HEX[hl] || `#${hl.replace(/^#/, '')}`;
    else {
      const fill = attr(child(rPr, 'shd'), 'w:fill');
      if (fill && fill !== 'auto') m.highlight = `#${fill.replace(/^#/, '')}`;
    }
  }
  // Fall back to the paragraph/style/document default so a run that inherits its size,
  // font or COLOUR (very common — Word keeps heading colour in the style, not inline)
  // still renders faithfully instead of collapsing to the model's generic default.
  if (m.fontSize == null && defaults.fontSize) m.fontSize = defaults.fontSize;
  if (m.fontFamily == null && defaults.fontFamily) m.fontFamily = defaults.fontFamily;
  if (m.color == null && defaults.color) m.color = defaults.color;
  return m;
}

/* --------------------------------- lists ---------------------------------- */

function paragraphListInfo(pNode, numbering) {
  const pPr = child(pNode, 'pPr');
  if (!pPr) return null;
  const numPr = child(pPr, 'numPr');
  if (!numPr) return null;
  const numId = attr(child(numPr, 'numId'), 'w:val');
  const ordered = numId != null ? !!numbering[numId] : false;
  return { ordered };
}

/** numId → ordered(boolean): true when its level-0 format is not "bullet". */
function parseNumbering(text) {
  const map = {};
  try {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    const abstractFmt = {};
    for (const an of Array.from(xml.getElementsByTagName('w:abstractNum'))) {
      const id = attr(an, 'w:abstractNumId');
      const lvl = Array.from(an.getElementsByTagName('w:lvl')).find((l) => attr(l, 'w:ilvl') === '0') || an.getElementsByTagName('w:lvl')[0];
      const fmt = lvl ? attr(child(lvl, 'numFmt'), 'w:val') : 'bullet';
      abstractFmt[id] = fmt;
    }
    for (const num of Array.from(xml.getElementsByTagName('w:num'))) {
      const numId = attr(num, 'w:numId');
      const aId = attr(child(num, 'abstractNumId'), 'w:val');
      map[numId] = abstractFmt[aId] !== 'bullet';
    }
  } catch { /* leave empty → everything treated as unordered */ }
  return map;
}

/* --------------------------------- tables --------------------------------- */

function readTable(tbl, files, rels, defaults = {}) {
  const rows = [];
  const rowWidths = []; // per row: [{ w, span }] from each cell's <w:tcW>
  for (const tr of childrenOf(tbl, 'tr')) {
    const cells = [];
    const widths = [];
    for (const tc of childrenOf(tr, 'tc')) {
      const runs = [];
      // Pass the document's default run formatting so an unstyled cell renders at the
      // doc's body size (e.g. 11pt≈15px), NOT the model's generic 16px — cell text was
      // ~7% bigger than the body, and combined with the table's inherited line-height
      // it made every row taller than Word's, inflating the page count.
      for (const p of childrenOf(tc, 'p')) runs.push(...readRuns(p, files, rels, defaults));
      const cell = { runs: runs.length ? runs : [createRun('')] };
      const tcPr = child(tc, 'tcPr');
      // Horizontal cell merge (w:gridSpan) → colSpan, so a header spanning several
      // grid columns keeps the same footprint as its columns (and the grid stays
      // aligned). Without this the cell would occupy one column and shift the row.
      const span = parseInt(attr(child(tcPr, 'gridSpan'), 'w:val') || '0', 10) || 1;
      if (span > 1) cell.colSpan = span;
      widths.push({ w: parseFloat(attr(child(tcPr, 'tcW'), 'w:w') || '0') || 0, span });
      cells.push(cell);
    }
    if (cells.length) { rows.push(cells); rowWidths.push(widths); }
  }
  if (!rows.length) return createTableBlock(1, 1);

  // Column widths: prefer a *non-uniform* <w:tblGrid>; else derive them from the
  // row with the most cells' per-cell <w:tcW> (distributed across gridSpans).
  // Preserving Word's real proportions matters: a text-heavy column left too
  // narrow wraps into a cell taller than a whole page, which then can't be kept
  // on one page and gets split at the boundary. A uniform/absent grid is treated
  // as "no widths" (autofit) so block.cols stays unset and the editor sizes
  // columns to CONTENT (see .doc-table:not(:has(colgroup)) → table-layout:auto),
  // exactly like Word/Google Docs — again keeping rows their real, short height.
  const grid = child(tbl, 'tblGrid');
  const gridWs = grid ? childrenOf(grid, 'gridCol').map((gc) => parseFloat(attr(gc, 'w:w') || '0') || 0) : [];
  const cols = toFractions(gridWs) || colsFromCellWidths(rowWidths);

  const gridCols = cols ? cols.length : Math.max(...rows.map((r) => r.reduce((n, c) => n + (c.colSpan || 1), 0)));
  const block = createTableBlock(rows.length, gridCols);
  block.rows = rows;
  if (cols) block.cols = cols;
  return block;
}

const childrenOf = (node, name) => Array.from(node.children).filter((n) => local(n.tagName) === name);

/** Normalise column widths to fractions summing to 1 — but only when they are
 *  meaningfully non-uniform. Equal widths mean an autofit table, so we return
 *  null and let content-based auto layout size the columns instead. */
function toFractions(ws) {
  if (!ws.length) return null;
  const sum = ws.reduce((a, b) => a + b, 0);
  const min = Math.min(...ws), max = Math.max(...ws);
  if (sum <= 0 || min <= 0 || max / min < 1.12) return null;
  return ws.map((w) => w / sum);
}

/** Build column widths from the widest row's per-cell <w:tcW>, expanding each
 *  gridSpan cell evenly across the columns it covers. */
function colsFromCellWidths(rowWidths) {
  let best = null;
  for (const widths of rowWidths) {
    const nCols = widths.reduce((n, x) => n + x.span, 0);
    if (widths.every((x) => x.w > 0) && (!best || nCols > best.nCols)) best = { widths, nCols };
  }
  if (!best) return null;
  const ws = [];
  for (const { w, span } of best.widths) for (let k = 0; k < span; k += 1) ws.push(w / span);
  return toFractions(ws);
}

/* --------------------------------- images --------------------------------- */

/** Every `w:drawing` in a paragraph → image blocks (inline or floating). */
function readDrawings(pNode, files, rels, page) {
  const out = [];
  for (const drawing of Array.from(pNode.getElementsByTagName('w:drawing'))) {
    const block = drawingToBlock(drawing, files, rels, page);
    if (block) out.push(block);
  }
  return out;
}

/**
 * One `w:drawing` → an image block, mapping DOCX layout to the model:
 *   • `wp:inline` .......................... inline block (flows on its own line)
 *   • `wp:anchor` + wrapSquare/Tight/Through side-wrap float (text reflows beside)
 *   • `wp:anchor` + wrapNone ............... free float (front, or behind if behindDoc)
 *   • `wp:anchor` + wrapTopAndBottom ....... inline block (full-width, own line)
 * Size comes from `wp:extent` (EMU→px); a float's page position comes from
 * `wp:positionH/V` (offset or align, resolved against the page/margins).
 */
function drawingToBlock(drawing, files, rels, page) {
  const blip = drawing.getElementsByTagName('a:blip')[0];
  if (!blip) return null;
  const embed = blip.getAttribute('r:embed') || blip.getAttribute('embed');
  const target = embed && rels[embed];
  if (!target) return null;
  const path = `word/${target.replace(/^\.\//, '')}`;
  const bytes = files.get(path) || files.get(target);
  if (!bytes) return null;
  const ext = (path.split('.').pop() || 'png').toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;

  const extent = drawing.getElementsByTagName('wp:extent')[0];
  const cx = extent ? parseInt(extent.getAttribute('cx') || '0', 10) : 0;
  const cy = extent ? parseInt(extent.getAttribute('cy') || '0', 10) : 0;
  const width = extent ? Math.round(cx / EMU_PER_PX) : undefined;
  const height = extent ? Math.round(cy / EMU_PER_PX) : undefined;
  // Image size is taken verbatim from the drawing's display extent (EMU → px @96dpi),
  // i.e. exactly the box Word draws it in — never the raw pixel dimensions of the
  // embedded file — so a picture can't render larger than the source shows it.
  dbg('image:', path.split('/').pop(), 'EMU', { cx, cy }, '→ px', { width, height });
  const block = createImageBlock({
    src: `data:image/${mime};base64,${base64(bytes)}`,
    width: width || undefined,
    height: height || undefined,
  });

  const anchor = drawing.getElementsByTagName('wp:anchor')[0];
  if (!anchor) return block; // wp:inline → plain inline image

  const has = (name) => anchor.getElementsByTagName(name).length > 0;
  const square = has('wp:wrapSquare') || has('wp:wrapTight') || has('wp:wrapThrough');
  const none = has('wp:wrapNone');
  const behind = anchor.getAttribute('behindDoc') === '1';

  const posH = anchor.getElementsByTagName('wp:positionH')[0];
  const posV = anchor.getElementsByTagName('wp:positionV')[0];
  const hAlign = posH ? textOf(posH.getElementsByTagName('wp:align')[0]) : '';
  const hOff = posH ? intOf(posH.getElementsByTagName('wp:posOffset')[0]) : null;   // EMU
  const vOff = posV ? intOf(posV.getElementsByTagName('wp:posOffset')[0]) : null;
  const hFrom = (posH && posH.getAttribute('relativeFrom')) || 'column';
  const vFrom = (posV && posV.getAttribute('relativeFrom')) || 'paragraph';

  const pageW = page.width;
  const m = page.margin;
  const wpx = block.width || 0;
  // Absolute left (px from the page's left edge).
  let leftPx = null;
  if (hOff != null) leftPx = hFrom === 'page' ? hOff / EMU_PER_PX : m + hOff / EMU_PER_PX;
  else if (hAlign) leftPx = hAlign === 'right' ? (pageW - m - wpx) : hAlign === 'center' ? (pageW - wpx) / 2 : m;
  const centreX = (leftPx != null ? leftPx : m) + wpx / 2;
  const side = hAlign === 'right' ? 'right' : hAlign === 'left' ? 'left' : (centreX > pageW / 2 ? 'right' : 'left');

  if (square) {
    // In-flow side float: text wraps down the opposite edge. No left/top — the flow
    // decides its vertical home (mirrors the editor's wrap-left / wrap-right).
    block.wrap = side;
  } else if (none) {
    // Free float painted over the text (front) or behind it.
    block.wrap = behind ? 'behind' : 'front';
    if (behind) block.z = -1;
    block.left = Math.round(leftPx != null ? leftPx : m);
    const topPx = vOff != null ? (vFrom === 'page' ? vOff / EMU_PER_PX : m + vOff / EMU_PER_PX) : m;
    block.top = Math.round(topPx);
  }
  // wrapTopAndBottom / anything else → keep it as a plain inline block.
  return block;
}

const textOf = (node) => (node ? (node.textContent || '').trim() : '');
const intOf = (node) => { const t = textOf(node); return t === '' ? null : parseInt(t, 10); };

/* ------------------------------ OOXML helpers ----------------------------- */

const local = (t) => (t || '').replace(/^.*:/, '');
function child(node, name) {
  if (!node) return null;
  for (const c of Array.from(node.children)) if (local(c.tagName) === name) return c;
  return null;
}
function attr(node, name) {
  if (!node) return null;
  return node.getAttribute(name) || node.getAttribute(local(name));
}
function parseRels(text) {
  const map = {};
  try {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    for (const r of Array.from(xml.getElementsByTagName('Relationship'))) {
      map[r.getAttribute('Id')] = r.getAttribute('Target');
    }
  } catch { /* ignore */ }
  return map;
}
function base64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/* --------------------------------- unzip ---------------------------------- */

/**
 * Minimal ZIP reader → Map(name → Uint8Array). Walks the central directory and
 * inflates DEFLATE (method 8) entries via `DecompressionStream`; STORED (method
 * 0) entries are copied as-is.
 */
async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // Locate End Of Central Directory (search backwards for its signature).
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true); // central directory offset

  const out = new Map();
  for (let n = 0; n < count; n += 1) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) break;
    const method = dv.getUint16(ptr + 10, true);
    const compSize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const localOff = dv.getUint32(ptr + 42, true);
    const name = new TextDecoder().decode(u8.subarray(ptr + 46, ptr + 46 + nameLen));

    // Jump to the local header to find where the data actually begins.
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = u8.subarray(dataStart, dataStart + compSize);

    if (method === 0) out.set(name, comp.slice());
    else if (method === 8) out.set(name, await inflateRaw(comp));

    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}
