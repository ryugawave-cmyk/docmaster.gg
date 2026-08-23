/**
 * Table grid engine — span-aware structural operations on a table.
 *
 * A table is represented as a flat list of "master" cells that tile a
 * `nrows × ncols` grid exactly:
 *
 *   Master = { r, c, rs, cs, ref }
 *     r,c  — top-left logical position (0-based)
 *     rs,cs — row/column span (>= 1)
 *     ref  — opaque payload (a <td> node in the editor, a label in tests)
 *
 * Covered positions (the cells a span sits on top of) are NOT stored — exactly
 * like real HTML, where a colspan/rowspan cell simply omits the covered <td>s.
 * All operations are pure: they take a masters array and return a new one, so
 * the same logic is unit-testable without a DOM.
 *
 * This is the single source of truth for merging: "removing an internal grid
 * line" merges the two cells into one master so text flows continuously; the
 * inverse splits it back. Removing a border is NOT the same as merging, so the
 * editor routes internal-line edits through here rather than only toggling CSS.
 */

/** Grid dimensions implied by the spans. */
export function dims(masters) {
  let nrows = 0;
  let ncols = 0;
  for (const m of masters) {
    nrows = Math.max(nrows, m.r + m.rs);
    ncols = Math.max(ncols, m.c + m.cs);
  }
  return { nrows, ncols };
}

/** 2D occupancy map: grid[r][c] = the master covering that position (or null). */
export function occupancy(masters) {
  const { nrows, ncols } = dims(masters);
  const grid = Array.from({ length: nrows }, () => new Array(ncols).fill(null));
  for (const m of masters) {
    for (let dr = 0; dr < m.rs; dr += 1) {
      for (let dc = 0; dc < m.cs; dc += 1) {
        grid[m.r + dr][m.c + dc] = m;
      }
    }
  }
  return { grid, nrows, ncols };
}

/** The master occupying a logical position, or null. */
export function masterAt(masters, r, c) {
  for (const m of masters) {
    if (r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs) return m;
  }
  return null;
}

/** Grow a rectangle until it fully contains every master it touches. */
export function expandRect(masters, r0, c0, r1, c1) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of masters) {
      const overlaps = m.r <= r1 && m.r + m.rs - 1 >= r0 && m.c <= c1 && m.c + m.cs - 1 >= c0;
      if (!overlaps) continue;
      if (m.r < r0) { r0 = m.r; changed = true; }
      if (m.c < c0) { c0 = m.c; changed = true; }
      if (m.r + m.rs - 1 > r1) { r1 = m.r + m.rs - 1; changed = true; }
      if (m.c + m.cs - 1 > c1) { c1 = m.c + m.cs - 1; changed = true; }
    }
  }
  return { r0, c0, r1, c1 };
}

/**
 * Merge everything inside the rectangle into a single master.
 * Returns { masters, master, removed } where `removed` are the refs of the
 * cells folded into `master` (so the caller can move their content).
 */
export function mergeRect(masters, r0, c0, r1, c1) {
  const rect = expandRect(masters, r0, c0, r1, c1);
  const inside = (m) => m.r >= rect.r0 && m.r + m.rs - 1 <= rect.r1 && m.c >= rect.c0 && m.c + m.cs - 1 <= rect.c1;
  const keep = masterAt(masters, rect.r0, rect.c0);
  const removed = [];
  const next = [];
  for (const m of masters) {
    if (m === keep) continue;
    if (inside(m)) { removed.push(m.ref); continue; }
    next.push(m);
  }
  const master = { r: rect.r0, c: rect.c0, rs: rect.r1 - rect.r0 + 1, cs: rect.c1 - rect.c0 + 1, ref: keep.ref };
  next.push(master);
  return { masters: sortMasters(next), master, removed };
}

/** Merge the master `ref` with the neighbour across one of its edges. */
export function mergeAcrossEdge(masters, ref, edge) {
  const m = masters.find((x) => x.ref === ref);
  if (!m) return null;
  let nr = m.r;
  let nc = m.c;
  if (edge === 't') nr = m.r - 1;
  else if (edge === 'b') nr = m.r + m.rs;
  else if (edge === 'l') nc = m.c - 1;
  else nc = m.c + m.cs; // 'r'
  const neighbour = masterAt(masters, nr, nc);
  if (!neighbour || neighbour === m) return null;
  const r0 = Math.min(m.r, neighbour.r);
  const c0 = Math.min(m.c, neighbour.c);
  const r1 = Math.max(m.r + m.rs - 1, neighbour.r + neighbour.rs - 1);
  const c1 = Math.max(m.c + m.cs - 1, neighbour.c + neighbour.cs - 1);
  return mergeRect(masters, r0, c0, r1, c1);
}

/**
 * Split a merged master back into 1×1 cells.
 * Returns { masters, added } where `added` are the new positions needing a
 * fresh ref (blank cell); `makeRef()` mints one per added position.
 */
export function unmergeAt(masters, ref, makeRef) {
  const m = masters.find((x) => x.ref === ref);
  if (!m || (m.rs === 1 && m.cs === 1)) return { masters, added: [] };
  const next = masters.filter((x) => x !== m);
  const added = [];
  for (let dr = 0; dr < m.rs; dr += 1) {
    for (let dc = 0; dc < m.cs; dc += 1) {
      if (dr === 0 && dc === 0) { next.push({ r: m.r, c: m.c, rs: 1, cs: 1, ref: m.ref }); continue; }
      const cell = { r: m.r + dr, c: m.c + dc, rs: 1, cs: 1, ref: makeRef() };
      next.push(cell);
      added.push(cell);
    }
  }
  return { masters: sortMasters(next), added };
}

