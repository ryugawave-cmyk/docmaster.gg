/**
 * Layer-based rendering architecture.
 *
 * A page is composed as a stack of ordered layers, painted bottom-to-top. Every
 * object declares which layer it lives on (`obj.layer`), and the renderer walks
 * the stack so, e.g., markup always sits above content and selection handles
 * always sit above markup — regardless of insertion order.
 *
 * Layers are the seam future features slot into: OCR text renders on its own
 * `ocr` layer that can be toggled independently; an AI panel can preview
 * suggestions on a throwaway layer above everything; form fields highlight on
 * their own layer. A plugin adds a layer once and the pipeline honours it.
 *
 * Each layer descriptor:
 *   { id, z, visible, opacity, hitTestable, interactive }
 *   - z            paint order (lower paints first / further back)
 *   - visible      skipped by the renderer when false (data is retained)
 *   - hitTestable  whether hit testing considers its objects
 *   - interactive  whether it holds user objects (vs. engine overlays like
 *                  selection handles, which are painted but never hit-tested
 *                  as document content)
 */

/** Canonical layer ids used by the core object types. */
export const LAYERS = Object.freeze({
  BACKGROUND: 'background', // the page/PDF raster itself (owned by the canvas)
  CONTENT: 'content', // text, images, signatures — "real" document content
  ANNOTATION: 'annotation', // shapes, form fields — layered over content
  MARKUP: 'markup', // ink, highlights, comments, sticky notes
  SELECTION: 'selection', // engine-drawn selection handles / marquee (overlay)
  UI: 'ui', // transient tool overlays (drag previews, guides)
});

/**
 * An ordered, mutable set of layers for a single engine instance. All pages
 * share the same stack definition; per-page object membership is resolved by
 * `obj.layer`, so the stack stays tiny and memory-cheap regardless of doc size.
 */
export function createLayerStack() {
  /** @type {Map<string, object>} */
  const byId = new Map();

  function define(layer) {
    if (!layer || !layer.id) throw new Error('Layer needs an id');
    const existing = byId.get(layer.id);
    byId.set(layer.id, {
      id: layer.id,
      z: layer.z ?? existing?.z ?? byId.size,
      visible: layer.visible ?? existing?.visible ?? true,
      opacity: layer.opacity ?? existing?.opacity ?? 1,
      hitTestable: layer.hitTestable ?? existing?.hitTestable ?? true,
      interactive: layer.interactive ?? existing?.interactive ?? true,
    });
    return byId.get(layer.id);
  }

  function get(id) {
    return byId.get(id);
  }

  function setVisible(id, visible) {
    const layer = byId.get(id);
    if (layer) layer.visible = visible;
  }

  /** Layers in paint order (back to front). */
  function ordered() {
    return [...byId.values()].sort((a, b) => a.z - b.z);
  }

  /** Hit-testable layers in front-to-back order (topmost first). */
  function hitOrder() {
    return ordered()
      .filter((l) => l.hitTestable && l.visible)
      .reverse();
  }

  // Seed the canonical stack. Plugins may `define()` more or re-define these.
  define({ id: LAYERS.BACKGROUND, z: 0, interactive: false, hitTestable: false });
  define({ id: LAYERS.CONTENT, z: 10 });
  define({ id: LAYERS.ANNOTATION, z: 20 });
  define({ id: LAYERS.MARKUP, z: 30 });
  define({ id: LAYERS.SELECTION, z: 90, interactive: false, hitTestable: false });
  define({ id: LAYERS.UI, z: 100, interactive: false, hitTestable: false });

  return { define, get, setVisible, ordered, hitOrder, has: (id) => byId.has(id) };
}
