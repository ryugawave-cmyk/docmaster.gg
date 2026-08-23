# DocMaster Document Engine

The reusable foundation every editing tool builds on. It turns the workspace
from "a shell that shows pages" into a real document editor: an object model,
reversible edits, layered incremental rendering, selection, hit testing and a
plugin system — all dependency-free ES modules, designed to stay fast and
memory-light on very large documents.

> The engine is **additive**. It does not change the workspace UI, layout or
> chrome. It paints onto a transparent overlay canvas stacked over each page and
> exposes itself on the workspace `ctx` as `ctx.engine`.

---

## Mental model

A **document** is plain, serialisable data (pages, each with an `objects`
array). That stays the source of truth for save/export/undo. The engine wraps it
with the machinery interactive editing needs and never stores anything that
can't be reconstructed from that data.

Everything a user can place on a page is a flat object:

```js
{ id, type, layer, x, y, width, height, rotation, opacity, z, locked, hidden, data }
```

Its `type` (e.g. `shape`, `text`, `ink`, `comment`, `formField`) points at a
**type definition** in the object model that knows how to draw it, bound it and
hit-test it. Add a type → it instantly gains storage, indexing, rendering,
selection and undo/redo.

---

## Subsystems

| Module | Responsibility |
| --- | --- |
| `geometry.js` | Pure rect/point math: bounds, intersection, rotation, hit distance. |
| `objectModel.js` | Extensible registry of object **types** (draw / bounds / hitTest / layer) + core types. |
| `layers.js` | Ordered render layers (background → content → annotation → markup → selection → ui). |
| `spatialIndex.js` | Per-page uniform grid so region/point queries stay ~O(1) on crowded pages. |
| `document.js` | Live, indexed, event-emitting view over the plain doc; the only thing that mutates it. |
| `commands.js` | Reversible edit factories (add/remove/update/reorder objects, page ops) + `composite`. |
| `commandStack.js` | Undo/redo with **transactions** and **coalescing**; syncs `canUndo/canRedo`. |
| `selection.js` | Observable selection set (ids only); prunes itself when objects vanish. |
| `hitTest.js` | Point/rect → object(s), broad-phase (index) + narrow-phase (type), topmost-first. |
| `dirtyTracker.js` | Accumulates + merges damage rects; caps fragmentation with a full-repaint fallback. |
| `renderer.js` | Incremental layered paint of the overlay; **repaints only changed regions**. |
| `viewport.js` | Page virtualization: only visible pages keep a painted bitmap (low memory). |
| `toolController.js` | Maps pointer input → page-space → the active tool's interaction handlers. |
| `plugins.js` | Install features (object types, layers, tools, interactions) without touching core. |
| `index.js` | `createEngine()` — assembles it all and exposes the facade. |
| `builtins/` | Reference plugins (select/move/marquee, draw shapes) proving the stack end to end. |

---

## How the requirements map to the code

- **Reusable engine every tool shares** — `createEngine()` is built once at boot
  and handed to every tool via `ctx.engine` and the interaction API.
- **Command/action system with Undo/Redo** — `commands.js` + `commandStack.js`
  (transactions group edits; coalescing collapses a drag into one step).
- **Layer-based rendering** — `layers.js`; the renderer walks the stack so paint
  order is by layer, then z within a layer.
- **Selection system** — `selection.js` (single or multi, observable, self-pruning).
- **Hit testing** — `hitTest.js` two-phase, respecting layers and z-order.
- **Object model** — `objectModel.js` covers text, image, shape, ink, annotation,
  signature, comment and form field; all extensible.
- **Only-changed-region rendering** — `dirtyTracker.js` + `renderer.js`.
- **Plugin architecture** — `plugins.js`; new tools self-register.
- **Large documents / low memory** — lazy per-page indexing (`document.js`),
  the spatial grid (`spatialIndex.js`), and viewport virtualization
  (`viewport.js`) that releases off-screen page bitmaps.
- **Future features** (OCR, AI, forms, comments, signatures, page organization,
  real PDF editing) — each is a plugin contributing an object type + interaction;
  none require core changes.

---

## Writing a tool (the plugin pattern)

A plugin contributes any subset of object types, layers, tools and interactions,
plus a `setup(engine)`:

```js
export const stampPlugin = {
  name: 'stamp',
  objectTypes: [{
    type: 'stamp',
    layer: 'content',
    create: (p) => ({ width: 120, height: 48, data: { text: p.text ?? 'APPROVED' } }),
    draw: (g, obj) => { /* paint the stamp */ },
    // bounds/hitTest default to the object box
  }],
  interactions: {
    // wire the existing (or a new) tool id to pointer behaviour
    stamp: {
      onPointerDown(api) {
        const obj = api.createObject('stamp', { x: api.point.x, y: api.point.y });
        api.execute(api.commands.addObject(api.pageIndex, obj));
        api.selection.selectOne(obj.id, api.pageIndex);
      },
    },
  },
};

engine.plugins.use(stampPlugin);
```

The interaction API (`api`) each handler receives exposes `point`/`pageIndex`
(page-space), `settings` (the tool's live properties), the engine surfaces
(`model`, `document`, `selection`, `commands`, `hitTest`, `renderer`), a stable
per-gesture `session` object, and helpers `execute`, `transaction`,
`createObject`. See `builtins/selectTool.js` and `builtins/shapeTool.js` for
complete, working references.

---

## Coordinate space

Objects live in **page space**: top-left origin, page CSS pixels — the same
units the base page canvas uses. Zoom (CSS scale of the page wrapper) and device
pixel ratio are applied by the renderer/tool controller, never stored on
objects, so geometry is stable at any zoom.
