/**
 * Minimal TrueType (sfnt) parser — just enough to embed a font in a PDF as a
 * Type0 / CIDFontType2 and lay out Unicode text with real metrics.
 *
 * We deliberately do NOT subset the glyf/loca tables (that means rebuilding glyph
 * ids); instead the whole font program is embedded as a FontFile2 and referenced
 * with CIDToGIDMap = Identity, so a Unicode codepoint maps to its glyph id via
 * the font's own `cmap`. That keeps this parser small and the output correct.
 *
 * Extracted per font:
 *   unitsPerEm, numGlyphs, cmap (codepoint → gid), advanceWidth(gid),
 *   ascent/descent/italicAngle/capHeight/bbox (for the FontDescriptor).
 */

export function parseTtf(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => dv.getUint16(o);
  const i16 = (o) => dv.getInt16(o);
  const u32 = (o) => dv.getUint32(o);

  const numTables = u16(4);
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(bytes[rec], bytes[rec + 1], bytes[rec + 2], bytes[rec + 3]);
    tables[tag] = { offset: u32(rec + 8), length: u32(rec + 12) };
  }

  const head = tables.head.offset;
  const unitsPerEm = u16(head + 18) || 1000;
  const bbox = [i16(head + 36), i16(head + 38), i16(head + 40), i16(head + 42)];

  const numGlyphs = u16(tables.maxp.offset + 4);

  const hhea = tables.hhea.offset;
  const ascent = i16(hhea + 4);
  const descent = i16(hhea + 6);
  const numHMetrics = u16(hhea + 34);

  const hmtx = tables.hmtx.offset;
  const advanceWidth = (gid) => {
    const idx = gid < numHMetrics ? gid : numHMetrics - 1;
    return u16(hmtx + idx * 4);
  };

  let italicAngle = 0;
  if (tables.post) italicAngle = dv.getInt32(tables.post.offset + 4) / 65536;
  let capHeight = Math.round(ascent * 0.7);
  if (tables['OS/2'] && tables['OS/2'].length >= 90) {
    const v = i16(tables['OS/2'].offset + 88); // sCapHeight (version ≥ 2)
    if (v) capHeight = v;
  }

  const cmap = parseCmap(dv, bytes, tables.cmap.offset, u16, u32);

  return { unitsPerEm, numGlyphs, ascent, descent, italicAngle, capHeight, bbox, cmap, advanceWidth, bytes };
}

/** Parse the best Unicode `cmap` subtable → Map(codepoint → glyphId). */
function parseCmap(dv, bytes, base, u16, u32) {
  const numSub = u16(base + 2);
  let best = null; let bestScore = -1;
  for (let i = 0; i < numSub; i += 1) {
    const rec = base + 4 + i * 8;
    const platform = u16(rec);
    const encoding = u16(rec + 2);
    const off = u32(rec + 4);
    // Prefer full-repertoire (3,10)/(0,4+) then BMP (3,1)/(0,3).
    let score = -1;
    if (platform === 3 && encoding === 10) score = 5;
    else if (platform === 0 && encoding >= 4) score = 4;
    else if (platform === 3 && encoding === 1) score = 3;
    else if (platform === 0) score = 2;
    else if (platform === 3 && encoding === 0) score = 1;
    if (score > bestScore) { bestScore = score; best = base + off; }
  }
  const map = new Map();
  if (best == null) return map;
  const format = u16(best);
  if (format === 4) parseFormat4(dv, best, u16, map);
  else if (format === 12) parseFormat12(dv, best, u32, map);
  else if (format === 6) parseFormat6(dv, best, u16, map);
  else if (format === 0) parseFormat0(bytes, best, map);
  return map;
}

function parseFormat4(dv, o, u16, map) {
  const segX2 = u16(o + 6);
  const segCount = segX2 / 2;
  const endO = o + 14;
  const startO = endO + segX2 + 2;
  const deltaO = startO + segX2;
  const rangeO = deltaO + segX2;
  for (let s = 0; s < segCount; s += 1) {
    const end = u16(endO + s * 2);
    const start = u16(startO + s * 2);
    const delta = u16(deltaO + s * 2);
    const rangeOffset = u16(rangeO + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c += 1) {
      let gid;
      if (rangeOffset === 0) gid = (c + delta) & 0xffff;
      else {
        const gi = rangeO + s * 2 + rangeOffset + (c - start) * 2;
        gid = u16(gi);
        if (gid !== 0) gid = (gid + delta) & 0xffff;
      }
      if (gid) map.set(c, gid);
    }
  }
}

function parseFormat12(dv, o, u32, map) {
  const nGroups = u32(o + 12);
  let g = o + 16;
  for (let i = 0; i < nGroups; i += 1, g += 12) {
    const start = u32(g);
    const end = u32(g + 4);
    const startGid = u32(g + 8);
    for (let c = start; c <= end; c += 1) map.set(c, startGid + (c - start));
  }
}

function parseFormat6(dv, o, u16, map) {
  const first = u16(o + 6);
  const count = u16(o + 8);
  for (let i = 0; i < count; i += 1) map.set(first + i, u16(o + 10 + i * 2));
}

function parseFormat0(bytes, o, map) {
  for (let c = 0; c < 256; c += 1) { const gid = bytes[o + 6 + c]; if (gid) map.set(c, gid); }
}
