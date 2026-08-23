/**
 * Project save/load — pack a DocumentModel + its binary assets into a single
 * `.dmz` file (a DEFLATE ZIP), and read it back. This is what "keep documents in
 * browser memory" persists to when the user saves, and what OPFS autosave writes
 * (see ./opfs.js). Everything is local — the bytes never touch the server.
 *
 * Archive layout:
 *   document.json   — the serialized model (pages, layer nodes, meta)
 *   manifest.json   — { v, assets:[{ id, kind, name }] }
 *   assets/<id>     — raw bytes for each referenced asset (raster/image)
 *
 * Assets are referenced from the model by id (page.rasterRef, node.assetId), so
 * they are restored under their ORIGINAL ids and the references stay valid.
 */
import { DocumentModel } from './document.js';
import { createAssetStore } from './assets.js';
import { zipAsync, unzip } from '../zip/archive.js';

const encText = (s) => new TextEncoder().encode(s);

/** All asset ids the model references (dedup): page rasters + node assetIds. */
function collectAssetIds(model) {
  const ids = new Set();
  for (const p of model.pages) {
    if (p.rasterRef) ids.add(p.rasterRef);
    for (const n of p.layers) if (n.assetId) ids.add(n.assetId);
  }
  return [...ids];
}

/** Coerce a stored asset value to bytes for packing. `encodeBitmap` (browser)
 *  turns an ImageBitmap into PNG bytes; without it, bitmaps are skipped. */
async function assetToBytes(value, kind, encodeBitmap) {
  if (value == null) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return encText(value);
  if (typeof Blob !== 'undefined' && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) {
    return encodeBitmap ? await encodeBitmap(value) : null;
  }
  return null;
}

/**
 * @param {DocumentModel} model
 * @param {ReturnType<import('./assets.js').createAssetStore>} assetStore
 * @param {{ encodeBitmap?:(bmp:ImageBitmap)=>Promise<Uint8Array> }} [opts]
 * @returns {Promise<Uint8Array>} the .dmz bytes
 */
export async function packProject(model, assetStore, opts = {}) {
  const entries = [{ name: 'document.json', data: JSON.stringify(model.serialize()) }];
  const manifest = [];

  if (assetStore) {
    for (const id of collectAssetIds(model)) {
      if (!assetStore.has(id)) continue;
      const kind = assetStore.kindOf(id);
      const bytes = await assetToBytes(assetStore.get(id), kind, opts.encodeBitmap);
      if (!bytes) continue;
      const name = `assets/${id}`;
      entries.push({ name, data: bytes });
      manifest.push({ id, kind, name });
    }
  }

  entries.push({ name: 'manifest.json', data: JSON.stringify({ v: 1, assets: manifest }) });
  return zipAsync(entries);
}

/**
 * Read a `.dmz` back into a DocumentModel + a fresh asset store (assets restored
 * under their original ids).
 * @param {Uint8Array} bytes
 * @returns {Promise<{ model: DocumentModel, assets: ReturnType<typeof createAssetStore> }>}
 */
export async function unpackProject(bytes) {
  const files = await unzip(bytes);
  const byName = new Map(files.map((f) => [f.name, f.data]));

  const docBytes = byName.get('document.json');
  if (!docBytes) throw new Error('invalid project: document.json missing');
  const model = DocumentModel.deserialize(JSON.parse(new TextDecoder().decode(docBytes)));

  const assets = createAssetStore();
  const manRaw = byName.get('manifest.json');
  if (manRaw) {
    const manifest = JSON.parse(new TextDecoder().decode(manRaw));
    for (const a of (manifest.assets || [])) {
      const data = byName.get(a.name);
      if (data) assets.put(data, { kind: a.kind || 'bytes', id: a.id });
    }
  }
  return { model, assets };
}
