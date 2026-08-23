/**
 * PluginHost — the extension mechanism for the whole editor.
 *
 * The core engine ships knowing nothing about specific features. Everything
 * beyond the primitives arrives as a **plugin**: a plain object that contributes
 * capabilities and is installed with `engine.plugins.use(plugin)`. This is how
 * the brief's future features (OCR, AI, forms, comments, signatures, real PDF
 * editing) attach *without modifying core code* — each is a self-contained
 * module that registers what it needs and wires itself up in `setup`.
 *
 * A plugin may contribute any subset of:
 *
 *   {
 *     name,                         // unique id (dedupes double-install)
 *     objectTypes: [ typeDef, … ],  // new document object types (object model)
 *     layers:      [ layerDef, … ], // new render layers
 *     tools:       [ toolDef,  … ], // new sidebar tools (tool registry)
 *     interactions:{ toolId: handlers }, // pointer/keyboard behaviour per tool
 *     setup(engine)                 // arbitrary wiring; may return a teardown fn
 *   }
 *
 * Registration order is contribution order: types/layers/tools are added before
 * `setup` runs, so a plugin's setup can rely on its own (and earlier plugins')
 * contributions already being present.
 */

export function createPluginHost(engine) {
  const installed = new Map(); // name → { plugin, teardown }

  function use(plugin) {
    if (!plugin || !plugin.name) throw new Error('Plugin needs a `name`');
    if (installed.has(plugin.name)) return engine; // idempotent install

    (plugin.objectTypes || []).forEach((t) => engine.objectModel.register(t));
    (plugin.layers || []).forEach((l) => engine.layers.define(l));
    (plugin.tools || []).forEach((t) => engine.toolRegistry?.register(t));
    if (plugin.interactions) {
      for (const [toolId, handlers] of Object.entries(plugin.interactions)) {
        engine.tools.setInteraction(toolId, handlers);
      }
    }

    const teardown = plugin.setup ? plugin.setup(engine) : null;
    installed.set(plugin.name, { plugin, teardown });
    return engine;
  }

  function useAll(plugins) {
    (plugins || []).forEach(use);
    return engine;
  }

  function has(name) {
    return installed.has(name);
  }

  function remove(name) {
    const entry = installed.get(name);
    if (entry?.teardown) entry.teardown();
    installed.delete(name);
  }

  return { use, useAll, has, remove, list: () => [...installed.keys()] };
}