/**
 * Restore ONE grid line inside a merged cell: split the master into two pieces
 * along a single logical boundary (a column boundary for 'v', a row boundary for
 * 'h'). The first (top-left) piece keeps the original ref — and therefore all its
 * content — the second piece is new and empty. Returns { masters, added }.
 *
 * This is the exact inverse of merging across that same line, so remove→restore→
 * remove is fully reversible and only the clicked segment changes.
 */
export function splitMaster(masters, ref, orient, at, makeRef) {
  const m = masters.find((x) => x.ref === ref);
  if (!m) return { masters, added: [] };
  let a;
  let b;
  if (orient === 'v') {
    if (at <= m.c || at >= m.c + m.cs) return { masters, added: [] }; // not an internal line
    a = { r: m.r, c: m.c, rs: m.rs, cs: at - m.c, ref: m.ref };
    b = { r: m.r, c: at, rs: m.rs, cs: m.c + m.cs - at, ref: makeRef() };
  } else {
    if (at <= m.r || at >= m.r + m.rs) return { masters, added: [] };
    a = { r: m.r, c: m.c, rs: at - m.r, cs: m.cs, ref: m.ref };
    b = { r: at, c: m.c, rs: m.r + m.rs - at, cs: m.cs, ref: makeRef() };
  }
  const next = masters.filter((x) => x !== m);
  next.push(a, b);
  return { masters: sortMasters(next), added: [b] };
}

/** Insert a blank row; spanning cells crossing the line stretch. */
export function insertRow(masters, at, makeRef) {
  const { ncols } = dims(masters);
  const covered = new Array(ncols).fill(false);
  const next = masters.map((m) => {
    if (m.r >= at) return { ...m, r: m.r + 1 };
    if (m.r < at && m.r + m.rs - 1 >= at) {
      for (let dc = 0; dc < m.cs; dc += 1) covered[m.c + dc] = true; // stretches over new row
      return { ...m, rs: m.rs + 1 };
    }
    return { ...m };
  });
  for (let c = 0; c < ncols; c += 1) {
    if (!covered[c]) next.push({ r: at, c, rs: 1, cs: 1, ref: makeRef() });
  }
  return sortMasters(next);
}

/** Insert a blank column; spanning cells crossing the line stretch. */
export function insertCol(masters, at, makeRef) {
  const { nrows } = dims(masters);
  const covered = new Array(nrows).fill(false);
  const next = masters.map((m) => {
    if (m.c >= at) return { ...m, c: m.c + 1 };
    if (m.c < at && m.c + m.cs - 1 >= at) {
      for (let dr = 0; dr < m.rs; dr += 1) covered[m.r + dr] = true;
      return { ...m, cs: m.cs + 1 };
    }
    return { ...m };
  });
  for (let r = 0; r < nrows; r += 1) {
    if (!covered[r]) next.push({ r, c: at, rs: 1, cs: 1, ref: makeRef() });
  }
  return sortMasters(next);
}

/** Delete a row; cells spanning across it shrink, cells starting in it move on. */
export function deleteRow(masters, at) {
  const removed = [];
  const next = [];
  for (const m of masters) {
    if (m.r > at) { next.push({ ...m, r: m.r - 1 }); continue; }
    if (m.r === at) {
      if (m.rs === 1) { removed.push(m.ref); continue; } // wholly in the row
      next.push({ ...m, rs: m.rs - 1 }); // starts here but spans down → keep, shrink
      continue;
    }
    if (m.r + m.rs - 1 >= at) { next.push({ ...m, rs: m.rs - 1 }); continue; } // spans across
    next.push({ ...m });
  }
  return { masters: sortMasters(next), removed };
}

/** Delete a column; cells spanning across it shrink, cells starting in it move on. */
export function deleteCol(masters, at) {
  const removed = [];
  const next = [];
  for (const m of masters) {
    if (m.c > at) { next.push({ ...m, c: m.c - 1 }); continue; }
    if (m.c === at) {
      if (m.cs === 1) { removed.push(m.ref); continue; }
      next.push({ ...m, cs: m.cs - 1 });
      continue;
    }
    if (m.c + m.cs - 1 >= at) { next.push({ ...m, cs: m.cs - 1 }); continue; }
    next.push({ ...m });
  }
  return { masters: sortMasters(next), removed };
}

/** Row-major order (needed to rebuild <tr>/<td> deterministically). */
export function sortMasters(masters) {
  return masters.slice().sort((a, b) => (a.r - b.r) || (a.c - b.c));
}

/**
 * Expand masters into a dense per-row cell list for renderers that need every
 * physical position (DOCX vMerge, PDF). Each entry is:
 *   { master, isMasterCell, vMergeContinue, r, c }
 * `isMasterCell` marks the top-left origin; horizontal coverage is implied by
 * the master's colspan on the origin row.
 */
export function denseRows(masters) {
  const { grid, nrows, ncols } = occupancy(masters);
  const rows = [];
  for (let r = 0; r < nrows; r += 1) {
    const cells = [];
    for (let c = 0; c < ncols; c += 1) {
      const m = grid[r][c];
      if (!m) continue;
      if (m.c === c) {
        cells.push({ master: m, r, c, originRow: m.r === r });
      }
    }
    rows.push(cells);
  }
  return { rows, nrows, ncols };
}
