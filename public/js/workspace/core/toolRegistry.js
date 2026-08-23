/**
 * Tool registry — the extension point of the workspace.
 *
 * A tool is a plain definition object:
 *   {
 *     id, label, group, icon, cursor, shortcut,
 *     properties: [...control descriptors],
 *     onActivate(ctx), onDeactivate(ctx),   // optional lifecycle hooks
 *     // future: pointer/keyboard handlers for canvas interaction
 *   }
 *
 * Registering a tool makes it appear in the sidebar, respond to its shortcut,
 * set its cursor and render its properties panel — with zero UI changes.
 */
export function createToolRegistry() {
  const byId = new Map();
  const order = [];

  function register(tool) {
    if (!tool || !tool.id) throw new Error('Tool must have an id');
    if (byId.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
    byId.set(tool.id, tool);
    order.push(tool.id);
    return tool;
  }

  function registerAll(tools) {
    tools.forEach(register);
  }

  function get(id) {
    return byId.get(id);
  }

  function has(id) {
    return byId.has(id);
  }

  function all() {
    return order.map((id) => byId.get(id));
  }

  /**
   * Tools grouped by their `group`, preserving registration order.
   * @returns {Map<string, object[]>}
   */
  function groups() {
    const grouped = new Map();
    for (const tool of all()) {
      const key = tool.group || 'other';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(tool);
    }
    return grouped;
  }

  return { register, registerAll, get, has, all, groups };
}
