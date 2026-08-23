/**
 * OPFS project persistence — keeps documents in the browser, never the server.
 *
 * The Origin Private File System (`navigator.storage.getDirectory()`) is a
 * fast, origin-scoped, sandboxed filesystem. We use it for two things:
 *   • crash recovery / autosave of the active document, and
 *   • spilling large page rasters out of the JS heap so big PDFs don't OOM.
 *
 * Everything is feature-detected and guarded: on a browser without OPFS these
 * calls resolve to no-ops / null, and the app keeps the document purely in
 * memory. Projects are stored as opaque byte blobs (a `.dmz` = zipped
 * document.json + assets, produced by the serializer/export layer).
 */

const DIR = 'projects';

export function opfsAvailable() {
  return typeof navigator !== 'undefined' && !!(navigator.storage && navigator.storage.getDirectory);
}

async function projectsDir(create = false) {
  if (!opfsAvailable()) return null;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create });
}

/** Write bytes for a named project. Returns true on success, false if no OPFS. */
export async function saveProject(name, bytes) {
  const dir = await projectsDir(true);
  if (!dir) return false;
  const file = await dir.getFileHandle(safeName(name), { create: true });
  const w = await file.createWritable();
  await w.write(bytes);
  await w.close();
  return true;
}

/** Read a project's bytes, or null if missing / no OPFS. */
export async function loadProject(name) {
  const dir = await projectsDir(false).catch(() => null);
  if (!dir) return null;
  try {
    const file = await dir.getFileHandle(safeName(name));
    return new Uint8Array(await (await file.getFile()).arrayBuffer());
  } catch { return null; }
}

/** List stored project names. */
export async function listProjects() {
  const dir = await projectsDir(false).catch(() => null);
  if (!dir || !dir.values) return [];
  const out = [];
  for await (const entry of dir.values()) if (entry.kind === 'file') out.push(entry.name);
  return out;
}

export async function deleteProject(name) {
  const dir = await projectsDir(false).catch(() => null);
  if (!dir) return false;
  try { await dir.removeEntry(safeName(name)); return true; } catch { return false; }
}

/** Rough free/used quota, for surfacing "storage full" before it bites. */
export async function storageEstimate() {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) return null;
  return navigator.storage.estimate();
}

function safeName(name) {
  return String(name || 'untitled').replace(/[^a-z0-9._-]+/gi, '_').slice(0, 128) + (/\.[a-z0-9]+$/i.test(name) ? '' : '.dmz');
}
