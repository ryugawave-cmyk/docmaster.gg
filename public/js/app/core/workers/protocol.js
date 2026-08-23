/**
 * Worker message protocol — one small contract shared by the main thread and
 * every worker (all workers are ES modules, so they import this file directly).
 *
 * Wire shape:
 *   request : { id, kind, payload }
 *   response: { id, result }  |  { id, error }
 *
 * The main thread wraps a worker with `connectWorker()` and calls `.call(kind,
 * payload, transfer)` → Promise. The worker side calls `serveWorker(handlers)`.
 * Big binary results are moved (not copied) via `withTransfer(value, [buffers])`.
 *
 * Everything here is DOM-free and dependency-free so the routing logic is unit
 * testable in Node with a fake worker.
 */

/** Tracks in-flight requests by id and settles them when a response arrives. */
export function createPendingRegistry() {
  let seq = 0;
  const pending = new Map();
  return {
    next() { return `t${++seq}`; },
    track(id, resolve, reject) { pending.set(id, { resolve, reject }); },
    /** @returns {boolean} true if the message matched a pending request */
    settle(msg) {
      if (!msg || msg.id == null) return false;
      const p = pending.get(msg.id);
      if (!p) return false;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return true;
    },
    rejectAll(err) {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    },
    get size() { return pending.size; },
  };
}

/**
 * Main-thread wrapper around one Worker-like endpoint (anything with
 * `postMessage`, `onmessage`, and optionally `onerror`/`terminate`).
 */
export function connectWorker(worker) {
  const reg = createPendingRegistry();
  worker.onmessage = (e) => reg.settle(e.data);
  worker.onerror = (e) => reg.rejectAll(new Error('worker error: ' + (e && e.message ? e.message : 'unknown')));
  worker.onmessageerror = () => reg.rejectAll(new Error('worker message deserialization error'));
  return {
    call(kind, payload, transfer = []) {
      const id = reg.next();
      return new Promise((resolve, reject) => {
        reg.track(id, resolve, reject);
        worker.postMessage({ id, kind, payload }, transfer);
      });
    },
    get inFlight() { return reg.size; },
    terminate() {
      reg.rejectAll(new Error('worker terminated'));
      if (worker.terminate) worker.terminate();
    },
  };
}

/** Marks a handler return value for zero-copy transfer of its backing buffers. */
export const withTransfer = (value, transfer) => ({ __transfer: true, value, transfer });

/**
 * Worker-side: install a message handler that dispatches by `kind`.
 * @param {Record<string, (payload:any, raw:any)=>any|Promise<any>>} handlers
 * @param {object} [scope] defaults to the worker global `self`
 */
export function serveWorker(handlers, scope = (typeof self !== 'undefined' ? self : undefined)) {
  scope.onmessage = async (e) => {
    const { id, kind, payload } = e.data || {};
    const handler = handlers[kind];
    if (!handler) { scope.postMessage({ id, error: `unknown kind: ${kind}` }); return; }
    try {
      const out = await handler(payload, e.data);
      if (out && out.__transfer) scope.postMessage({ id, result: out.value }, out.transfer || []);
      else scope.postMessage({ id, result: out });
    } catch (err) {
      scope.postMessage({ id, error: String(err && err.message ? err.message : err) });
    }
  };
}
