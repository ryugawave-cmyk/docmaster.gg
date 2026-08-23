/**
 * Reference plugin: draw shapes.
 *
 * Gives the existing `shapes` tool real drag-to-create behaviour, reading its
 * live properties (kind/fill/stroke/width/opacity) straight from the tool
 * settings the properties panel already writes. It demonstrates the creation
 * path a text/image/signature/stamp tool will each follow:
 *
 *   drag → live rubber-band preview (renderer preview, no history)
 *   release → one `addObject` command (undoable) → object selected
 *
 * The tool builds a plain object via the object model, so it is instantly
 * hit-testable, indexed, layered and selectable with zero extra work.
 */

import { rectFromPoints } from '../geometry.js';

const MIN_SIZE = 3; // ignore accidental click-without-drag

export const shapeToolPlugin = {
  name: 'builtin:shapes',

  interactions: {
    shapes: {
      onPointerDown(api) {
        api.session.draw = { origin: api.point, pageIndex: api.pageIndex };
      },

      onPointerMove(api) {
        const draw = api.session.draw;
        if (!draw) return;
        draw.box = rectFromPoints(draw.origin, api.point);
        const obj = buildShape(api, draw.box);
        // Live preview only — nothing enters the document until release.
        api.renderer.setPreview(draw.pageIndex, {
          bounds: api.document.indexRect(obj),
          paint: (ctx) => api.model.draw(ctx, obj, {}),
        });
      },

      onPointerUp(api) {
        const draw = api.session.draw;
        if (!draw) return;
        api.renderer.setPreview(draw.pageIndex, null);
        if (!draw.box || draw.box.width < MIN_SIZE || draw.box.height < MIN_SIZE) return;

        const obj = buildShape(api, draw.box);
        api.execute(api.commands.addObject(draw.pageIndex, obj, { label: 'Add shape' }));
        api.selection.selectOne(obj.id, draw.pageIndex);
      },
    },
  },
};

/** Compose a shape object from the drag box + the tool's current settings. */
function buildShape(api, box) {
  const s = api.settings;
  return api.createObject('shape', {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    kind: s.shape || 'rect',
    fill: s.fill || '#6366f1',
    stroke: s.stroke || '#4f46e5',
    strokeWidth: s.strokeWidth ?? 2,
    opacity: s.opacity != null ? s.opacity / 100 : 1,
  });
}
