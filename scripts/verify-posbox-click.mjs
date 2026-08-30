/**
 * Regression test — positioned DOC: click routes to the nearest text box.
 *
 * Guards the fix for "can't edit text" after Transfer to Doc: a positioned document's
 * page container is inert (contentEditable=false), so a click on the baked page
 * graphics or in the GAP between line-boxes placed no caret and typing did nothing.
 * documentEditor.focusNearestPosbox() routes such a click to the nearest editable
 * `.doc-posbox`. This test locks in that nearest-box selection math (the pure part;
 * the DOM focus/caret is browser behaviour). Run: `node scripts/verify-posbox-click.mjs`.
 */

// Mirror of the distance test inside focusNearestPosbox: 0 when the point is inside
// the rect, else squared distance to the nearest edge/corner. A click farther than
// `reach` px from EVERY box is not routed (returns -1) — it's on the baked page
// graphic (e.g. a diagram), so the caret shouldn't teleport to a distant line.
const REACH = 90;
function nearestBox(boxes, x, y) {
  let best = -1, bestD = Infinity;
  boxes.forEach((r, i) => {
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD > REACH * REACH ? -1 : best;
}
const rect = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h });

let failures = 0;
const check = (label, got, want) => {
  const ok = got === want; if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  (got ${got}, want ${want})`}`);
};

// Three stacked line-boxes with gaps, like consecutive positioned text lines.
const boxes = [rect(100, 100, 200, 20), rect(100, 140, 200, 20), rect(100, 180, 260, 20)];

check('click inside box 0 → 0', nearestBox(boxes, 150, 108), 0);
check('click inside box 2 → 2', nearestBox(boxes, 300, 188), 2);
check('click in the GAP between box 0 and 1 → nearest (1, gap 122..140)', nearestBox(boxes, 150, 132), 1);
check('click in the left margin beside box 1 → 1', nearestBox(boxes, 40, 150), 1);
check('click just below last box (within reach) → last box (2)', nearestBox(boxes, 150, 240), 2);
check('click FAR below all boxes (on baked graphic) → not routed (-1)', nearestBox(boxes, 150, 400), -1);
check('click just above first box (within reach) → first box (0)', nearestBox(boxes, 150, 60), 0);
check('click FAR into a diagram, far from text → not routed (-1)', nearestBox(boxes, 600, 500), -1);
check('empty page → -1 (no box to focus)', nearestBox([], 10, 10), -1);

console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ all posbox-click checks passed'}`);
process.exit(failures ? 1 : 0);
