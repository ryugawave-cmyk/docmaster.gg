/**
 * Tiny synchronous pub/sub bus.
 *
 * The bus is the ONLY channel the shell and the workspaces use to talk to each
 * other. Nothing imports a workspace directly from the shell (or vice-versa),
 * so PDF and Document logic stay fully decoupled — they only agree on event
 * names and payload shapes. See ARCHITECTURE.md for the event catalogue.
 */
export function createEventBus() {
  const channels = new Map();

  /** Subscribe to `event`. Returns an unsubscribe function. */
  function on(event, handler) {
    if (!channels.has(event)) channels.set(event, new Set());
    channels.get(event).add(handler);
    return () => channels.get(event)?.delete(handler);
  }

  /** Subscribe once. */
  function once(event, handler) {
    const off = on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  /** Emit `event` with an optional payload. */
  function emit(event, payload) {
    channels.get(event)?.forEach((handler) => {
      try {
        handler(payload);
      } catch (err) {
        // A misbehaving listener must never break the emitter or its siblings.
        console.error(`[eventBus] listener for "${event}" threw`, err);
      }
    });
  }

  return { on, once, emit };
}
