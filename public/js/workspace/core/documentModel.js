/**
 * Document model factories.
 *
 * A document is a serializable description of pages. The canvas renders from it
 * and future editing tools will mutate it (via history commands). Keeping this
 * as plain data makes save/export/undo straightforward later.
 */

// Base page size ~ A4 at 96dpi.
export const PAGE_DEFAULT = Object.freeze({ width: 794, height: 1123 });

let pageSeq = 0;
function nextPageId() {
  pageSeq += 1;
  return `page-${pageSeq}`;
}

/**
 * @param {Partial<{width:number,height:number,kind:string,source:string,rotation:number,label:string}>} [overrides]
 */
export function createPage(overrides = {}) {
  return {
    id: nextPageId(),
    width: PAGE_DEFAULT.width,
    height: PAGE_DEFAULT.height,
    rotation: 0,
    kind: 'blank', // 'blank' | 'image' | 'pdf'
    source: null,
    // Layer of annotations/objects added by tools (empty for now).
    objects: [],
    ...overrides,
  };
}

function baseDocument(meta = {}) {
  return {
    id: `doc-${Date.now()}`,
    name: meta.name || 'Untitled document',
    size: meta.size || 0,
    type: meta.type || 'application/pdf',
    pages: [],
  };
}

/**
 * A blank multi-page document (useful for starting from scratch / demos).
 * @param {number} pageCount
 * @param {object} [meta]
 */
export function createBlankDocument(pageCount = 1, meta = {}) {
  const doc = baseDocument(meta);
  doc.pages = Array.from({ length: Math.max(1, pageCount) }, () => createPage());
  return doc;
}

/**
 * A document whose pages are raster images.
 * @param {{src:string,width:number,height:number}[]} images
 * @param {object} [meta]
 */
export function createImageDocument(images, meta = {}) {
  const doc = baseDocument({ type: 'image', ...meta });
  doc.pages = images.map((img) =>
    createPage({ kind: 'image', source: img.src, width: img.width, height: img.height })
  );
  return doc;
}

// PDF documents are produced by the PDF viewer (`pdf/pdfViewer.js`), which
// decodes the file with PDF.js and builds real, accurately-sized `kind: 'pdf'`
// pages. Pages carry `kind: 'pdf'` so the canvas leaves their background canvas
// for the viewer to paint.
