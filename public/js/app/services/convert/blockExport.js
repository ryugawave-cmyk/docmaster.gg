/**
 * Document Editor exporters — the Unified Document Model → HTML / DOCX / PDF.
 *
 * These operate on the block/flow model (`model/documentModel.js`): paragraphs,
 * headings, lists, tables and images. That is the SAME model the Document editor
 * edits, so what you see is what you export. (The PDF *editor* uses a different,
 * positioned-layer model with its own converters in `docx.js`/`pdfExport.js`;
 * these are deliberately separate so the two editors stay decoupled.)
 *
 * Everything here is client-side and dependency-free: DOCX is hand-assembled
 * OOXML zipped by `services/zip.js`; PDF is a hand-written text PDF (standard
 * fonts, word-wrapped) with embedded JPEG images.
 */
import { zipBlob, dataURLToBytes } from '../zip.js';
import { DEFAULT_MARKS } from '../../model/documentModel.js';
import * as TG from '../../model/tableGrid.js';
import { parseTtf } from './ttf.js';
import { rowsToXlsxBlob } from './xlsx.js';

/**
 * A table block stores only master cells per row (covered positions omitted,
 * like HTML). Reconstruct their logical positions/spans so exporters can lay out
 * merged cells. Each master carries `.cell` (the model cell with runs/hide).
 */
function blockTableMasters(block) {
  const occ = [];
  const masters = [];
  (block.rows || []).forEach((row, r) => {
    let c = 0;
    for (const cell of row) {
      while (occ[r] && occ[r][c]) c += 1;
      const rs = cell.rowSpan || 1;
      const cs = cell.colSpan || 1;
      masters.push({ r, c, rs, cs, cell });
      for (let dr = 0; dr < rs; dr += 1) for (let dc = 0; dc < cs; dc += 1) {
        (occ[r + dr] = occ[r + dr] || [])[c + dc] = true;
      }
      c += cs;
    }
  });
  return masters;
}

/* ========================================================================== */
/*  Shared helpers                                                            */
/* ========================================================================== */

const PX_TO_PT = 72 / 96;                 // CSS px @96dpi → PDF points
const PX_TO_EMU = 9525;                   // CSS px → OOXML EMU (914400/96)
const HF_GAP = 8;                         // matches the editor's running head/foot gap
const marksOf = (run) => ({ ...DEFAULT_MARKS, ...(run.marks || {}) });
const runsText = (runs = []) => runs.map((r) => r.text || '').join('');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---- header / footer helpers (shared across exporters) ---- */
function normHf(cfg) {
  cfg = cfg || {};
  return {
    distance: Number.isFinite(cfg.distance) ? cfg.distance : 48,
    differentFirst: !!cfg.differentFirst,
    differentOddEven: !!cfg.differentOddEven,
    default: Array.isArray(cfg.default) ? cfg.default : [],
    first: Array.isArray(cfg.first) ? cfg.first : [],
    even: Array.isArray(cfg.even) ? cfg.even : [],
  };
}
/** The kind (default/first/even) that applies on a 0-based page. */
function hfKindFor(cfg, pageIndex) {
  if (cfg.differentFirst && pageIndex === 0) return 'first';
  if (cfg.differentOddEven && (pageIndex + 1) % 2 === 0) return 'even';
  return 'default';
}
const hfBlocks = (cfg, kind) => (cfg[kind] && cfg[kind].length ? cfg[kind] : []);
const hfIsEmpty = (blocks) => !blocks || !blocks.length ||
  (blocks.length === 1 && blocks[0].type === 'paragraph' &&
    !(blocks[0].runs || []).some((r) => (r.text && r.text.trim()) || r.field));
/** Replace page-number / count field runs with their concrete text for a page. */
const substFields = (runs, pageNumber, total) => (runs || []).map((r) =>
  r.field ? { text: r.field === 'pages' ? String(total) : String(pageNumber), marks: r.marks } : r);

/* ========================================================================== */
/*  HTML                                                                      */
/* ========================================================================== */

/** Render the model to a standalone HTML document string. */
export function blockModelToHtml(doc) {
  const body = (doc.blocks || []).map(blockToHtml).join('\n');
  // The running head/foot (default kind) brackets the body. HTML isn't paginated,
  // so it appears once at the top and bottom — the content still exports.
  const header = normHf(doc.header);
  const footer = normHf(doc.footer);
  const hb = hfBlocks(header, 'default');
  const fb = hfBlocks(footer, 'default');
  const headHtml = hfIsEmpty(hb) ? '' : `<header class="doc-header">${hb.map(blockToHtml).join('\n')}</header>`;
  const footHtml = hfIsEmpty(fb) ? '' : `<footer class="doc-footer">${fb.map(blockToHtml).join('\n')}</footer>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(doc.title || 'Document')}</title>
<style>
  body { font-family: Inter, Arial, sans-serif; color: #111; max-width: 816px; margin: 40px auto; padding: 0 24px; line-height: 1.5; }
  h1 { font-size: 30px; } h2 { font-size: 23px; } h3 { font-size: 19px; }
  table { border-collapse: collapse; table-layout: fixed; width: 100%; margin: 12px 0; }
  td { border: 1px solid #cbd5e1; padding: 6px 8px; vertical-align: top; overflow-wrap: break-word; word-break: break-word; }
  img { max-width: 100%; }
  .doc-header { border-bottom: 1px solid #e2e8f0; margin-bottom: 24px; padding-bottom: 8px; }
  .doc-footer { border-top: 1px solid #e2e8f0; margin-top: 24px; padding-top: 8px; }
</style>
</head>
<body>
${headHtml}
${body}
${footHtml}
</body>
</html>`;
}

function runToHtml(run) {
  const m = marksOf(run);
  const style = [
    `font-family:${m.fontFamily}`,
    `font-size:${m.fontSize}px`,
    `color:${m.color}`,
    m.bold ? 'font-weight:700' : '',
    m.italic ? 'font-style:italic' : '',
    // Underline + strikethrough both live on text-decoration — combine them.
    (m.underline || m.strike)
      ? `text-decoration:${[m.underline && 'underline', m.strike && 'line-through'].filter(Boolean).join(' ')}`
      : '',
  ].filter(Boolean).join(';');
  // A page-number / count field has no static text; HTML has no pagination, so
  // it renders "1" (a single-page view) but stays visibly a field.
  const text = run.field ? '1' : (run.text || '');
  return `<span style="${style}">${esc(text)}</span>`;
}

