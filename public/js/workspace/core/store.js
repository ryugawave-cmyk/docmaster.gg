/**
 * Minimal observable state container.
 *
 * A single store holds all workspace state. Components subscribe and receive
 * `(state, prevState)` on every change so they can update only what they own.
 * This keeps the UI decoupled from tools and makes new features easy to plug in.
 */
export function createStore(initialState = {}) {
  let state = { ...initialState };
  const listeners = new Set();

  function getState() {
    return state;
  }

  /**
   * Merge a patch (object or updater fn) into state and notify subscribers.
   * @param {object|function} patch
   */
  function setState(patch) {
    const partial = typeof patch === 'function' ? patch(state) : patch;
    if (!partial) return;
    const prev = state;
    state = { ...state, ...partial };
    listeners.forEach((fn) => fn(state, prev));
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   * @param {(state:object, prev:object)=>void} fn
   */
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { getState, setState, subscribe };
}
