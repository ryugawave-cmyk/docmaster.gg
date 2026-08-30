/**
 * Pure font weight / style inference from PDF font names.
 *
 * PDF text runs reference an embedded font whose PostScript / base name encodes the
 * weight and slant as a suffix — "Calibri-Bold", "Roboto-Medium", "Arial-SemiBold",
 * "Helvetica-BlackItalic" — often behind a subset tag ("BCDEEE+…"). The importer
 * reads that name off the resolved font object and turns it into concrete
 * bold/italic/weight so a bold heading in the PDF STAYS bold after Transfer to Doc
 * (and, crucially, so regular text is never blanket-bolded).
 *
 * Kept dependency-free (no pdfjs, no DOM) so it can be unit-tested in isolation —
 * see scripts/verify-font-weight.mjs.
 */

/**
 * Numeric CSS weight (100–900) inferred from a font name. Order matters: the
 * compound weights (extra/semi/ultra) MUST be tested before the plain "bold"/"light"
 * they contain, or "SemiBold" would read as "Bold". Anything unrecognised is the CSS
 * default, 400 (regular).
 * @param {string} name  a PostScript/base font name (subset tag tolerated)
 * @returns {number} 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
 */
export function weightFromName(name) {
  const n = String(name || '').toLowerCase();
  if (/thin|hairline/.test(n)) return 100;
  if (/extra\W?light|ultra\W?light/.test(n)) return 200;
  if (/semi\W?bold|demi\W?bold/.test(n)) return 600;
  if (/extra\W?bold|ultra\W?bold/.test(n)) return 800;
  if (/black|heavy/.test(n)) return 900;
  if (/bold/.test(n)) return 700;
  if (/medium/.test(n)) return 500;
  if (/light/.test(n)) return 300;
  return 400;
}

/**
 * Resolve concrete bold/italic/weight from a font name (+ optional generic family
 * hint) and any explicit flags the font object already carries.
 *
 * Semibold (600) and up read as visually bold in the (binary-bold) DOC editor;
 * medium (500) and lighter stay regular, so we never over-bold. An explicit bold /
 * italic flag from the font wins even when the name doesn't spell it out.
 *
 * @param {string} name  PostScript/base font name
 * @param {string} [familyHint]  PDF.js generic family hint (e.g. "sans-serif")
 * @param {{bold?:boolean, italic?:boolean}} [flags]  explicit font-object flags
 * @returns {{bold:boolean, italic:boolean, weight:number}}
 */
export function fontPropsFromName(name, familyHint = '', flags = {}) {
  const probe = `${name || ''} ${familyHint || ''}`;
  const weight = weightFromName(probe);
  const bold = flags.bold === true || weight >= 600;
  const italic = flags.italic === true || /italic|oblique/i.test(probe);
  return { bold, italic, weight };
}
