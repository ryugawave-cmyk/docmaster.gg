/**
 * Centralized keyboard input manager — the single source of truth for global
 * key handling across the whole app.
 *
 * WHY THIS EXISTS
 * ---------------
 * Keyboard bugs (Space not typing, keys stolen by workspace shortcuts) came from
 * *scattered* `window.addEventListener('keydown', …)` handlers that each had to
 * re-implement "is the user typing?" and each could `preventDefault()` a key the
 * text editor needed. This module replaces that with one arbitration point:
 *
 *   1. Exactly ONE global keydown/keyup listener (installed once, capture phase),
 *      so the manager decides before any element handler runs.
 *   2. A single, robust definition of "a text editor is active" (contentEditable,
 *      <input>, <textarea>, <select>, an explicit editing session, or IME
 *      composition).
 *   3. A hard rule: **while a text editor is active, every global shortcut is
 *      suspended and the keystroke flows untouched to the editor** — no global
 *      handler may `preventDefault()`/`stopPropagation()` it. This guarantees
 *      native behavior for Space, Enter, Backspace, Delete, Arrows, Home/End,
 *      PageUp/Down, Tab, Ctrl/Cmd+A/C/V/X/Z/Y, Shift-selection and IME/Unicode
 *      composition. Editors keep their OWN element-scoped handlers for the few
 *      keys they intentionally own (e.g. Enter, Ctrl+Z).
 *   4. Workspace shortcuts (pan, zoom, delete-object, tool switching, …) register
 *      here and are automatically restored the moment editing ends.
 *
 * Global input is inherently a singleton (one keyboard, one window), so this is a
 * module singleton. Call `keyboard.install()` once at boot.
 */

const EDITABLE_TAGS = /^(INPUT|TEXTAREA|SELECT)$/;

/** True for any node that natively captures typing (or a descendant of one). */
function isEditableElement(node) {
  if (!node) return false;
  // `isContentEditable` is inherited: it is also true for elements nested inside
  // a contentEditable region (styled spans, the caret's parent, …).
  if (node.isContentEditable === true) return true;
  return EDITABLE_TAGS.test(node.tagName);
}

const state = {
  installed: false,
  composing: false, // inside an IME composition (compositionstart→end)
  sessions: new Set(), // explicit editing sessions opened by editors
  bindings: [], // registered global shortcuts (in registration order)
};

/**
 * Is a text editor currently entitled to own the keyboard? True when an editor
 * has opened an editing session, when the focused element is natively editable,
 * when the event targets an editable node, or during IME composition.
 */
function isTextEditingActive(e) {
  if (state.composing) return true;
  if (e && e.isComposing) return true;
  if (state.sessions.size > 0) return true;
  if (isEditableElement(document.activeElement)) return true;
  if (e && isEditableElement(e.target)) return true;
  return false;
}

function onKeyDown(e) {
  // IME still assembling a character: never interfere (keyCode 229 is the
  // universal "composition in progress" sentinel across browsers).
  if (e.keyCode === 229) return;
  // A text editor owns the keystroke → suspend ALL global shortcuts and let the
  // event reach the editor untouched. This is the core guarantee.
  if (isTextEditingActive(e)) return;

  for (const b of state.bindings) {
    if (b.onKeyDown && b.match(e) && b.onKeyDown(e) === true) break;
  }
}

function onKeyUp(e) {
  // Key-up handlers always run — even if editing began between keydown and keyup
  // — so transient modes (e.g. hold-Space-to-pan) can never get stuck "on".
  for (const b of state.bindings) {
    if (b.onKeyUp && b.match(e)) b.onKeyUp(e);
  }
}

function onCompositionStart() {
  state.composing = true;
}
function onCompositionEnd() {
  state.composing = false;
}

export const keyboard = {
  /** Install the single global listener set. Idempotent. */
  install() {
    if (state.installed) return;
    state.installed = true;
    // Capture phase: the manager arbitrates before element-scoped handlers. It
    // never blocks the editor (it bails out first when editing), so capturing is
    // safe and lets global shortcuts win only when nothing is being typed.
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('compositionstart', onCompositionStart, true);
    window.addEventListener('compositionend', onCompositionEnd, true);
  },

  /** Whether a text editor currently owns the keyboard. */
  isEditing: () => isTextEditingActive(),

  /**
   * A text editor calls this when it becomes active (edit mode on / focused).
   * While any session is open, every global shortcut is suspended. Returns a
   * function that ends the session; editors MUST call it on setEditable(false)
   * and on destroy so workspace shortcuts are restored.
   */
  beginEditing() {
    const token = Symbol('editing');
    state.sessions.add(token);
    return function endEditing() {
      state.sessions.delete(token);
    };
  },

  /**
   * Register a global shortcut. A binding is:
   *   { match(e) → bool, onKeyDown?(e) → bool, onKeyUp?(e) → void }
   * `match` decides whether the binding applies to an event. `onKeyDown` returns
   * `true` to stop later bindings from also handling the same keydown. Returns an
   * unregister function.
   */
  register(binding) {
    state.bindings.push(binding);
    return function unregister() {
      const i = state.bindings.indexOf(binding);
      if (i >= 0) state.bindings.splice(i, 1);
    };
  },
};

export { isEditableElement };
