/**
 * PDF/document → Excel (.xlsx).
 *
 * An .xlsx is an OOXML ZIP. We reconstruct the table grid from the positioned
 * text (see rows.js — coordinate-based row/column detection) and write cells as
 * inline strings (so no shared-strings part is needed). One worksheet per
 * document, pages separated by a blank row.
 */
import { zipBlob } from '../zip.js';
import { xml, buildContentModel } from './model.js';
import { pageToTable } from './rows.js';

function colName(n) {
  let s = ''; n += 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export function modelToXlsx(model, opts = {}) {
  const content = buildContentModel(model, opts.name);

  // STAGE 0 — extraction: the runs the content model produced, per page. Set
  // `window.__XLSX_DEBUG = true` in the console before exporting to see these
  // (and every later stage logged from rows.js).
  if (typeof globalThis !== 'undefined' && globalThis.__XLSX_DEBUG) {
    content.pages.forEach((pg, i) => {
      console.log(`%c[xlsx] STAGE 0 page ${i} extracted runs (${pg.runs.length})`,
        'color:#2563eb;font-weight:600',
        pg.runs.map((r) => ({ text: r.text, x: r.x, y: r.y, w: r.w, h: r.h, fs: r.fontSize })));
    });
  }

  const rows = [];
  content.pages.forEach((pg, i) => {
    if (i > 0) rows.push([]); // blank separator row between pages
    for (const r of pageToTable(pg)) rows.push(r);
  });
  if (!rows.length) rows.push(['No extractable text was found in this document.']);

  return rowsToXlsxBlob(rows);
}

/**
 * Package a 2-D array of cell values into an .xlsx Blob. Shared by the PDF path
 * (coordinate-reconstructed rows) and the Document editor path (block-model rows
 * in `blockExport.js`) so both produce identical, well-formed spreadsheets.
 * @param {Array<Array<string|number>>} rows
 */
export function rowsToXlsxBlob(rows) {
  if (!rows.length) rows = [['No content was found in this document.']];

  let maxCols = 1;
  for (const r of rows) maxCols = Math.max(maxCols, r.length);

  // Auto-fit column widths: size each column to its longest value so invoice
  // numbers, dates, product names, etc. are fully visible. The OOXML `width`
  // unit is roughly one character of the default font; add a little padding and
  // clamp so a stray long cell can't produce an absurdly wide column.
  const MIN_W = 8;
  const MAX_W = 80;
  const widths = new Array(maxCols).fill(MIN_W);
  for (const r of rows) {
    for (let ci = 0; ci < r.length; ci += 1) {
      const len = String(r[ci] == null ? '' : r[ci]).length;
      const w = Math.min(Math.max(len + 2, MIN_W), MAX_W);
      if (w > widths[ci]) widths[ci] = w;
    }
  }
  const colsXml = `<cols>${widths
    .map((w, ci) => `<col min="${ci + 1}" max="${ci + 1}" width="${w}" customWidth="1"/>`)
    .join('')}</cols>`;

  const sheetRows = rows.map((cells, ri) => {
    const r = ri + 1;
    const cs = cells.map((val, ci) => {
      const ref = `${colName(ci)}${r}`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(val)}</t></is></c>`;
    }).join('');
    return `<row r="${r}">${cs}</row>`;
  }).join('');

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="A1:${colName(maxCols - 1)}${rows.length}"/>` +
    `${colsXml}<sheetData>${sheetRows}</sheetData></worksheet>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';

  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>';

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
    '</styleSheet>';

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  return zipBlob([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: styles },
  ], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
