/**
 * Minimal, dependency-free ZIP writer.
 *
 * OOXML formats (DOCX / XLSX / PPTX) are just ZIP archives of XML (plus any
 * embedded media). We don't ship a zip library, so this assembles a valid
 * archive by hand — same spirit as the hand-written PDF writer in pdfExport.js.
 *
 * Entries are STORED (no compression): Word/Excel/PowerPoint open stored
 * archives fine, and it keeps this file small and correct (no DEFLATE encoder to
 * get wrong). `buildZip()` is pure byte assembly (Node-testable); `zipBlob()`
 * wraps it in a Blob for download.
 *
 * @typedef {{ name:string, data:(Uint8Array|string) }} ZipEntry
 */

const enc = new TextEncoder();

/** CRC-32 (IEEE) with a lazily-built lookup table. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Assemble a ZIP archive.
 * @param {ZipEntry[]} entries
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
  const files = entries.map((e) => ({
    nameBytes: enc.encode(e.name),
    data: typeof e.data === 'string' ? enc.encode(e.data) : e.data,
  }));
  for (const f of files) { f.crc = crc32(f.data); f.size = f.data.length; }

  const parts = [];
  let offset = 0;
  const push = (u8) => { parts.push(u8); offset += u8.length; };

  const localOffsets = [];
  // Local file headers + data.
  for (const f of files) {
    localOffsets.push(offset);
    const h = new Uint8Array(30 + f.nameBytes.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x04034b50, true); // local file header signature
    dv.setUint16(4, 20, true);         // version needed
    dv.setUint16(6, 0x0800, true);     // flags: UTF-8 filenames
    dv.setUint16(8, 0, true);          // method: stored
    dv.setUint16(10, 0, true);         // mod time
    dv.setUint16(12, 0, true);         // mod date
    dv.setUint32(14, f.crc, true);
    dv.setUint32(18, f.size, true);    // compressed size
    dv.setUint32(22, f.size, true);    // uncompressed size
    dv.setUint16(26, f.nameBytes.length, true);
    dv.setUint16(28, 0, true);         // extra length
    h.set(f.nameBytes, 30);
    push(h);
    push(f.data);
  }

  // Central directory.
  const cdStart = offset;
  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    const h = new Uint8Array(46 + f.nameBytes.length);
    const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x02014b50, true); // central dir header signature
    dv.setUint16(4, 20, true);         // version made by
    dv.setUint16(6, 20, true);         // version needed
    dv.setUint16(8, 0x0800, true);     // flags: UTF-8
    dv.setUint16(10, 0, true);         // method: stored
    dv.setUint16(12, 0, true);         // mod time
    dv.setUint16(14, 0, true);         // mod date
    dv.setUint32(16, f.crc, true);
    dv.setUint32(20, f.size, true);
    dv.setUint32(24, f.size, true);
    dv.setUint16(28, f.nameBytes.length, true);
    dv.setUint16(30, 0, true);         // extra length
    dv.setUint16(32, 0, true);         // comment length
    dv.setUint16(34, 0, true);         // disk number
    dv.setUint16(36, 0, true);         // internal attrs
    dv.setUint32(38, 0, true);         // external attrs
    dv.setUint32(42, localOffsets[i], true);
    h.set(f.nameBytes, 46);
    push(h);
  }
  const cdSize = offset - cdStart;

  // End of central directory record.
  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, files.length, true);   // entries on this disk
  dv.setUint16(10, files.length, true);  // total entries
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdStart, true);
  push(eocd);

  const out = new Uint8Array(offset);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** @param {ZipEntry[]} entries @param {string} [mime] */
export function zipBlob(entries, mime = 'application/zip') {
  return new Blob([buildZip(entries)], { type: mime });
}

/** Decode a data URL (`data:...;base64,XXXX`) to its raw bytes. */
export function dataURLToBytes(url) {
  const comma = url.indexOf(',');
  const meta = url.slice(0, comma);
  const body = url.slice(comma + 1);
  if (/;base64/i.test(meta)) {
    const bin = atob(body);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  return enc.encode(decodeURIComponent(body));
}
