/**
 * Worker pool — spreads tasks across N workers, dispatching each task to the
 * least-busy worker (round-robin among ties). Keeps the main thread free: every
 * heavy op (render, OCR, image kernels, export encoding) goes through here.
 *
 * `spawn` is injectable so the dispatch logic is unit-testable in Node with fake
 * workers; in the browser it defaults to `new Worker(url, { type:'module' })`.
 */
import { connectWorker } from './protocol.js';

/**
 * @param {{ url?:string, size?:number, type?:string,
 *   spawn?:(index:number)=>object }} opts
 */
export function createWorkerPool(opts = {}) {
  const size = Math.max(1, opts.size || (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2);
  const type = opts.type || 'module';
  const spawn = opts.spawn || ((/* i */) => new Worker(opts.url, { type }));

  const clients = [];
  for (let i = 0; i < size; i += 1) clients.push(connectWorker(spawn(i)));
  let rr = 0;

  function pick() {
    let min = Infinity;
    for (const c of clients) if (c.inFlight < min) min = c.inFlight;
    // Among the least-busy workers, round-robin for fairness.
    const candidates = clients.filter((c) => c.inFlight === min);
    return candidates[rr++ % candidates.length];
  }

  return {
    call(kind, payload, transfer = []) {
      return pick().call(kind, payload, transfer);
    },
    /** Broadcast to every worker (e.g. warm a model into each). */
    broadcast(kind, payload) {
      return Promise.all(clients.map((c) => c.call(kind, payload)));
    },
    get size() { return clients.length; },
    get inFlight() { return clients.reduce((n, c) => n + c.inFlight, 0); },
    terminate() { clients.forEach((c) => c.terminate()); },
  };
}

/** A single dedicated worker (e.g. the PDF or OCR worker) as a pool-shaped API. */
export function createWorker(opts = {}) {
  return createWorkerPool({ ...opts, size: 1 });
}
