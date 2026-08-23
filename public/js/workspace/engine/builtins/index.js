/**
 * Built-in reference plugins.
 *
 * These ship with the engine to (a) prove the extension architecture works end
 * to end and (b) serve as the copy-paste template for every future tool. They
 * add behaviour to tools that already exist in the registry; they do not add or
 * restyle any UI. Install them with `engine.plugins.useAll(builtinPlugins)`.
 *
 * A new feature (OCR, forms, stamps, redaction, AI insert…) is just another
 * entry here or its own module: contribute an object type + an interaction and
 * it inherits selection, hit testing, layering, undo/redo and incremental
 * rendering for free.
 */

import { selectToolPlugin } from './selectTool.js';
import { shapeToolPlugin } from './shapeTool.js';

export const builtinPlugins = [selectToolPlugin, shapeToolPlugin];
