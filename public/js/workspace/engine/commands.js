/**
 * Command factories — the reversible edit vocabulary.
 *
 * Every mutation a tool wants to make is expressed as a *command*: an object
 * with `redo()` and `undo()` that drive the EngineDocument primitives. Tools
 * never call `document.addObject(...)` directly; they build a command and hand
 * it to the CommandStack. That guarantees three things at once:
 *
 *   1. every edit is undoable/redoable,
 *   2. the spatial index and renderer stay in sync (primitives emit dirty rects),
 *   3. edits can be *composed* (a transaction) and *coalesced* (a drag) without
 *      each tool reinventing that logic.
 *
 * A command is compatible with the pre-existing history contract
 * (`{ label, redo, undo }`), so the CommandStack can also run legacy commands.
 * The extras below (`coalesceKey`, `mergeWith`) are optional.
 *
 * Command shape:
 *   {
 *     label,                    // for menus / history UI
 *     redo(), undo(),           // the reversible pair
 *     coalesceKey?,             // drags/typing with the same key merge into one
 *     mergeWith?(next) -> bool  // fold `next` into `this`; return true if merged
 *   }
 */

import { unionRect } from './geometry.js';

/** Deep-ish clone of an object's mutable parts, for snapshot-based undo. */
function snapshot(obj) {
  return { ...obj, data: cloneData(obj.data) };
}
function cloneData(data) {
  if (Array.isArray(data)) return data.map(cloneData);
  if (data && typeof data === 'object') {
    const out = {};
    for (const k of Object.keys(data)) out[k] = cloneData(data[k]);
    return out;
  }
  return data;
}

/**
 * Build the standard set of commands bound to one EngineDocument. Returned as a
 * factory object so tools/plugins get a small, discoverable edit API.
 */
export function createCommands(document) {
  /** Add a fully-built object to a page. */
  function addObject(pageIndex, object, { label = 'Add object', at } = {}) {
    return {
      label,
      redo: () => document.addObject(pageIndex, object, at),
      undo: () => document.removeObject(pageIndex, object.id),
    };
  }

  /** Remove an object, remembering its slot so redo/undo restore z-order. */
  function removeObject(pageIndex, id, { label = 'Delete' } = {}) {
    let removed = null;
    let at = 0;
    return {
      label,
      redo: () => {
        at = document.objects(pageIndex).findIndex((o) => o.id === id);
        removed = document.removeObject(pageIndex, id);
      },
      undo: () => removed && document.addObject(pageIndex, removed, at),
    };
  }

  /**
   * Update an object. Captures a before-snapshot lazily on first run so undo
   * restores the exact prior state (including nested `data`). Same-object update
   * commands coalesce, so a live drag/resize collapses to a single history step.
   */
  function updateObject(pageIndex, id, patch, { label = 'Edit', coalesce = false } = {}) {
    let before = null;
    let applied = patch;
    const cmd = {
      label,
      coalesceKey: coalesce ? `update:${pageIndex}:${id}` : undefined,
      redo: () => {
        const obj = document.getObject(pageIndex, id);
        if (obj && !before) before = snapshot(obj);
        document.updateObject(pageIndex, id, applied);
      },
      undo: () => before && document.updateObject(pageIndex, id, snapshot(before)),
      mergeWith: (next) => {
        // Fold a subsequent update of the same object into this one: keep our
        // original `before`, adopt the newest patch as the target state.
        applied = { ...applied, ...next._patch, data: { ...applied.data, ...next._patch?.data } };
        return true;
      },
      _patch: patch,
    };
    return cmd;
  }

  /** Change z-order (raise/lower/to-front/to-back handled by index math). */
  function reorderObject(pageIndex, id, toIndex, { label = 'Reorder' } = {}) {
    let fromIndex = null;
    return {
      label,
      redo: () => {
        fromIndex = document.reorderObject(pageIndex, id, toIndex);
      },
      undo: () => fromIndex != null && document.reorderObject(pageIndex, id, fromIndex),
    };
  }

  /* ----------------------------- page ops ------------------------------ */
  function insertPage(atIndex, pageObj, { label = 'Insert page' } = {}) {
    return {
      label,
      redo: () => document.insertPage(atIndex, pageObj),
      undo: () => document.removePage(atIndex),
    };
  }
  function removePage(atIndex, { label = 'Delete page' } = {}) {
    let removed = null;
    return {
      label,
      redo: () => {
        removed = document.removePage(atIndex);
      },
      undo: () => removed && document.insertPage(atIndex, removed),
    };
  }
  function movePage(from, to, { label = 'Move page' } = {}) {
    return {
      label,
      redo: () => document.movePage(from, to),
      undo: () => document.movePage(to, from),
    };
  }
  function rotatePage(atIndex, delta, { label = 'Rotate page' } = {}) {
    return {
      label,
      redo: () => document.rotatePage(atIndex, delta),
      undo: () => document.rotatePage(atIndex, -delta),
    };
  }

  return {
    addObject,
    removeObject,
    updateObject,
    reorderObject,
    insertPage,
    removePage,
    movePage,
    rotatePage,
  };
}

/**
 * Compose several commands into one undo unit (e.g. "paste 5 objects", or a
 * transaction). Redo runs them forward; undo runs them in reverse.
 */
export function composite(label, commands) {
  const list = commands.filter(Boolean);
  return {
    label,
    redo: () => list.forEach((c) => c.redo()),
    undo: () => {
      for (let i = list.length - 1; i >= 0; i -= 1) list[i].undo();
    },
    _commands: list,
  };
}

export { unionRect };
