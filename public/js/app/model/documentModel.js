/**
 * The Unified Document Model.
 *
 * ONE structured representation of a document that both the PDF importer and the
 * (future) DOCX importer build, and that the editor renders and edits. It is the
 * editing engine's source of truth — NOT PDF.js. PDF.js is used only to extract
 * text/positions into this model (see `model/pdfImporter.js`); from then on the
 * document is edited as this model and re-rendered on an editable surface.
 *
 * Shape (all plain, serializable data):
 *
 *   Document = {
 *     id, title,
 *     page: { width, height, margin },        // canvas size (CSS px)
 *     meta: { source: 'pdf'|'docx'|'blank' },
 *     blocks: Block[]
 *   }
 *
 *   Block =
 *     | { id, type:'paragraph', tag:'p'|'h1'|'h2'|'h3', style:BlockStyle, runs:Run[] }
 *     | { id, type:'list', ordered:boolean, items: Item[] }   // Item = { runs:Run[] }
 *     | { id, type:'image', src, width, height, align }
 *     | { id, type:'table', rows: Cell[][] }        // Cell = { runs:Run[] }
 *
 *   Run  = { text, marks:Marks }
 *   Marks = { bold, italic, underline, strike, fontFamily, fontSize, color }
 *   BlockStyle = { align, lineHeight, spaceBefore, spaceAfter }
 *
 * The model is deliberately editor-agnostic: `editableHtml.js` maps it to/from
 * the contentEditable DOM, and exporters (later) map it to PDF/DOCX bytes.
 */

let seq = 0;
const uid = (p) => `${p}-${(++seq).toString(36)}-${Date.now().toString(36)}`;

export const DEFAULT_MARKS = Object.freeze({
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  fontFamily: 'Inter',
  fontSize: 16,
  color: '#111111',
});

export const DEFAULT_BLOCK_STYLE = Object.freeze({
  align: 'left',
  lineHeight: 1.4,
  spaceBefore: 0,
  spaceAfter: 10,
});

/** A4 at 96dpi (21.0 × 29.7 cm) — the default new-document page size. */
export const DEFAULT_PAGE = Object.freeze({ width: 794, height: 1123, margin: 72 });

export function createRun(text = '', marks = {}) {
  return { text, marks: { ...DEFAULT_MARKS, ...marks } };
}

/** An auto-updating field run (header/footer): 'page' → the page number,
 *  'pages' → the total page count. Rendered per page; never a static number. */
export function createFieldRun(field = 'page', marks = {}) {
  return { field, marks: { ...DEFAULT_MARKS, ...marks } };
}

export function createParagraph({ tag = 'p', style = {}, runs } = {}) {
  return {
    id: uid('p'),
    type: 'paragraph',
    tag,
    style: { ...DEFAULT_BLOCK_STYLE, ...style },
    runs: runs && runs.length ? runs : [createRun('')],
  };
}

export function createListBlock({ ordered = false, items } = {}) {
  return {
    id: uid('lst'),
    type: 'list',
    ordered: !!ordered,
    items: items && items.length ? items : [{ runs: [createRun('')] }],
  };
}

export function createImageBlock({ src, width, height, align = 'left', left, top } = {}) {
  // `left`/`top` are only set once the image has been dragged off the text flow
  // into a free (absolutely positioned) spot on the page.
  return { id: uid('img'), type: 'image', src, width, height, align, left, top };
}

export function createTableBlock(rows = 2, cols = 2) {
  return {
    id: uid('tbl'),
    type: 'table',
    rows: Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ runs: [createRun('')] }))
    ),
  };
}

/**
 * Header / footer definition. ONE logical header (and footer) that renders on
 * every applicable page — never duplicated as independent body blocks. It carries
 * up to three block streams so a document can vary its running head like a real
 * word processor:
 *   - `default` : the normal header/footer (also the ODD header when
 *                 `differentOddEven` is on).
 *   - `first`   : the first-page header/footer (used only when `differentFirst`).
 *   - `even`    : the even-page header/footer (used only when `differentOddEven`).
 * `distance` is the gap (CSS px) from the page edge — top for a header, bottom for
 * a footer (Google-Docs "Header/Footer distance from top/bottom"). The layout flags
 * are kept in sync across the header and footer (they are section-level in Word).
 */
export function createHeaderFooter() {
  return {
    distance: 48, // 1.27 cm @96dpi — Google-Docs default
    differentFirst: false,
    differentOddEven: false,
    default: [],
    first: [],
    even: [],
  };
}

export function createDocument({ title = 'Untitled', source = 'blank', page = {}, blocks, header, footer } = {}) {
  return {
    id: uid('doc'),
    title,
    page: { ...DEFAULT_PAGE, ...page },
    meta: { source },
    header: header || createHeaderFooter(),
    footer: footer || createHeaderFooter(),
    blocks: blocks && blocks.length ? blocks : [createParagraph()],
  };
}

/** A blank one-paragraph document. */
export function createBlankDocument(title = 'Untitled document') {
  return createDocument({ title, source: 'blank' });
}

/** Deep clone (safe: the model is pure JSON). Used for history snapshots. */
export function cloneDocument(doc) {
  return JSON.parse(JSON.stringify(doc));
}

/** Whether two mark sets are identical (for merging adjacent runs). */
export function marksEqual(a, b) {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.fontFamily === b.fontFamily &&
    a.fontSize === b.fontSize &&
    a.color === b.color &&
    (a.highlight || '') === (b.highlight || '')
  );
}

/** Merge adjacent runs that share identical marks (keeps the model compact). */
export function normalizeRuns(runs) {
  const out = [];
  for (const run of runs) {
    // Field runs (page number / count) are atomic — never merged or dropped.
    if (run.field) { out.push({ field: run.field, marks: { ...run.marks } }); continue; }
    if (!run.text) continue;
    const last = out[out.length - 1];
    if (last && !last.field && marksEqual(last.marks, run.marks)) last.text += run.text;
    else out.push({ text: run.text, marks: { ...run.marks } });
  }
  return out.length ? out : [createRun('')];
}

/** Plain-text extraction (used for word counts / debugging / plain export). */
export function documentToText(doc) {
  return doc.blocks
    .map((b) => {
      if (b.type === 'paragraph') return b.runs.map((r) => r.text).join('');
      if (b.type === 'list') return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '•'} ${it.runs.map((r) => r.text).join('')}`).join('\n');
      if (b.type === 'image') return '[image]';
      if (b.type === 'table') return b.rows.map((row) => row.map((c) => c.runs.map((r) => r.text).join('')).join('\t')).join('\n');
      return '';
    })
    .join('\n');
}
