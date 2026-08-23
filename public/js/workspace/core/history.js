/**
 * Command-based undo/redo manager.
 *
 * Editing features push a command `{ label, redo(), undo() }`. Running a new
 * command clears the redo stack. The store's `canUndo` / `canRedo` flags are
 * kept in sync so the toolbar buttons reflect availability automatically.
 *
 * This is the single mechanism every future editing tool will use to make its
 * changes reversible — tools never manipulate history state directly.
 */
export function createHistory(store, { limit = 100 } = {}) {
  const undoStack = [];
  const redoStack = [];

  function sync() {
    store.setState({
      canUndo: undoStack.length > 0,
      canRedo: redoStack.length > 0,
    });
  }

  /**
   * Execute a command and record it for undo.
   * @param {{label?:string, redo:Function, undo:Function}} command
   */
  function execute(command) {
    command.redo();
    undoStack.push(command);
    if (undoStack.length > limit) undoStack.shift();
    redoStack.length = 0;
    sync();
  }

  function undo() {
    const command = undoStack.pop();
    if (!command) return;
    command.undo();
    redoStack.push(command);
    sync();
  }

  function redo() {
    const command = redoStack.pop();
    if (!command) return;
    command.redo();
    undoStack.push(command);
    sync();
  }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
    sync();
  }

  return { execute, undo, redo, clear };
}
