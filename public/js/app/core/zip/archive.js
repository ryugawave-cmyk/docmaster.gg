/**
 * Client-first ZIP archive — DEFLATE writer + reader.
 *
 * The existing services/zip.js writes STORED archives synchronously (used by the
 * OOXML exporters, left untouched). This module adds *compressed* archives for
 * the new client-first paths — project save/load (.dmz) and, later, worker-side
 * export encoding — using the browser/Node native `CompressionStream`
 * ('deflate-raw', ZIP method 8) with an automatic STORED fallback per entry
 * (tiny or incompressible data, or no CompressionStream). It also ships a reader
 * (`unzip`) so we can load what we save. Dependency-free; async because the
 * native streams are.
 *
 * @typedef {{ name:string, data:(Uint8Array|string) }} ZipEntry
 */

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(chunks) {
  let len = 0; for (const c of chunks) len += c.length;
  const out = new Uint8Array(len); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function pipe(bytes, transform) {
  const w = transform.writable.getWriter();
  w.write(bytes); w.close();
  const r = transform.readable.getReader();
  const chunks = [];
  for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value); }
  return concat(chunks);
}

export async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try { return await pipe(bytes, new CompressionStream('deflate-raw')); } catch { return null; }
}

export async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');
  return pipe(bytes, new DecompressionStream('deflate-raw'));
}

/**
 * Build a ZIP, DEFLATE-compressing each entry when it helps.
 * @param {ZipEntry[]} entries
 * @returns {Promise<Uint8Array>}
 */
export async function zipAsync(entries) {
  const files = [];
  for (const e of entries) {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    let method = 0; let comp = data;
    if (data.length >= 64) {
      const def = await deflateRaw(data);
      if (def && def.length < data.length) { method = 8; comp = def; }
    }
    files.push({ nameBytes: enc.encode(e.name), crc: crc32(data), size: data.length, comp, method });
  }

  const parts = [];
  let offset = 0;
  const push = (u8) => { parts.push(u8); offset += u8.length; };
  const localOffsets = [];

  for (const f of files) {
    localOffsets.push(offset);
    const h = new Uint8Array(30 + f.nameBytes.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true);        // UTF-8 names
    dv.setUint16(8, f.method, true);      // 0 stored | 8 deflate
    dv.setUint16(10, 0, true); dv.setUint16(12, 0, true);
    dv.setUint32(14, f.crc, true);
    dv.setUint32(18, f.comp.length, true); // compressed size
    dv.setUint32(22, f.size, true);        // uncompressed size
    dv.setUint16(26, f.nameBytes.length, true);
    dv.setUint16(28, 0, true);
    h.set(f.nameBytes, 30);
    push(h);
    push(f.comp);
  }

  const cdStart = offset;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const h = new Uint8Array(46 + f.nameBytes.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true); dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, f.method, true);
    dv.setUint16(12, 0, true); dv.setUint16(14, 0, true);
    dv.setUint32(16, f.crc, true);
    dv.setUint32(20, f.comp.length, true);
    dv.setUint32(24, f.size, true);
    dv.setUint16(28, f.nameBytes.length, true);
    dv.setUint16(30, 0, true); dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true); dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, localOffsets[i], true);
    h.set(f.nameBytes, 46);
    push(h);
  }
  const cdSize = offset - cdStart;

  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, files.length, true);
  dv.setUint16(10, files.length, true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdStart, true);
  push(eocd);

  return concat(parts);
}

/**
 * Read a ZIP (STORED or DEFLATE), verifying CRCs.
 * @param {Uint8Array} bytes
 * @returns {Promise<Array<{name:string, data:Uint8Array, method:number}>>}
 */
export async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Locate EOCD by scanning back for its signature (handles trailing comment).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no EOCD)');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // central directory start

  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central dir header');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

    // Local header → data start.
    const lhNameLen = dv.getUint16(localOff + 26, true);
    const lhExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + compSize);

    const data = method === 8 ? await inflateRaw(comp) : comp.slice();
    if (crc32(data) !== crc) throw new Error(`CRC mismatch in ${name}`);
    out.push({ name, data, method });

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
