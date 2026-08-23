/**
 * Reference plugin: Select / move / marquee.
 *
 * This is a *reference* implementation — the first vertical slice proving the
 * engine works end to end. It gives the existing `selection` tool real
 * behaviour without changing its declaration:
 *
 *   - click an object            → select it (hit testing → selection)
 *   - shift-click                → add/remove from the selection
 *   - drag an object             → move the whole selection (one undo step,
 *                                  coalesced live via the command stack)
 *   - drag empty space           → rubber-band marquee, selects on release
 *   - Delete / Backspace         → remove the selection (undoable)
 *
 * Every visible effect (handles, rubber-band, live move) flows through the same
 * systems every future tool will use: hit test, selection, commands, renderer
 * preview and dirty regions. Nothing here is bespoke to shapes.
 */

import { rectFromPoints } from '../geometry.js';
import { composite } from '../commands.js';

const DELETE_KEYS = new Set(['Delete', 'Backspace']);

export const selectToolPlugin = {
  name: 'builtin:select',

  interactions: {
    selection: {
      onPointerDown(api) {
        const { hitTest, selection, pageIndex, point, event } = api;
        const hit = hitTest.objectAt(pageIndex, point);

        if (hit) {
          if (event.shiftKey) selection.toggle(hit.id, pageIndex);
          else if (!selection.has(hit.id)) selection.selectOne(hit.id, pageIndex);
          // Begin a move drag over the current selection.
          api.session.drag = beginMove(api);
          return;
        }

        if (!event.shiftKey) selection.clear();
        api.session.drag = { kind: 'marquee', origin: point, pageIndex, additive: event.shiftKey };
      },

      onPointerMove(api) {
        const drag = api.session.drag;
        if (!drag) return;
        if (drag.kind === 'move') updateMove(api, drag);
        else if (drag.kind === 'marquee') updateMarquee(api, drag);
      },

      onPointerUp(api) {
        const drag = api.session.drag;
        if (!drag) return;
        if (drag.kind === 'move') commitMove(api, drag);
        else if (drag.kind === 'marquee') commitMarquee(api, drag);
      },

      onKeyDown({ event, engine, selection, stack }) {
        if (!DELETE_KEYS.has(event.key) || selection.isEmpty()) return;
        event.preventDefault();
        const page = selection.pageIndex;
        const cmds = selection.list().map((id) => engine.commands.removeObject(page, id));
        stack.execute(composite('Delete', cmds));
        selection.clear();
      },
    },
  },
};

/* ------------------------------- move -------------------------------- */
function beginMove(api) {
  const { document, selection, point } = api;
  const page = selection.pageIndex;
  // Snapshot the start position of everything we're about to move.
  const origins = selection.list().map((id) => {
    const o = document.getObject(page, id);
    return { id, x: o.x, y: o.y };
  });
  return { kind: 'move', page, start: point, origins, moved: false };
}

function updateMove(api, drag) {
  const { document, renderer } = api;
  const dx = api.point.x - drag.start.x;
  const dy = api.point.y - drag.start.y;
  if (dx || dy) drag.moved = true;
  // Live, history-free feedback: mutate positions directly; commit on release.
  for (const o of drag.origins) {
    document.updateObject(drag.page, o.id, { x: o.x + dx, y: o.y + dy });
  }
  // Repaint the page overlay so selection handles track the moving objects.
  renderer.markDirty(drag.page, null);
}

function commitMove(api, drag) {
  if (!drag.moved) return;
  const dx = api.point.x - drag.start.x;
  const dy = api.point.y - drag.start.y;
  // Objects already sit at their final spot; record ONE reversible step.
  const cmds = drag.origins.map((o) => explicitMove(api, drag.page, o.id, o, { x: o.x + dx, y: o.y + dy }));
  api.execute(composite('Move', cmds));
}

/** A move command with explicit before/after (positions are pre-applied live). */
function explicitMove(api, pageIndex, id, from, to) {
  const { document } = api;
  return {
    label: 'Move',
    redo: () => document.updateObject(pageIndex, id, { x: to.x, y: to.y }),
    undo: () => document.updateObject(pageIndex, id, { x: from.x, y: from.y }),
  };
}

/* ------------------------------ marquee ------------------------------ */
function updateMarquee(api, drag) {
  const box = rectFromPoints(drag.origin, api.point);
  api.renderer.setPreview(drag.pageIndex, {
    bounds: box,
    paint: (ctx) => {
      ctx.fillStyle = 'rgba(99,102,241,0.10)';
      ctx.strokeStyle = '#6366f1';
      ctx.lineWidth = 1;
      ctx.fillRect(box.x, box.y, box.width, box.height);
      ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.width, box.height);
    },
  });
  drag.box = box;
}

function commitMarquee(api, drag) {
  api.renderer.setPreview(drag.pageIndex, null);
  if (!drag.box || drag.box.width < 2 || drag.box.height < 2) return;
  const hits = api.hitTest.objectsIn(drag.pageIndex, drag.box).map((o) => o.id);
  if (drag.additive) hits.forEach((id) => api.selection.add(id, drag.pageIndex));
  else api.selection.set(hits, drag.pageIndex);
}
