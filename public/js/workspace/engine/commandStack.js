/**
 * CommandStack — undo/redo with transactions and coalescing.
 *
 * This is a superset of the workspace's original `history` module: it runs the
 * same `{ label, redo, undo }` commands and keeps the store's `canUndo/canRedo`
 * flags in sync, so it can drop straight into the existing toolbar/keyboard
 * wiring. On top of that it adds the two things real editing needs:
 *
 *   - **Transactions** — group many primitive edits into one undo step, so
 *     "drag 12 selected objects" or "apply a template" is a single Ctrl+Z.
 *   - **Coalescing** — successive commands sharing a `coalesceKey` within a
 *     short window fold into the top command via its `mergeWith`. A continuous
 *     drag or a burst of keystrokes becomes one history entry instead of
 *     hundreds, which keeps memory bounded and undo intuitive.
 *
 * The stack holds only closures + small snapshots, never rendered bitmaps, so
 * deep history stays cheap even on large documents.
 */

export function createCommandStack(store, { limit = 200, coalesceMs = 350 } = {}) {
  /** @type {object[]} */
  const undoStack = [];
  /** @type {object[]} */
  const redoStack = [];

  let transaction = null; // active transaction accumulator
  let lastAt = 0; // timestamp of the last pushed command (for coalescing)
  const subscribers = new Set();

  function sync() {
    store?.setState?.({ canUndo: canUndo(), canRedo: canRedo() });
    subscribers.forEach((fn) => fn());
  }
  function onChange(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  /**
   * Execute a command and record it. If a transaction is open, the command runs
   * now but is buffered and only committed as one unit later.
   */
  function execute(command) {
    command.redo();
    if (transaction) {
      transaction.commands.push(command);
      return command;
    }
    record(command);
    return command;
  }

  function record(command) {
    const now = Date.now();
    const top = undoStack[undoStack.length - 1];
    const canCoalesce =
      top &&
      command.coalesceKey &&
      top.coalesceKey === command.coalesceKey &&
      now - lastAt <= coalesceMs &&
      typeof top.mergeWith === 'function';

    if (canCoalesce && top.mergeWith(command)) {
      // Merged into the existing entry — the redo already applied the new state.
      lastAt = now;
    } else {
      undoStack.push(command);
      if (undoStack.length > limit) undoStack.shift();
      lastAt = now;
    }
    redoStack.length = 0;
    sync();
  }

  /* --------------------------- transactions ---------------------------- */
  /**
   * Begin a transaction. Returns a handle; every `execute` until `commit()`
   * buffers into it. `abort()` rolls back whatever ran so far.
   */
  function begin(label = 'Edit') {
    if (transaction) return transaction; // nested → join the outer one
    transaction = { label, commands: [] };
    return {
      commit: () => commit(),
      abort: () => abort(),
      get size() {
        return transaction ? transaction.commands.length : 0;
      },
    };
  }

  function commit() {
    if (!transaction) return;
    const { label, commands } = transaction;
    transaction = null;
    if (!commands.length) return;
    if (commands.length === 1) {
      record(commands[0]);
      return;
    }
    record({
      label,
      redo: () => commands.forEach((c) => c.redo()),
      undo: () => {
        for (let i = commands.length - 1; i >= 0; i -= 1) commands[i].undo();
      },
    });
  }

  function abort() {
    if (!transaction) return;
    const { commands } = transaction;
    transaction = null;
    for (let i = commands.length - 1; i >= 0; i -= 1) commands[i].undo();
    sync();
  }

  /** Convenience: run `fn` inside a transaction, auto-commit (or abort on throw). */
  function run(label, fn) {
    const tx = begin(label);
    try {
      const result = fn();
      tx.commit();
      return result;
    } catch (err) {
      tx.abort();
      throw err;
    }
  }

  /* ------------------------------ undo/redo ---------------------------- */
  function undo() {
    if (transaction) commit();
    const command = undoStack.pop();
    if (!command) return;
    command.undo();
    redoStack.push(command);
    lastAt = 0; // a new edit after undo must not coalesce with the popped one
    sync();
  }

  function redo() {
    const command = redoStack.pop();
    if (!command) return;
    command.redo();
    undoStack.push(command);
    lastAt = 0;
    sync();
  }

  function clear() {
    undoStack.length = 0;
    redoStack.length = 0;
    transaction = null;
    lastAt = 0;
    sync();
  }

  const canUndo = () => undoStack.length > 0;
  const canRedo = () => redoStack.length > 0;

  return {
    execute,
    undo,
    redo,
    clear,
    begin,
    run,
    onChange,
    canUndo,
    canRedo,
    get labels() {
      return { undo: undoStack[undoStack.length - 1]?.label, redo: redoStack[redoStack.length - 1]?.label };
    },
  };
}