function blockToHtml(block) {
  if (block.type === 'image') {
    const w = block.width ? ` style="width:${block.width}px"` : '';
    return `<figure><img src="${esc(block.src)}"${w}></figure>`;
  }
  if (block.type === 'list') {
    const tag = block.ordered ? 'ol' : 'ul';
    const items = (block.items || []).map((it) => `<li>${(it.runs || []).map(runToHtml).join('')}</li>`).join('');
    return `<${tag}>${items}</${tag}>`;
  }
  if (block.type === 'table') {
    // Manual border weight round-trips from the editor.
    const cellBorder = block.border === 'none' ? 'border:0'
      : block.border === 'thick' ? 'border:2px solid #5b6170'
      : 'border:1px solid #9aa1b7';
    // Per-cell erased grid lines (letters t/r/b/l) override the base border.
    const HTML_SIDE = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
    const cellStyle = (c) => cellBorder +
      (c.hide ? [...c.hide].map((ch) => HTML_SIDE[ch] && `;border-${HTML_SIDE[ch]}:none`).filter(Boolean).join('') : '');
    const span = (c) => `${c.colSpan > 1 ? ` colspan="${c.colSpan}"` : ''}${c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : ''}`;
    const rows = (block.rows || []).map((row, ri) => {
      const h = block.rowH && block.rowH[ri];
      const trStyle = h ? ` style="height:${h}px"` : '';
      return `<tr${trStyle}>${row.map((c) => `<td${span(c)} style="${cellStyle(c)}">${(c.runs || []).map(runToHtml).join('')}</td>`).join('')}</tr>`;
    }).join('');
    const colgroup = Array.isArray(block.cols) && block.cols.length
      ? `<colgroup>${block.cols.map((w) => `<col style="width:${(w * 100).toFixed(3)}%">`).join('')}</colgroup>`
      : '';
    return `<table>${colgroup}<tbody>${rows}</tbody></table>`;
  }
  const tag = block.tag && /^h[1-3]$/.test(block.tag) ? block.tag : 'p';
  const align = block.style && block.style.align && block.style.align !== 'left' ? ` style="text-align:${block.style.align}"` : '';
  const inner = (block.runs || []).map(runToHtml).join('') || '<br>';
  return `<${tag}${align}>${inner}</${tag}>`;
}

export function htmlBlob(doc) {
  return new Blob([blockModelToHtml(doc)], { type: 'text/html' });
}

/* ========================================================================== */
/*  XLSX (SpreadsheetML)                                                       */
/* ========================================================================== */

/**
 * Document (block model) → Excel .xlsx. Unlike the PDF path — which reconstructs
 * a grid from positioned text — the document model already carries real tables,
 * so we map them straight to worksheet rows/columns (merged cells land at their
 * top-left, spanned positions left blank). Paragraphs/headings become one-cell
 * rows and list items one row each; images are skipped. Packaging is shared with
 * the PDF exporter via `rowsToXlsxBlob`.
 * @param {object} doc block model
 */
export function blockModelToXlsx(doc) {
  const rows = [];
  const blocks = (doc && doc.blocks) || [];

  for (const b of blocks) {
    if (b.type === 'image') continue;
    if (b.type === 'table') {
      for (const r of tableBlockToRows(b)) rows.push(r);
      rows.push([]); // blank separator after a table
      continue;
    }
    if (b.type === 'list') {
      for (const it of (b.items || [])) {
        const t = runsText(it.runs || []).trim();
        if (t) rows.push([t]);
      }
      continue;
    }
    // paragraph / heading / anything text-bearing
    const t = runsText(b.runs || []).trim();
    if (t) rows.push([t]);
  }
  // Drop a trailing empty separator row so the sheet doesn't end blank.
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  if (!rows.length) rows.push(['No content was found in this document.']);
  return rowsToXlsxBlob(rows);
}

/** A table block → aligned 2-D rows (handles row/col spans via master cells). */
function tableBlockToRows(block) {
  const masters = blockTableMasters(block);
  let maxR = 0, maxC = 0;
  for (const m of masters) { maxR = Math.max(maxR, m.r + m.rs); maxC = Math.max(maxC, m.c + m.cs); }
  const grid = Array.from({ length: maxR }, () => new Array(maxC).fill(''));
  for (const m of masters) grid[m.r][m.c] = runsText((m.cell && m.cell.runs) || []).trim();
  return grid;
}

/** An .xlsx Blob built from the block model. */
export function xlsxBlob(doc) {
  return blockModelToXlsx(doc);
}

/* ========================================================================== */
/*  DOCX (WordprocessingML)                                                    */
/* ========================================================================== */

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const REL_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const WP_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const PIC_NS = 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/**
 * Build a .docx Blob from the block model.
 * @param {object} doc block model
 * @param {{ zip?: (entries:Array, mime:string)=>(Blob|Promise<Blob>) }} [opts]
 *   `zip` overrides how the OOXML parts are packaged (defaults to the STORED
 *   `zipBlob`). Compress Word passes a DEFLATE zipper to shrink the file; the
 *   default keeps the normal Word export byte-for-byte unchanged.
 */
