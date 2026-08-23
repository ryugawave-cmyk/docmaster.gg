/**
 * createEngine — assembles the document editing engine.
 *
 * This is the single object every tool shares. It wires the subsystems together
 * in dependency order and exposes them behind one facade, plus the few
 * integration helpers the workspace UI needs (mounting page overlays, adapting
 * to the existing undo/redo controls).
 *
 * Subsystems and what they own:
 *   objectModel  — extensible registry of object *types* (draw/hit/bounds)
 *   layers       — ordered render layers
 *   document     — live, indexed, event-emitting view over the plain doc
 *   commands     — reversible edit factories bound to the document
 *   stack        — undo/redo with transactions + coalescing (a `history`)
 *   selection    — observable selection set
 *   hitTest      — point/rect → object(s), topmost-first
 *   renderer     — incremental, layered overlay paint pipeline
 *   viewport     — page virtualization for large docs (attached on mount)
 *   tools        — pointer→tool interaction bridge
 *   plugins      — install features without touching core
 *
 * The engine is created once at boot and lives for the session; `load(doc)`
 * swaps the active document, reusing all the machinery.
 */

import { createObjectModel, registerCoreTypes } from './objectModel.js';
import { createLayerStack } from './layers.js';
import { createEngineDocument } from './document.js';
import { createCommands } from './commands.js';
import { createCommandStack } from './commandStack.js';
import { createSelection } from './selection.js';
import { createHitTester } from './hitTest.js';
import { createRenderer } from './renderer.js';
import { createViewport } from './viewport.js';
import { createToolController } from './toolController.js';
import { createPluginHost } from './plugins.js';

/**
 * @param {{ store: object, toolRegistry?: object }} deps
 *   store        — the workspace observable store (for canUndo/canRedo sync)
 *   toolRegistry — the existing tool registry (so plugins can add tools)
 */
export function createEngine({ store, toolRegistry } = {}) {
  const objectModel = createObjectModel();
  const layers = createLayerStack();
  registerCoreTypes(objectModel);

  const document = createEngineDocument({ model: objectModel });
  const commands = createCommands(document);
  const stack = createCommandStack(store);
  const selection = createSelection({ document });
  const hitTest = createHitTester({ document, model: objectModel, layers });
  const renderer = createRenderer({ document, model: objectModel, layers, selection });

  // Interaction handlers live here so re-binding the controller to a new stage
  // element (after the canvas rebuilds) never loses plugin behaviour.
  const interactions = new Map();

  const engine = {
    objectModel,
    layers,
    document,
    commands,
    stack,
    selection,
    hitTest,
    renderer,
    toolRegistry,
    viewport: null,
    tools: null,
    plugins: null,
    // A predicate the canvas sets so the tool controller stands down while the
    // user is panning (space-drag / hand tool) — keeps the two input paths from
    // fighting over the same gesture.
    panGuard: null,
  };

  /** Let the canvas tell the engine when a gesture belongs to panning. */
  function setPanGuard(fn) {
    engine.panGuard = fn;
  }

  engine.tools = createToolController({ store, registry: toolRegistry, engine, stageEl: null, interactions });
  engine.plugins = createPluginHost(engine);

  /** Swap the active document and reset transient state. */
  function load(doc) {
    document.load(doc);
    selection.clear();
    stack.clear();
    renderer.resetPages();
  }

  /**
   * Bind the engine to the live DOM once the workspace has built its canvas.
   * Rebuilds the tool controller against the real stage element and starts the
   * viewport virtualizer. Safe to call again after the stage is rebuilt.
   */
  function attach({ scrollEl, stageEl }) {
    engine.tools = createToolController({ store, registry: toolRegistry, engine, stageEl, interactions });
    engine.viewport = createViewport({ scrollEl, stageEl, renderer });
    return engine;
  }

  /**
   * Adapter so the existing toolbar/keyboard undo-redo wiring can drive the
   * engine's command stack unchanged. Also lets tools push legacy
   * `{ label, redo, undo }` commands.
   */
  function asHistory() {
    return {
      execute: (cmd) => stack.execute(cmd),
      undo: () => stack.undo(),
      redo: () => stack.redo(),
      clear: () => stack.clear(),
    };
  }

  return Object.assign(engine, { load, attach, asHistory, setPanGuard });
}
