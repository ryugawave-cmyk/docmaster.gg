/**
 * Asset store — binary handles (page rasters, image bitmaps) referenced by id
 * from the DocumentModel, kept OUT of the serializable model so undo/redo and
 * JSON stay cheap. Nodes/pages carry an `assetId`; this maps it to the live
 * `Blob` / `ImageBitmap` / `Uint8Array`.
 *
 * Dedup by content hash so the same logo imported on every page is stored once.
 * `release()` closes `ImageBitmap`s to free GPU/CPU memory when a doc is torn
 * down (a large multi-page PDF otherwise pins many bitmaps). Spilling cold
 * assets to OPFS (see ./opfs.js) is a later refinement; the interface is stable.
 */
import { uid } from './document.js';

export function createAssetStore() {
  const byId = new Map();        // id → { kind, value, refs }
  const byHash = new Map();      // hash → id (dedup)

  return {
    /**
     * Store an asset; returns its id. `hash` optional (enables dedup). `id`
     * optional — pass it to restore an asset under its original id when loading
     * a saved project (see ./project.js), so model references stay valid.
     */
    put(value, { kind = 'blob', hash = null, id = null } = {}) {
      if (id == null && hash != null && byHash.has(hash)) {
        const existing = byHash.get(hash);
        byId.get(existing).refs += 1;
        return existing;
      }
      const assetId = id || uid('as');
      byId.set(assetId, { kind, value, refs: 1 });
      if (hash != null) byHash.set(hash, assetId);
      return assetId;
    },

    get(id) { const e = byId.get(id); return e ? e.value : null; },
    kindOf(id) { const e = byId.get(id); return e ? e.kind : null; },
    has(id) { return byId.has(id); },

    /** Decrement refcount; free when it hits zero. */
    release(id) {
      const e = byId.get(id);
      if (!e) return;
      e.refs -= 1;
      if (e.refs > 0) return;
      if (e.value && typeof e.value.close === 'function') e.value.close(); // ImageBitmap
      byId.delete(id);
      for (const [h, v] of byHash) if (v === id) { byHash.delete(h); break; }
    },

    /** Free everything (document teardown). */
    clear() {
      for (const e of byId.values()) if (e.value && typeof e.value.close === 'function') e.value.close();
      byId.clear(); byHash.clear();
    },

    get size() { return byId.size; },
  };
}