export async function blockModelToDocx(doc, { zip = zipBlob } = {}) {
  const media = [];   // { name, bytes }
  const rels = [];    // { id, target } (image relationships)
  let relSeq = 100;
  let drawSeq = 1;
  // SVG-based images (Professional Library charts, and shapes) can't be embedded
  // as SVG in .docx, so rasterise them to PNG up-front. Charts keep their crisp
  // vector look via a 2× raster and stay fully editable in the DocMaster model.
  const svgRaster = await rasterizeSvgImages(doc);

  const jc = (align) => (align && align !== 'left' ? `<w:jc w:val="${align === 'justify' ? 'both' : align}"/>` : '');

  const rPrInner = (m) => [
    `<w:rFonts w:ascii="${esc(cleanFont(m.fontFamily))}" w:hAnsi="${esc(cleanFont(m.fontFamily))}"/>`,
    m.bold ? '<w:b/>' : '',
    m.italic ? '<w:i/>' : '',
    m.underline ? '<w:u w:val="single"/>' : '',
    m.strike ? '<w:strike/>' : '',
    `<w:sz w:val="${Math.round(m.fontSize * PX_TO_PT * 2)}"/>`,
    `<w:color w:val="${hex6(m.color)}"/>`,
  ].join('');

  function runXml(run) {
    const m = marksOf(run);
    return `<w:r><w:rPr>${rPrInner(m)}</w:rPr><w:t xml:space="preserve">${esc(run.text || '')}</w:t></w:r>`;
  }

  /** A page-number / count field as a real Word field (auto-updates on open). */
  function fieldRunXml(run) {
    const m = marksOf(run);
    const instr = run.field === 'pages' ? ' NUMPAGES ' : ' PAGE ';
    return `<w:fldSimple w:instr="${instr}"><w:r><w:rPr>${rPrInner(m)}</w:rPr><w:t>1</w:t></w:r></w:fldSimple>`;
  }

  function runsXml(runs) {
    return (runs && runs.length ? runs : [{ text: '' }]).map((r) => (r.field ? fieldRunXml(r) : runXml(r))).join('');
  }

  function paraXml(block) {
    const style = block.tag && /^h[1-3]$/.test(block.tag) ? `<w:pStyle w:val="Heading${block.tag[1]}"/>` : '';
    const align = jc(block.style && block.style.align);
    const pPr = style || align ? `<w:pPr>${style}${align}</w:pPr>` : '';
    return `<w:p>${pPr}${runsXml(block.runs)}</w:p>`;
  }

  function listXml(block) {
    const numId = block.ordered ? 2 : 1;
    return (block.items || []).map((it) =>
      `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${runsXml(it.runs)}</w:p>`
    ).join('');
  }

  function tableXml(block) {
    const masters = blockTableMasters(block);
    const dense = TG.denseRows(masters);
    const cols = Math.max(1, dense.ncols);
    // Printable width ~6.5in = 9360 twips. Honour dragged column fractions when
    // present, otherwise divide evenly so wide tables still fit.
    const fracs = (Array.isArray(block.cols) && block.cols.length === cols) ? block.cols : null;
    const colWidths = Array.from({ length: cols }, (_, i) =>
      Math.max(240, Math.round(9360 * (fracs ? fracs[i] : 1 / cols))));
    const grid = `<w:tblGrid>${colWidths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
    // Manual border weight: 'none' → no lines, 'thick' → 2× size + darker.
    const bVal = block.border === 'none' ? 'nil' : 'single';
    const bSz = block.border === 'thick' ? '12' : '4';
    const bColor = block.border === 'thick' ? '5B6170' : '9AA1B7';
    const borders = '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
        .map((s) => `<w:${s} w:val="${bVal}" w:sz="${bSz}" w:space="0" w:color="${bColor}"/>`).join('') +
      '</w:tblBorders>';
    // Per-cell erased grid lines (letters t/r/b/l) → nil on that cell edge.
    const DOCX_SIDE = { t: 'top', r: 'right', b: 'bottom', l: 'left' };
    const cellBordersXml = (c) => {
      if (!c.hide) return '';
      const parts = [...c.hide].map((ch) => DOCX_SIDE[ch] && `<w:${DOCX_SIDE[ch]} w:val="nil"/>`).filter(Boolean).join('');
      return parts ? `<w:tcBorders>${parts}</w:tcBorders>` : '';
    };
    // Emit one physical row per grid row; colspan → w:gridSpan, rowspan → w:vMerge
    // (restart on the origin row, continue below). Continuation cells are empty.
    const rows = dense.rows.map((cells, ri) => {
      const tcs = cells.map((entry) => {
        const m = entry.master;
        const w = colWidths.slice(m.c, m.c + m.cs).reduce((a, b) => a + b, 0) || colWidths[0];
        const gridSpan = m.cs > 1 ? `<w:gridSpan w:val="${m.cs}"/>` : '';
        const vMerge = m.rs > 1 ? (entry.originRow ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>') : '';
        const tcPr = `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${gridSpan}${vMerge}${entry.originRow ? cellBordersXml(m.cell) : ''}</w:tcPr>`;
        const body = entry.originRow ? `<w:p>${runsXml(m.cell.runs)}</w:p>` : '<w:p/>';
        return `<w:tc>${tcPr}${body}</w:tc>`;
      }).join('');
      const h = block.rowH && block.rowH[ri];
      const trPr = h ? `<w:trPr><w:trHeight w:val="${Math.round(h * 15)}" w:hRule="atLeast"/></w:trPr>` : '';
      return `<w:tr>${trPr}${tcs}</w:tr>`;
    }).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${grid}${rows}</w:tbl>`;
  }

  function imageXml(block) {
    try {
      // Charts/shapes stored as SVG were pre-rasterised to PNG above.
      const src = svgRaster.get(block.src) || block.src;
      const bytes = dataURLToBytes(src);
      const ext = mimeExt(src);
      const name = `image${media.length + 1}.${ext}`;
      media.push({ name, bytes });
      const rid = `rId${relSeq++}`;
      rels.push({ id: rid, target: `media/${name}` });
      const cx = Math.round((block.width || 480) * PX_TO_EMU);
      const cy = Math.round((block.height || Math.round((block.width || 480) * 0.66)) * PX_TO_EMU);
      const id = drawSeq++;
      return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
        `<a:graphic ${A_NS}><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic ${PIC_NS}><pic:nvPicPr><pic:cNvPr id="${id}" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
        `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    } catch {
      return '<w:p/>';
    }
  }

  const blockToXml = (b) =>
    b.type === 'list' ? listXml(b) : b.type === 'table' ? tableXml(b) : b.type === 'image' ? imageXml(b) : paraXml(b);
  const bodyXml = (doc.blocks || []).map(blockToXml).join('');

  // Header/footer parts. Each present kind (default/first/even) becomes its own
  // header{n}.xml / footer{n}.xml part referenced from the section. Images inside a
  // running head/foot are skipped so the part needs no separate relationships.
  const headerCfg = normHf(doc.header);
  const footerCfg = normHf(doc.footer);
  const partBlockToXml = (b) => (b.type === 'image' ? '' : blockToXml(b));
  const hfFiles = [];    // { file, xml, part }
  const hfRels = [];     // { id, target, part }
  const hfRefs = [];     // sectPr <w:headerReference>/<w:footerReference> tags
  let hfSeq = 0;
  const addHfPart = (part, kind, blocks) => {
    if (hfIsEmpty(blocks)) return;
    hfSeq += 1;
    const file = `${part}${hfSeq}.xml`;
    const rid = `rIdHf${hfSeq}`;
    const rootTag = part === 'header' ? 'w:hdr' : 'w:ftr';
    const inner = (blocks || []).map(partBlockToXml).join('') || '<w:p/>';
    hfFiles.push({ file, part, xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${rootTag} ${W_NS} ${REL_NS} ${WP_NS} ${A_NS} ${PIC_NS}>${inner}</${rootTag}>` });
    hfRels.push({ id: rid, target: file, part });
    hfRefs.push(`<w:${part}Reference w:type="${kind}" r:id="${rid}"/>`);
  };
  for (const kind of ['default', 'first', 'even']) addHfPart('header', kind, hfBlocks(headerCfg, kind));
  for (const kind of ['default', 'first', 'even']) addHfPart('footer', kind, hfBlocks(footerCfg, kind));

  const pageW = Math.round((doc.page?.width || 816) * PX_TO_PT * 20);   // twips
  const pageH = Math.round((doc.page?.height || 1056) * PX_TO_PT * 20);
  const margin = Math.round((doc.page?.margin || 72) * PX_TO_PT * 20);
  const headerTw = Math.round(headerCfg.distance * PX_TO_PT * 20);
  const footerTw = Math.round(footerCfg.distance * PX_TO_PT * 20);
  const titlePg = (headerCfg.differentFirst || footerCfg.differentFirst) ? '<w:titlePg/>' : '';
  const evenOdd = headerCfg.differentOddEven || footerCfg.differentOddEven;
  // sectPr child order matters: references first, then pgSz/pgMar, titlePg near the end.
  const sectPr = `<w:sectPr>${hfRefs.join('')}<w:pgSz w:w="${pageW}" w:h="${pageH}"/>` +
    `<w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="${headerTw}" w:footer="${footerTw}" w:gutter="0"/>${titlePg}</w:sectPr>`;

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${W_NS} ${REL_NS} ${WP_NS} ${A_NS} ${PIC_NS}><w:body>${bodyXml}${sectPr}</w:body></w:document>`;

  const relImages = rels.map((r) =>
    `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${r.target}"/>`
  ).join('');
  const relHf = hfRels.map((r) =>
    `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${r.part}" Target="${r.target}"/>`
  ).join('');
  const hfOverrides = hfFiles.map((f) =>
    `<Override PartName="/word/${f.file}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${f.part}+xml"/>`
  ).join('') +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>';

  const entries = [
    { name: '[Content_Types].xml', data: contentTypesXml(media, hfOverrides) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/numbering.xml', data: numberingXml() },
    { name: 'word/settings.xml', data: settingsXml(evenOdd) },
    {
      name: 'word/_rels/document.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
        `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>` +
        `${relHf}${relImages}</Relationships>`,
    },
    ...hfFiles.map((f) => ({ name: `word/${f.file}`, data: f.xml })),
    ...media.map((m) => ({ name: `word/${m.name}`, data: m.bytes })),
  ];

  return zip(entries, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

function settingsXml(evenOdd) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:settings ${W_NS}>${evenOdd ? '<w:evenAndOddHeaders/>' : ''}</w:settings>`;
}

function contentTypesXml(media, extraOverrides = '') {
  const exts = new Set(media.map((m) => m.name.split('.').pop()));
  const defaults = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>'];
  for (const ext of exts) defaults.push(`<Default Extension="${ext}" ContentType="image/${ext === 'jpg' ? 'jpeg' : ext}"/>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `${defaults.join('')}` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `${extraOverrides}` +
    `</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;
}

function stylesXml() {
  const heading = (n, sz) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles ${W_NS}>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="24"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>` +
    heading(1, 48) + heading(2, 36) + heading(3, 28) +
    `</w:styles>`;
}

function numberingXml() {
  const bullet = `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`;
  const decimal = `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering ${W_NS}>${bullet}${decimal}` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
    `</w:numbering>`;
}

const cleanFont = (f) => (f || 'Arial').split(',')[0].replace(/['"]/g, '').trim() || 'Arial';
function hex6(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec((c || '').trim());
  if (m) return m[1].toUpperCase();
  const s = /^#?([0-9a-f]{3})$/i.exec((c || '').trim());
  if (s) return s[1].split('').map((x) => x + x).join('').toUpperCase();
  return '111111';
}
function mimeExt(dataUrl) {
  const m = /^data:image\/(png|jpe?g|gif|webp)/i.exec(dataUrl || '');
  if (!m) return 'png';
  return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
}

export function docxBlob(doc) {
  return blockModelToDocx(doc);
}

/* ========================================================================== */
/*  PDF (hand-written, text-based, word-wrapped, embedded Unicode font)        */
/* ========================================================================== */

// A real Unicode TrueType font (LiberationSans, bundled with pdf.js) is embedded
// as a Type0 / CIDFontType2, so the FULL Unicode repertoire — © ® ™ € £ ¥ → ← ↑
// ↓ × • § ¶ … — round-trips exactly instead of degrading to '?' the way the 14
// standard PDF fonts (WinAnsi, Latin-1 only) did. Text is written as 2-byte glyph
// ids (Identity-H) and measured with the font's OWN metrics, so the wrapping the
// exporter computes matches the glyphs it draws. Four weights/styles cover
// regular/bold/italic/bold-italic; every source family maps onto them (the app's
// UI font is a sans, and Unicode fidelity matters more than serif/mono nuance).
const FONT_URLS = {
  '00': '/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  '10': '/vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
  '01': '/vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf',
  '11': '/vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf',
};
const FONT_PS = {
  '00': 'LiberationSans', '10': 'LiberationSans-Bold',
  '01': 'LiberationSans-Italic', '11': 'LiberationSans-BoldItalic',
};

let _fontsPromise = null;
/** Fetch + parse the four embedded weights once; cached across exports. */
function loadPdfFonts() {
  if (!_fontsPromise) {
    _fontsPromise = (async () => {
      const recs = {};
      for (const key of Object.keys(FONT_URLS)) {
        const res = await fetch(FONT_URLS[key]);
        if (!res.ok) throw new Error(`font ${FONT_URLS[key]} → ${res.status}`);
        recs[key] = makeFontRecord(key, parseTtf(new Uint8Array(await res.arrayBuffer())));
      }
      return recs;
    })().catch((e) => { _fontsPromise = null; throw e; });
  }
  return _fontsPromise;
}

/** Precompute the per-font data the PDF needs: glyph→width table (1000-unit
 *  space) and a glyph→codepoint reverse map for the ToUnicode CMap. */
function makeFontRecord(key, ttf) {
  const scale = 1000 / ttf.unitsPerEm;
  const widths = new Array(ttf.numGlyphs);
  for (let g = 0; g < ttf.numGlyphs; g += 1) widths[g] = Math.round(ttf.advanceWidth(g) * scale);
  const rev = new Map();
  for (const [cp, g] of ttf.cmap) if (!rev.has(g)) rev.set(g, cp);
  return { key, id: `F${key}`, ps: FONT_PS[key], ttf, scale, widths, rev };
}

/** The embedded weight for a run's marks (bold/italic → one of four faces). */
const pickFont = (fonts, m) => fonts[`${m.bold ? 1 : 0}${m.italic ? 1 : 0}`];

/** Encode a string as Identity-H 2-byte glyph ids (hex). Characters the font
 *  lacks map to glyph 0 (.notdef); everything in its cmap round-trips exactly. */
function encodeGlyphs(text, rec) {
  let hex = '';
  for (const ch of String(text)) {
    const gid = rec.ttf.cmap.get(ch.codePointAt(0)) || 0;
    hex += gid.toString(16).padStart(4, '0');
  }
  return hex;
}

/** Text advance in CSS px, using the embedded font's real metrics (so measure ==
 *  render == PDF). */
function glyphWidthPx(text, rec, fontSizePx) {
  let units = 0;
  for (const ch of String(text)) units += rec.ttf.advanceWidth(rec.ttf.cmap.get(ch.codePointAt(0)) || 0);
  return (units / rec.ttf.unitsPerEm) * fontSizePx;
}

/**
 * Lay the block model out into pages of positioned text/image draw ops, then
 * assemble a PDF. Word-wrapping is measured with canvas metrics against the same
 * font family/size, so line breaks match the on-screen editor closely.
 * @param {object} doc block model
 * @param {{ imageQuality?:number }} [opts] JPEG quality for embedded pictures
 *   (0–1). Defaults to 0.85 for normal PDF export; the image (JPG/PNG) exporter
 *   passes near-1 so page rasters keep photo detail.
 */
export async function blockModelToPdf(doc, { imageQuality = 0.85 } = {}) {
  // Embedded Unicode font set (loaded once, cached) + per-run helpers. Measuring
  // with the SAME font that gets drawn keeps wrapping and glyphs consistent.
  const fonts = await loadPdfFonts();
  const measure = (text, m) => glyphWidthPx(text, pickFont(fonts, m), m.fontSize);
  // Break a single token that is wider than the available width into pieces that
  // each fit — the PDF equivalent of the editor's `overflow-wrap: break-word`, so
  // the long-token stress case wraps instead of overflowing the page/cell. Runs in
  // one pass over the string (cumulative width) so a multi-thousand-char token is
  // cheap. Ordinary words (narrower than the line) are returned untouched.
  const hardWrap = (tok, m, maxWpx) => {
    if (measure(tok, m) <= maxWpx || maxWpx <= 0) return [tok];
    const rec = pickFont(fonts, m);
    const out = [];
    let cur = '', curW = 0;
    for (const ch of tok) {
      const cw = glyphWidthPx(ch, rec, m.fontSize);
      if (cur && curW + cw > maxWpx) { out.push(cur); cur = ''; curW = 0; }
      cur += ch; curW += cw;
    }
    if (cur) out.push(cur);
    return out.length ? out : [tok];
  };
  // Pre-decode every image to JPEG bytes + pixel size before the (synchronous)
  // layout pass, so drawing stays a simple map lookup.
  const imageData = await decodeImages(doc, imageQuality);
  const pageWpt = (doc.page?.width || 816) * PX_TO_PT;
  const pageHpt = (doc.page?.height || 1056) * PX_TO_PT;
  const marginPt = (doc.page?.margin || 72) * PX_TO_PT;
  const contentWpx = (doc.page?.width || 816) - (doc.page?.margin || 72) * 2;
  const pageHpx = doc.page?.height || 1056;
  const marginPx = doc.page?.margin || 72;

  // Running head/foot: each page reserves vertical space for its header (top) and
  // footer (bottom) so body text never overlaps them — mirroring the editor. The
  // reserve can differ per page under Different first / odd & even.
  const headerCfg = normHf(doc.header);
  const footerCfg = normHf(doc.footer);
  function hfKindHeightPx(cfg, kind) {
    const blocks = hfBlocks(cfg, kind);
    if (hfIsEmpty(blocks)) return 0;
    return hfLinesFor(blocks, contentWpx, 1, 1).reduce((a, l) => a + l.lineHeightPx, 0);
  }
  const reservePx = (cfg, kind) => {
    const h = hfKindHeightPx(cfg, kind);
    return h ? Math.max(0, cfg.distance + h + HF_GAP - marginPx) : 0;
  };
  const headerReservePx = (idx) => reservePx(headerCfg, hfKindFor(headerCfg, idx));
  const footerReservePx = (idx) => reservePx(footerCfg, hfKindFor(footerCfg, idx));

  const pages = [];       // each: { ops:string[], images:[{name,bytes,w,h}] }
  let ops = [];
  let images = [];
  let curPageIdx = 0;     // 0-based index of the page currently being laid out
  let y = pageHpt - marginPt - headerReservePx(0) * PX_TO_PT;   // baseline cursor
  const fontsUsed = new Set();

  const newPage = () => {
    pages.push({ ops, images });
    ops = []; images = [];
    curPageIdx = pages.length;
    y = pageHpt - marginPt - headerReservePx(curPageIdx) * PX_TO_PT;
  };
  const need = (h) => { if (y - h < marginPt + footerReservePx(curPageIdx) * PX_TO_PT) newPage(); };

  // Emit one wrapped, mixed-run line of segments. `indentPx` shifts the left edge.
  function emitLine(segments, lineHeightPt, indentPx = 0) {
    need(lineHeightPt);
    y -= lineHeightPt;
    let xPx = (doc.page?.margin || 72) + indentPx;
    for (const seg of segments) {
      const m = seg.marks;
      const rec = pickFont(fonts, m);
      fontsUsed.add(rec);
      const sizePt = m.fontSize * PX_TO_PT;
      const [r, g, b] = hexToRgb(m.color);
      ops.push(`BT /${rec.id} ${round(sizePt)} Tf ${r} ${g} ${b} rg 1 0 0 1 ${round(xPx * PX_TO_PT)} ${round(y)} Tm <${encodeGlyphs(seg.text, rec)}> Tj ET`);
      if (m.underline) {
        const w = measure(seg.text, m) * PX_TO_PT;
        const uy = y - sizePt * 0.12;
        ops.push(`${r} ${g} ${b} RG ${round(sizePt * 0.06)} w ${round(xPx * PX_TO_PT)} ${round(uy)} m ${round(xPx * PX_TO_PT + w)} ${round(uy)} l S`);
      }
      if (m.strike) {
        const w = measure(seg.text, m) * PX_TO_PT;
        const sy = y + sizePt * 0.3; // through the middle of the glyphs
        ops.push(`${r} ${g} ${b} RG ${round(sizePt * 0.06)} w ${round(xPx * PX_TO_PT)} ${round(sy)} m ${round(xPx * PX_TO_PT + w)} ${round(sy)} l S`);
      }
      xPx += measure(seg.text, m);
    }
  }

  // Word-wrap a run sequence into lines of segments that fit `maxWpx`.
  function wrapRuns(runs, maxWpx, indentPx = 0) {
    const lineHeightPx = Math.max(...runs.map((r) => marksOf(r).fontSize), 16) * 1.4;
    const lineHeightPt = lineHeightPx * PX_TO_PT;
    let line = [];
    let lineW = 0;
    const flush = () => { emitLine(line.length ? line : [{ text: '', marks: DEFAULT_MARKS }], lineHeightPt, indentPx); line = []; lineW = 0; };

    for (const run of runs) {
      const m = marksOf(run);
      // Split keeping spaces so widths stay accurate; break any over-wide token.
      const tokens = (run.text || '').split(/(\s+)/).filter((t) => t !== '');
      for (const raw of tokens) {
        for (const tok of hardWrap(raw, m, maxWpx)) {
          const w = measure(tok, m);
          if (lineW + w > maxWpx && lineW > 0 && tok.trim()) flush();
          line.push({ text: tok, marks: m });
          lineW += w;
        }
      }
    }
    flush();
  }

  for (const block of (doc.blocks || [])) {
    try {
      if (block.type === 'image') { drawImage(block); y -= 8 * PX_TO_PT; continue; }
      if (block.type === 'list') {
        block.items.forEach((it, i) => {
          const prefix = block.ordered ? `${i + 1}. ` : '• ';
          const runs = [{ text: prefix, marks: marksOf((it.runs || [])[0] || {}) }, ...(it.runs || [])];
          wrapRuns(runs, contentWpx - 24, 24);
        });
        y -= 4 * PX_TO_PT;
        continue;
      }
      if (block.type === 'table') { drawTable(block); continue; }
      // paragraph / heading
      const runs = (block.runs && block.runs.length) ? block.runs : [{ text: '', marks: {} }];
      wrapRuns(runs, contentWpx);
      y -= (block.style?.spaceAfter ?? 10) * PX_TO_PT;
    } catch {
      // Never let one malformed block abort the whole export.
    }
  }
  newPage();

  // Now the real page count is known: stamp the running head/foot onto every page,
  // substituting the page number / total in fields.
  const totalPages = pages.length;
  pages.forEach((pg, idx) => {
    try {
      drawHf(pg, 'header', headerCfg, idx, totalPages);
      drawHf(pg, 'footer', footerCfg, idx, totalPages);
    } catch { /* never let a header/footer abort the export */ }
  });

  /** Wrap a header/footer's blocks into visual lines carrying alignment + height,
   *  with page-number / count fields substituted for the given page. */
  function hfLinesFor(blocks, maxWpx, pageNumber, total) {
    const out = [];
    const emitPara = (runs, align, indent, maxW) => {
      const subbed = substFields(runs, pageNumber, total);
      const lh = Math.max(...subbed.map((r) => marksOf(r).fontSize), 16) * 1.4;
      let line = []; let lineW = 0;
      const flush = () => {
        out.push({ segments: line.length ? line : [{ text: '', marks: DEFAULT_MARKS }], align, lineHeightPx: lh, indent });
        line = []; lineW = 0;
      };
      for (const run of subbed) {
        const m = marksOf(run);
        for (const raw of (run.text || '').split(/(\s+)/).filter((t) => t !== '')) {
          for (const tok of hardWrap(raw, m, maxW)) {
            const w = measure(tok, m);
            if (lineW + w > maxW && lineW > 0 && tok.trim()) flush();
            line.push({ text: tok, marks: m }); lineW += w;
          }
        }
      }
      flush();
    };
    for (const block of blocks || []) {
      if (block.type === 'list') {
        (block.items || []).forEach((it, i) => {
          const prefix = block.ordered ? `${i + 1}. ` : '• ';
          emitPara([{ text: prefix, marks: marksOf((it.runs || [])[0] || {}) }, ...(it.runs || [])], block.style?.align || 'left', 24, maxWpx - 24);
        });
      } else if (!block.type || block.type === 'paragraph') {
        emitPara(block.runs || [], block.style?.align || 'left', 0, maxWpx);
      }
    }
    return out;
  }

  /** Draw one page's header (from the top) or footer (anchored to the bottom). */
  function drawHf(pageObj, part, cfg, pageIdx, total) {
    const kind = hfKindFor(cfg, pageIdx);
    const blocks = hfBlocks(cfg, kind);
    if (hfIsEmpty(blocks)) return;
    const lines = hfLinesFor(blocks, contentWpx, pageIdx + 1, total);
    const totalH = lines.reduce((a, l) => a + l.lineHeightPx, 0);
    let topPx = part === 'header' ? cfg.distance : (pageHpx - cfg.distance - totalH);
    for (const line of lines) {
      const lineW = line.segments.reduce((a, s) => a + measure(s.text, s.marks), 0);
      const indent = line.indent || 0;
      let xPx = marginPx + indent;
      if (line.align === 'center') xPx = marginPx + indent + Math.max(0, (contentWpx - indent - lineW) / 2);
      else if (line.align === 'right') xPx = marginPx + Math.max(0, contentWpx - lineW);
      const baselineFromTopPx = topPx + line.lineHeightPx * 0.8;
      const yPt = pageHpt - baselineFromTopPx * PX_TO_PT;
      for (const seg of line.segments) {
        const m = seg.marks; const rec = pickFont(fonts, m); fontsUsed.add(rec);
        const [r, g, b] = hexToRgb(m.color);
        pageObj.ops.push(`BT /${rec.id} ${round(m.fontSize * PX_TO_PT)} Tf ${r} ${g} ${b} rg 1 0 0 1 ${round(xPx * PX_TO_PT)} ${round(yPt)} Tm <${encodeGlyphs(seg.text, rec)}> Tj ET`);
        xPx += measure(seg.text, m);
      }
      topPx += line.lineHeightPx;
    }
  }

  function drawImage(block) {
    try {
      const jpg = imageData.get(block.src);
      if (!jpg) return;
      const wPx = Math.min(block.width || jpg.w, contentWpx);
      const scale = wPx / jpg.w;
      const hPx = jpg.h * scale;
      const hPt = hPx * PX_TO_PT;
      need(hPt);
      y -= hPt;
      const name = `Im${images.length}_${pages.length}`;
      images.push({ name, bytes: jpg.bytes, w: jpg.w, h: jpg.h });
      const xPt = marginPt;
      ops.push(`q ${round(wPx * PX_TO_PT)} 0 0 ${round(hPt)} ${round(xPt)} ${round(y)} cm /${name} Do Q`);
    } catch { /* skip bad image */ }
  }

  function drawTable(block) {
    const padPx = 6;
    // Reconstruct logical positions/spans so merged cells lay out correctly.
    const masters = blockTableMasters(block);
    const { grid, nrows, ncols } = TG.occupancy(masters);
    const cols = Math.max(1, ncols);
    // Per-column widths (px): honour dragged column fractions when present.
    const fracs = (Array.isArray(block.cols) && block.cols.length === cols) ? block.cols : null;
    const colWpx = Array.from({ length: cols }, (_, i) => contentWpx * (fracs ? fracs[i] : 1 / cols));
    const colXpx = [0];
    for (let i = 0; i < cols; i += 1) colXpx.push(colXpx[i] + colWpx[i]);
    const noBorder = block.border === 'none';
    const stroke = block.border === 'thick' ? '0.36 0.38 0.44 RG 1.5 w' : '0.6 0.65 0.72 RG 0.75 w';
    const has = (cell, ch) => !!(cell && cell.hide && cell.hide.includes(ch));

    // Pre-wrap each master to its (spanned) width and distribute its content
    // height across the rows it covers so a row is tall enough for every cell.
    const linesOf = new Map();
    const rowHpx = new Array(nrows).fill(20 + padPx * 2);
    for (const m of masters) {
      const width = colWpx.slice(m.c, m.c + m.cs).reduce((a, b) => a + b, 0);
      const lines = splitCellLines(m.cell.runs || [], width - padPx * 2);
      linesOf.set(m, lines);
      const per = (lines.length * 20 + padPx * 2) / m.rs;
      for (let dr = 0; dr < m.rs; dr += 1) rowHpx[m.r + dr] = Math.max(rowHpx[m.r + dr], per);
    }
    for (let r = 0; r < nrows; r += 1) rowHpx[r] = Math.max(rowHpx[r], (block.rowH && block.rowH[r]) || 0);

    const at = (r, c) => (r >= 0 && r < nrows && c >= 0 && c < cols ? grid[r][c] : null);
    for (let ri = 0; ri < nrows; ri += 1) {
      const rowHpt = rowHpx[ri] * PX_TO_PT;
      need(rowHpt);
      const top = y;
      const bottom = y - rowHpt;
      if (!noBorder) {
        // Vertical boundaries — skip where the same master spans both sides.
        for (let c = 0; c <= cols; c += 1) {
          const left = c > 0 ? at(ri, c - 1) : null;
          const right = c < cols ? at(ri, c) : null;
          if (left && right && left === right) continue;
          if (has(left && left.cell, 'r') || has(right && right.cell, 'l')) continue;
          const xPt = marginPt + colXpx[c] * PX_TO_PT;
          ops.push(`${stroke} ${round(xPt)} ${round(top)} m ${round(xPt)} ${round(bottom)} l S`);
        }
        // Horizontal top edges — skip where a master spans down across the line.
        for (let ci = 0; ci < cols; ci += 1) {
          const cur = at(ri, ci);
          const above = at(ri - 1, ci);
          if (cur && above && cur === above) continue;
          if (has(cur && cur.cell, 't') || has(above && above.cell, 'b')) continue;
          const x0 = marginPt + colXpx[ci] * PX_TO_PT;
          const x1 = marginPt + colXpx[ci + 1] * PX_TO_PT;
          ops.push(`${stroke} ${round(x0)} ${round(top)} m ${round(x1)} ${round(top)} l S`);
        }
        if (ri === nrows - 1) {
          for (let ci = 0; ci < cols; ci += 1) {
            if (has(at(ri, ci) && at(ri, ci).cell, 'b')) continue;
            const x0 = marginPt + colXpx[ci] * PX_TO_PT;
            const x1 = marginPt + colXpx[ci + 1] * PX_TO_PT;
            ops.push(`${stroke} ${round(x0)} ${round(bottom)} m ${round(x1)} ${round(bottom)} l S`);
          }
        }
      }
      // Draw each master's text once, anchored at its origin cell.
      for (let ci = 0; ci < cols; ci += 1) {
        const m = at(ri, ci);
        if (!m || m.r !== ri || m.c !== ci) continue;
        let ty = top - padPx * PX_TO_PT;
        for (const segLine of linesOf.get(m)) {
          ty -= 18 * PX_TO_PT;
          let xPx = (doc.page?.margin || 72) + colXpx[ci] + padPx;
          for (const seg of segLine) {
            const mk = seg.marks; const rec = pickFont(fonts, mk); fontsUsed.add(rec);
            const [r, g, b] = hexToRgb(mk.color);
            ops.push(`BT /${rec.id} ${round(mk.fontSize * PX_TO_PT)} Tf ${r} ${g} ${b} rg 1 0 0 1 ${round(xPx * PX_TO_PT)} ${round(ty)} Tm <${encodeGlyphs(seg.text, rec)}> Tj ET`);
            xPx += measure(seg.text, mk);
          }
        }
      }
      y = bottom;
    }
    y -= 8 * PX_TO_PT;
  }

  // Wrap a cell's runs into lines (array of segment arrays) for table layout.
  function splitCellLines(runs, maxWpx) {
    const lines = [];
    let line = []; let lineW = 0;
    for (const run of runs) {
      const m = marksOf(run);
      for (const raw of (run.text || '').split(/(\s+)/).filter((t) => t !== '')) {
        for (const tok of hardWrap(raw, m, maxWpx)) {
          const w = measure(tok, m);
          if (lineW + w > maxWpx && lineW > 0 && tok.trim()) { lines.push(line); line = []; lineW = 0; }
          line.push({ text: tok, marks: m }); lineW += w;
        }
      }
    }
    if (line.length) lines.push(line);
    return lines.length ? lines : [[{ text: '', marks: DEFAULT_MARKS }]];
  }

  return new Blob([assemblePdf(pages, pageWpt, pageHpt, fontsUsed)], { type: 'application/pdf' });
}

/** UTF-16BE hex for a codepoint (surrogate pair when outside the BMP). */
function utf16hex(cp) {
  if (cp <= 0xffff) return cp.toString(16).padStart(4, '0');
  const c = cp - 0x10000;
  return (0xd800 + (c >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (c & 0x3ff)).toString(16).padStart(4, '0');
}

/** A ToUnicode CMap mapping each glyph id (2-byte CID) back to its Unicode, so
 *  selecting/copying text from the PDF yields the real characters. */
function toUnicodeCMap(rec) {
  const entries = [...rec.rev.entries()].sort((a, b) => a[0] - b[0]);
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n`;
    for (const [gid, cp] of chunk) body += `<${gid.toString(16).padStart(4, '0')}> <${utf16hex(cp)}>\n`;
    body += 'endbfchar\n';
  }
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${body}endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

/** Build the PDF byte stream from laid-out pages. */
function assemblePdf(pages, pageWpt, pageHpt, fontsUsed) {
  const enc = new TextEncoder();
  const chunks = [];
  let len = 0;
  const put = (d) => { const u8 = typeof d === 'string' ? enc.encode(d) : d; chunks.push(u8); len += u8.length; };

  const fontList = [...fontsUsed];

  // Object numbering (computed up-front so cross-references resolve):
  // 1: Catalog, 2: Pages, then FIVE objects per embedded font (Type0, CIDFont,
  // FontDescriptor, FontFile2, ToUnicode), then per page: content + images + page.
  const fontBase = 3;
  const fontPlan = new Map(); // rec → { type0, cid, fd, file, toUni }
  fontList.forEach((rec, i) => {
    const b = fontBase + i * 5;
    fontPlan.set(rec, { type0: b, cid: b + 1, fd: b + 2, file: b + 3, toUni: b + 4 });
  });
  let next = fontBase + fontList.length * 5;
  const pagePlan = pages.map((pg) => {
    const contentNo = next++;
    const imageNos = pg.images.map(() => next++);
    const pageNo = next++;
    return { contentNo, imageNos, pageNo };
  });
  const totalObjs = next - 1;

  put('%PDF-1.4\n');
  put(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const offsets = new Array(totalObjs + 1).fill(0);
  const mark = (no) => { offsets[no] = len; };
  const obj = (no, body) => { mark(no); put(`${no} 0 obj\n`); put(body); put('\nendobj\n'); };
  const objBin = (no, head, bytes, tail) => { mark(no); put(`${no} 0 obj\n`); put(head); put(bytes); put(tail); put('\nendobj\n'); };

  const kids = pagePlan.map((p) => `${p.pageNo} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);

  // Embed each used font as a Type0 → CIDFontType2 with the raw TrueType program
  // (FontFile2, CIDToGIDMap Identity) plus a ToUnicode CMap for copy/extract.
  for (const rec of fontList) {
    const n = fontPlan.get(rec);
    const t = rec.ttf; const s = rec.scale;
    const bbox = t.bbox.map((v) => Math.round(v * s)).join(' ');
    const flags = 32 | (rec.key[1] === '1' ? 64 : 0); // nonsymbolic (+italic)
    obj(n.type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${rec.ps} /Encoding /Identity-H /DescendantFonts [${n.cid} 0 R] /ToUnicode ${n.toUni} 0 R >>`);
    obj(n.cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${rec.ps} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${n.fd} 0 R /CIDToGIDMap /Identity /DW 1000 /W [0 [${rec.widths.join(' ')}]] >>`);
    obj(n.fd, `<< /Type /FontDescriptor /FontName /${rec.ps} /Flags ${flags} /FontBBox [${bbox}] /ItalicAngle ${round(t.italicAngle)} /Ascent ${Math.round(t.ascent * s)} /Descent ${Math.round(t.descent * s)} /CapHeight ${Math.round(t.capHeight * s)} /StemV 80 /FontFile2 ${n.file} 0 R >>`);
    objBin(n.file, `<< /Length ${t.bytes.length} /Length1 ${t.bytes.length} >>\nstream\n`, t.bytes, '\nendstream');
    const cmap = toUnicodeCMap(rec);
    obj(n.toUni, `<< /Length ${enc.encode(cmap).length} >>\nstream\n${cmap}\nendstream`);
  }

  pages.forEach((pg, pi) => {
    const plan = pagePlan[pi];
    const stream = pg.ops.join('\n');
    obj(plan.contentNo, `<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}\nendstream`);
    pg.images.forEach((im, ii) => {
      const head = `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`;
      objBin(plan.imageNos[ii], head, im.bytes, '\nendstream');
    });
    const fontRes = fontList.map((rec) => `/${rec.id} ${fontPlan.get(rec).type0} 0 R`).join(' ');
    const xobjRes = pg.images.map((im, ii) => `/${im.name} ${plan.imageNos[ii]} 0 R`).join(' ');
    const resources = `<< /Font << ${fontRes} >>${xobjRes ? ` /XObject << ${xobjRes} >>` : ''} >>`;
    obj(plan.pageNo, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${round(pageWpt)} ${round(pageHpt)}] /Resources ${resources} /Contents ${plan.contentNo} 0 R >>`);
  });

  const xrefOffset = len;
  let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= totalObjs; n += 1) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  put(xref);
  put(`trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/** Decode every image block to JPEG bytes + pixel dimensions (async). */
async function decodeImages(doc, quality = 0.85) {
  const map = new Map();
  const srcs = [...new Set((doc.blocks || []).filter((b) => b.type === 'image' && b.src).map((b) => b.src))];
  for (const src of srcs) {
    try {
      const img = await loadImage(src);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const jpegUrl = canvas.toDataURL('image/jpeg', quality);
      map.set(src, { bytes: dataURLToBytes(jpegUrl), w: canvas.width, h: canvas.height });
    } catch { /* skip images that fail to decode */ }
  }
  return map;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Rasterise SVG-data-URL images (charts, shapes) to PNG data URLs so they can be
 *  embedded in .docx (which can't take raw SVG). 2× for crisp text. Best-effort:
 *  a src that can't be rasterised is left as-is (imageXml then skips it). */
async function rasterizeSvgImages(doc, scale = 2) {
  const map = new Map();
  if (typeof document === 'undefined' || typeof Image === 'undefined') return map;
  const srcs = [...new Set((doc.blocks || [])
    .filter((b) => b.type === 'image' && /^data:image\/svg/i.test(b.src || ''))
    .map((b) => b.src))];
  for (const src of srcs) {
    try {
      const img = await loadImage(src);
      const w = Math.max(1, Math.round(img.naturalWidth || img.width || 480));
      const h = Math.max(1, Math.round(img.naturalHeight || img.height || 300));
      const canvas = document.createElement('canvas');
      canvas.width = w * scale; canvas.height = h * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      map.set(src, canvas.toDataURL('image/png'));
    } catch { /* leave as-is; imageXml will skip an unembeddable src */ }
  }
  return map;
}

function hexToRgb(hex) {
  const h = hex6(hex);
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255].map((n) => round(n));
}
function round(n) { return Math.round(n * 1000) / 1000; }
