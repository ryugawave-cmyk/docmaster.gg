/**
 * Editor ↔ DocumentModel structural mapping.
 *
 * The blank-PDF editor's working representation is a flat page/object structure
 * (`{ pages:[{ id, bg, w, h, objects, images }] }`, objects carrying flat
 * x/y/w/h). The canonical DocumentModel uses `{ id, size:{w,h}, rasterRef,
 * layers, images }` with each node's geometry in a `box`. These two mappers keep
 * the model an always-current mirror of the editor (forward) and let the editor
 * be rebuilt FROM the model (inverse), closing the loop so DocumentModel is the
 * single source of truth for STRUCTURE, not just history.
 *
 * Pure and DOM-free → unit-testable in Node. Round-trip fidelity is what makes
 * "load from the model" safe: forward∘inverse must preserve every property.
 *
 * `bg` (page raster, a data URL) rides through as `rasterRef`. `images` are the
 * PDF's embedded pictures, kept off the editable layer stack. `normalizeNode`
 * (model) lifts flat x/y/w/h into `box` and preserves every other property.
 */

/** Editor structure → DocumentModel pages. */
export function editorSnapshotToPages(snap) {
  return (snap && snap.pages ? snap.pages : []).map((p) => ({
    id: p.id,
    size: { w: p.w, h: p.h },
    rasterRef: p.bg || null,
    layers: (p.objects || []).map((o) => ({ ...o })),
    images: (p.images || []).map((im) => ({ ...im })),
  }));
}

/** Sync an editor structure into a DocumentModel's pages. Returns the model. */
export function syncEditorToModel(doc, structure) {
  doc.setStructure(editorSnapshotToPages(structure));
  return doc;
}

/** One DocumentModel node → an editor object (box → flat x/y/w/h, rest kept). */
function nodeToObject(node) {
  const { box, ...rest } = node;
  const b = box || {};
  return { ...rest, x: b.x || 0, y: b.y || 0, w: b.w || 0, h: b.h || 0 };
}

/**
 * DocumentModel → an editor snapshot the engine's `restore()` accepts
 * (`{ pageIndex, size, PW, PH, pages:[{ id, bg, w, h, objects, images }] }`).
 * Inverse of `editorSnapshotToPages`.
 */
export function pagesToEditorSnapshot(model, { pageIndex = 0, size = 'Custom' } = {}) {
  const pages = (model && model.pages) || [];
  const first = pages[0];
  return {
    pageIndex,
    size,
    PW: first ? first.size.w : 794,
    PH: first ? first.size.h : 1123,
    pages: pages.map((p) => ({
      id: p.id,
      bg: p.rasterRef || null,
      w: p.size.w,
      h: p.size.h,
      objects: (p.layers || []).map(nodeToObject),
      images: (p.images || []).map((im) => ({ ...im })),
    })),
  };
}

/**
 * Build the exporter's flat model straight from a DocumentModel — the shape the
 * converters (pdfExport / docx / xlsx / pptx) consume:
 * `{ PW, PH, pages:[{ bg, w, h, objects, images }] }`. Proven byte-identical to
 * the editor's legacy `getExportModel()` (same data, key order aside), so the
 * export path can be rerouted through DocumentModel — the single source of truth
 * — without changing any output. Kept as a separate function so that reroute is
 * a one-liner switch that stays independently testable.
 */
export function exportModelFromDoc(model) {
  const snap = pagesToEditorSnapshot(model);
  return {
    PW: snap.PW,
    PH: snap.PH,
    pages: snap.pages.map((p) => ({ bg: p.bg || null, w: p.w, h: p.h, objects: p.objects, images: p.images })),
  };
}
