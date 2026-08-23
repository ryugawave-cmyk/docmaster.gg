/**
 * Office / Word-style shape library for the DOCUMENT editor.
 *
 * Each shape is authored as inline SVG in a normalized 100×100 space and drawn
 * with `preserveAspectRatio="none"`, so it stretches to whatever box the user
 * draws — exactly like Word/PowerPoint auto-shapes. Shapes are inserted into the
 * document as an <img> whose src is an SVG data-URI, which means they ride the
 * existing image pipeline for free: floating/drag/resize, model round-trip and
 * DOCX / PDF / HTML export all "just work" with no exporter changes.
 *
 * This is INTENTIONALLY separate from the PDF editor's small basic-shape set
 * (see editor/blankEditorShell.js SHAPES) — that stays unchanged.
 *
 * Colour tokens `@F` (fill) and `@S` (stroke) in a shape's markup are substituted
 * at generation time so a shape can be inserted in any colour. Group defaults
 * cover most elements; only overrides (e.g. an arrowhead that must be filled on a
 * stroke-only connector) spell out `fill="@S"`.
 */

const r = (n) => Math.round(n * 10) / 10;

/* ------------------------------ svg primitives ---------------------------- */
const P = (d) => `<path d="${d}"/>`;
const POLY = (p) => `<polygon points="${p}"/>`;
const RECT = (x, y, w, h, rx = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}"${rx ? ` rx="${rx}" ry="${rx}"` : ''}/>`;
const CIRCLE = (cx, cy, rad) => `<circle cx="${cx}" cy="${cy}" r="${rad}"/>`;
const ELL = (cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/>`;
const LINE = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;

/** Regular n-gon points, a vertex at the top by default. */
function regPoly(n, cx = 50, cy = 50, rad = 47, rotDeg = -90) {
  const rot = (rotDeg * Math.PI) / 180;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const a = rot + (i * 2 * Math.PI) / n;
    out.push(`${r(cx + rad * Math.cos(a))},${r(cy + rad * Math.sin(a))}`);
  }
  return out.join(' ');
}
/** n-point star points. */
function starPts(n, rO = 48, rI = null, cx = 50, cy = 50, rotDeg = -90) {
  const ri = rI == null ? rO * (n <= 5 ? 0.4 : 0.55) : rI;
  const rot = (rotDeg * Math.PI) / 180;
  const out = [];
  for (let i = 0; i < n * 2; i += 1) {
    const rad = i % 2 ? ri : rO;
    const a = rot + (i * Math.PI) / n;
    out.push(`${r(cx + rad * Math.cos(a))},${r(cy + rad * Math.sin(a))}`);
  }
  return out.join(' ');
}
/** A small filled arrowhead (for stroke-only connectors), pointing r/l/u/d. */
function head(x, y, dir, s = 9) {
  const m = {
    r: `${x},${y} ${x - s},${y - s * 0.7} ${x - s},${y + s * 0.7}`,
    l: `${x},${y} ${x + s},${y - s * 0.7} ${x + s},${y + s * 0.7}`,
    u: `${x},${y} ${x - s * 0.7},${y + s} ${x + s * 0.7},${y + s}`,
    d: `${x},${y} ${x - s * 0.7},${y - s} ${x + s * 0.7},${y - s}`,
  };
  return `<polygon points="${m[dir]}" fill="@S" stroke="none"/>`;
}

/* -------------------------------- shapes ---------------------------------- */
// id → { name, cats:[...], kw, svg, line? }  (line ⇒ stroke-only default fill)
const S = {};
const add = (id, name, cats, kw, svg, opts = {}) => { S[id] = { id, name, cats, kw, svg, line: !!opts.line }; };

/* ---- Lines / connectors (stroke-only) ---- */
add('line', 'Line', ['lines'], 'line straight', LINE(10, 90, 90, 10), { line: true });
add('lineArrow', 'Line Arrow', ['lines'], 'line arrow', LINE(10, 90, 86, 14) + head(90, 10, 'r'), { line: true });
add('lineDoubleArrow', 'Line Double Arrow', ['lines'], 'line double arrow', LINE(14, 86, 86, 14) + head(90, 10, 'r') + head(10, 90, 'l'), { line: true });
add('straightConnector', 'Straight Connector', ['lines'], 'connector straight', LINE(10, 50, 90, 50), { line: true });
add('elbowConnector', 'Elbow Connector', ['lines'], 'elbow connector', P('M10,20 L50,20 L50,80 L90,80'), { line: true });
add('elbowArrowConnector', 'Elbow Arrow Connector', ['lines'], 'elbow arrow connector', P('M10,20 L50,20 L50,80 L86,80') + head(90, 80, 'r'), { line: true });
add('elbowDoubleArrowConnector', 'Elbow Double Arrow Connector', ['lines'], 'elbow double arrow connector', P('M14,20 L50,20 L50,80 L86,80') + head(90, 80, 'r') + head(10, 20, 'l'), { line: true });
add('curvedConnector', 'Curved Connector', ['lines'], 'curved connector', P('M10,20 Q80,20 80,80 T90,80'), { line: true });
add('curvedArrowConnector', 'Curved Arrow Connector', ['lines'], 'curved arrow connector', P('M10,20 C60,20 40,80 84,80') + head(90, 80, 'r'), { line: true });
add('curvedDoubleArrowConnector', 'Curved Double Arrow Connector', ['lines'], 'curved double arrow connector', P('M14,20 C60,20 40,80 84,80') + head(90, 80, 'r') + head(10, 20, 'l'), { line: true });
add('scribble', 'Scribble', ['lines'], 'scribble freeform pencil', P('M10,60 C20,20 30,90 40,50 S55,15 62,55 78,85 90,35'), { line: true });

/* ---- Rectangles ---- */
add('rectangle', 'Rectangle', ['rectangles'], 'rectangle square box', RECT(6, 18, 88, 64));
add('roundedRectangle', 'Rounded Rectangle', ['rectangles'], 'rounded rectangle', RECT(6, 18, 88, 64, 12));
add('snipSingle', 'Snip Single Corner Rectangle', ['rectangles'], 'snip corner rectangle', P('M6,18 L78,18 L94,34 L94,82 L6,82 Z'));
add('snipSameSide', 'Snip Same Side Corner Rectangle', ['rectangles'], 'snip same side rectangle', P('M22,18 L78,18 L94,34 L94,82 L6,82 L6,34 Z'));
add('snipDiagonal', 'Snip Diagonal Corner Rectangle', ['rectangles'], 'snip diagonal rectangle', P('M22,18 L94,18 L94,66 L78,82 L6,82 L6,34 Z'));
add('snipRoundSingle', 'Snip and Round Single Corner Rectangle', ['rectangles'], 'snip round rectangle', P('M6,30 A12,12 0 0 1 18,18 L78,18 L94,34 L94,82 L6,82 Z'));
add('roundSingle', 'Round Single Corner Rectangle', ['rectangles'], 'round single corner rectangle', P('M6,18 L82,18 A12,12 0 0 1 94,30 L94,82 L6,82 Z'));
add('roundSameSide', 'Round Same Side Corner Rectangle', ['rectangles'], 'round same side rectangle', P('M6,30 A12,12 0 0 1 18,18 L82,18 A12,12 0 0 1 94,30 L94,82 L6,82 Z'));

/* ---- Basic shapes ---- */
add('oval', 'Oval', ['basic'], 'oval ellipse circle', ELL(50, 50, 46, 34));
add('triangle', 'Triangle', ['basic'], 'triangle isosceles', POLY('50,10 92,88 8,88'));
add('rightTriangle', 'Right Triangle', ['basic'], 'right triangle', POLY('10,10 10,90 90,90'));
add('parallelogram', 'Parallelogram', ['basic'], 'parallelogram', POLY('26,20 94,20 74,80 6,80'));
add('trapezoid', 'Trapezoid', ['basic'], 'trapezoid', POLY('28,20 72,20 94,80 6,80'));
add('diamond', 'Diamond', ['basic'], 'diamond rhombus', POLY('50,8 92,50 50,92 8,50'));
add('pentagon', 'Pentagon', ['basic'], 'pentagon 5', POLY(regPoly(5)));
add('hexagon', 'Hexagon', ['basic'], 'hexagon 6', POLY(regPoly(6, 50, 50, 47, 0)));
add('heptagon', 'Heptagon', ['basic'], 'heptagon 7', POLY(regPoly(7)));
add('octagon', 'Octagon', ['basic'], 'octagon 8', POLY(regPoly(8, 50, 50, 47, 22.5)));
add('decagon', 'Decagon', ['basic'], 'decagon 10', POLY(regPoly(10, 50, 50, 47, 18)));
add('dodecagon', 'Dodecagon', ['basic'], 'dodecagon 12', POLY(regPoly(12, 50, 50, 47, 15)));
add('pie', 'Pie', ['basic', 'diagram'], 'pie wedge', P('M50,50 L50,4 A46,46 0 1 1 8,66 Z'));
add('chord', 'Chord', ['basic'], 'chord', P('M14,26 A46,46 0 1 1 88,72 Z'));
add('teardrop', 'Teardrop', ['basic'], 'teardrop', P('M50,6 C74,6 94,26 94,50 C94,74 74,94 50,94 C34,94 30,78 30,70 L6,50 C6,26 26,6 50,6 Z'));
add('frame', 'Frame', ['basic'], 'frame border', `<path fill-rule="evenodd" d="M6,14 H94 V86 H6 Z M20,28 V72 H80 V28 Z"/>`);
add('halfFrame', 'Half Frame', ['basic'], 'half frame corner', P('M6,14 L94,14 L94,28 L20,28 L20,86 L6,86 Z'));
add('corner', 'Corner', ['basic'], 'corner L', P('M6,14 L34,14 L34,60 L94,60 L94,86 L6,86 Z'));
add('diagonalStripe', 'Diagonal Stripe', ['basic'], 'diagonal stripe', POLY('6,86 60,14 94,14 40,86'));
add('cross', 'Cross', ['basic', 'equation'], 'cross plus', P('M38,10 H62 V38 H90 V62 H62 V90 H38 V62 H10 V38 H38 Z'));
add('plaque', 'Plaque', ['basic'], 'plaque', P('M6,26 A20,20 0 0 0 26,6 H74 A20,20 0 0 0 94,26 V74 A20,20 0 0 0 74,94 H26 A20,20 0 0 0 6,74 Z'));
add('can', 'Can', ['basic', 'diagram'], 'can cylinder tin', `<path d="M14,22 V78 A36,10 0 0 0 86,78 V22"/><ellipse cx="50" cy="22" rx="36" ry="10"/>`);
add('cube', 'Cube', ['basic', 'diagram'], 'cube 3d box', `<path d="M10,30 L30,10 L90,10 L90,70 L70,90 L10,90 Z"/><path d="M10,30 L70,30 L90,10 M70,30 L70,90" fill="none"/>`);
add('bevel', 'Bevel', ['basic'], 'bevel button', `<rect x="6" y="18" width="88" height="64"/><path d="M6,18 L94,18 L78,34 L22,34 Z M6,82 L22,66 L78,66 L94,82 M6,18 L22,34 L22,66 L6,82 M94,18 L78,34 L78,66 L94,82" fill="none"/>`);
add('donut', 'Donut', ['basic', 'diagram'], 'donut ring annulus', `<path fill-rule="evenodd" d="M50,8 A42,42 0 1 0 50.1,8 Z M50,30 A20,20 0 1 1 49.9,30 Z"/>`);
add('noSmoking', 'No Smoking', ['basic', 'symbols'], 'no smoking prohibited ban', `<path fill-rule="evenodd" d="M50,8 A42,42 0 1 0 50.1,8 Z M50,20 A30,30 0 0 0 24,66 L66,24 A30,30 0 0 0 50,20 Z M76,34 L34,76 A30,30 0 0 0 76,34 Z"/>`);
add('blockArc', 'Block Arc', ['basic'], 'block arc', P('M8,50 A42,42 0 0 1 92,50 L74,50 A24,24 0 0 0 26,50 Z'));
add('foldedCorner', 'Folded Corner', ['basic'], 'folded corner page', `<path d="M6,14 H94 V66 L70,90 H6 Z"/><path d="M70,90 L70,66 L94,66" fill="none"/>`);

/* ---- Block arrows ---- */
add('rightArrow', 'Right Arrow', ['arrows'], 'right arrow', POLY('6,36 60,36 60,18 94,50 60,82 60,64 6,64'));
add('leftArrow', 'Left Arrow', ['arrows'], 'left arrow', POLY('94,36 40,36 40,18 6,50 40,82 40,64 94,64'));
add('upArrow', 'Up Arrow', ['arrows'], 'up arrow', POLY('36,94 36,40 18,40 50,6 82,40 64,40 64,94'));
add('downArrow', 'Down Arrow', ['arrows'], 'down arrow', POLY('36,6 36,60 18,60 50,94 82,60 64,60 64,6'));
add('leftRightArrow', 'Left-Right Arrow', ['arrows'], 'left right arrow', POLY('6,50 26,32 26,42 74,42 74,32 94,50 74,68 74,58 26,58 26,68'));
add('upDownArrow', 'Up-Down Arrow', ['arrows'], 'up down arrow', POLY('50,6 68,26 58,26 58,74 68,74 50,94 32,74 42,74 42,26 32,26'));
add('quadArrow', 'Quad Arrow', ['arrows'], 'quad four arrow', POLY('50,4 66,22 56,22 56,44 78,44 78,34 96,50 78,66 78,56 56,56 56,78 66,78 50,96 34,78 44,78 44,56 22,56 22,66 4,50 22,34 22,44 44,44 44,22 34,22'));
add('leftRightUpArrow', 'Left-Right-Up Arrow', ['arrows'], 'left right up three arrow', POLY('50,4 66,22 56,22 56,56 78,56 78,46 96,62 78,78 78,68 22,68 22,78 4,62 22,46 22,56 44,56 44,22 34,22'));
add('bentArrow', 'Bent Arrow', ['arrows'], 'bent arrow', P('M14,90 L14,44 A18,18 0 0 1 32,26 L66,26 L66,10 L94,36 L66,62 L66,46 L38,46 A2,2 0 0 0 36,48 L36,90 Z'));
add('uTurnArrow', 'U-Turn Arrow', ['arrows'], 'u turn arrow', P('M18,90 L18,40 A22,22 0 0 1 62,40 L62,58 L78,58 L54,86 L30,58 L46,58 L46,40 A6,6 0 0 0 34,40 L34,90 Z'));
add('circularArrow', 'Circular Arrow', ['arrows'], 'circular arrow refresh', P('M74,26 A34,34 0 1 0 84,52 L72,52 A22,22 0 1 1 66,34 L56,44 L90,44 L90,10 Z'));
add('leftCircularArrow', 'Left Circular Arrow', ['arrows'], 'left circular arrow', P('M26,26 A34,34 0 1 1 16,52 L28,52 A22,22 0 1 0 34,34 L44,44 L10,44 L10,10 Z'));
add('rightCircularArrow', 'Right Circular Arrow', ['arrows'], 'right circular arrow', P('M74,26 A34,34 0 1 0 84,52 L72,52 A22,22 0 1 1 66,34 L56,44 L90,44 L90,10 Z'));
add('curvedRightArrow', 'Curved Right Arrow', ['arrows'], 'curved right arrow', P('M14,20 C58,20 58,60 58,68 L58,84 L92,58 L58,32 L58,44 C58,40 42,40 30,44 C20,30 16,24 14,20 Z'));
add('curvedLeftArrow', 'Curved Left Arrow', ['arrows'], 'curved left arrow', P('M86,20 C42,20 42,60 42,68 L42,84 L8,58 L42,32 L42,44 C42,40 58,40 70,44 C80,30 84,24 86,20 Z'));
add('curvedUpArrow', 'Curved Up Arrow', ['arrows'], 'curved up arrow', P('M20,86 C20,42 60,42 68,42 L84,42 L58,8 L32,42 L44,42 C40,42 40,58 44,70 C30,80 24,84 20,86 Z'));
add('curvedDownArrow', 'Curved Down Arrow', ['arrows'], 'curved down arrow', P('M20,14 C20,58 60,58 68,58 L84,58 L58,92 L32,58 L44,58 C40,58 40,42 44,30 C30,20 24,16 20,14 Z'));
add('swooshArrow', 'Swoosh Arrow', ['arrows'], 'swoosh arrow', P('M8,84 C30,40 60,26 78,30 L70,16 L96,34 L66,46 L72,34 C56,32 34,50 20,88 Z'));
add('stripedRightArrow', 'Striped Right Arrow', ['arrows'], 'striped right arrow', `<polygon points="24,36 60,36 60,18 94,50 60,82 60,64 24,64"/><rect x="6" y="36" width="6" height="28"/><rect x="15" y="36" width="6" height="28"/>`);

/* ---- Arrow callouts (shared with Callouts) ---- */
add('leftArrowCallout', 'Left Arrow Callout', ['arrows', 'callouts'], 'left arrow callout', POLY('6,50 30,34 30,44 44,44 44,20 94,20 94,80 44,80 44,56 30,56 30,66'));
add('rightArrowCallout', 'Right Arrow Callout', ['arrows', 'callouts'], 'right arrow callout', POLY('94,50 70,34 70,44 56,44 56,20 6,20 6,80 56,80 56,56 70,56 70,66'));
add('upArrowCallout', 'Up Arrow Callout', ['arrows', 'callouts'], 'up arrow callout', POLY('50,6 34,30 44,30 44,44 20,44 20,94 80,94 80,44 56,44 56,30 66,30'));
add('downArrowCallout', 'Down Arrow Callout', ['arrows', 'callouts'], 'down arrow callout', POLY('50,94 34,70 44,70 44,56 20,56 20,6 80,6 80,56 56,56 56,70 66,70'));
add('leftRightArrowCallout', 'Left-Right Arrow Callout', ['arrows', 'callouts'], 'left right arrow callout', POLY('6,50 26,34 26,44 34,44 34,24 66,24 66,44 74,44 74,34 94,50 74,66 74,56 66,56 66,76 34,76 34,56 26,56 26,66'));
add('quadArrowCallout', 'Quad Arrow Callout', ['arrows', 'callouts'], 'quad arrow callout', POLY('50,4 62,20 54,20 54,34 66,34 66,26 82,38 66,50 66,42 54,42 54,58 66,58 66,50 82,62 66,74 66,66 54,66 54,80 62,80 50,96 38,80 46,80 46,66 34,66 34,74 18,62 34,50 34,58 46,58 46,42 34,42 34,50 18,38 34,26 34,34 46,34 46,20 38,20'));

/* ---- Flowchart ---- */
add('flProcess', 'Process', ['flowchart'], 'flowchart process rectangle', RECT(8, 24, 84, 52));
add('flAltProcess', 'Alternate Process', ['flowchart'], 'flowchart alternate process', RECT(8, 24, 84, 52, 12));
add('flDecision', 'Decision', ['flowchart'], 'flowchart decision diamond', POLY('50,10 92,50 50,90 8,50'));
add('flData', 'Data', ['flowchart'], 'flowchart data parallelogram io', POLY('24,24 92,24 76,76 8,76'));
add('flPredefined', 'Predefined Process', ['flowchart'], 'flowchart predefined process subroutine', `<rect x="8" y="24" width="84" height="52"/><line x1="18" y1="24" x2="18" y2="76"/><line x1="82" y1="24" x2="82" y2="76"/>`);
add('flInternalStorage', 'Internal Storage', ['flowchart'], 'flowchart internal storage', `<rect x="8" y="24" width="84" height="52"/><line x1="20" y1="24" x2="20" y2="76"/><line x1="8" y1="36" x2="92" y2="36"/>`);
add('flDocument', 'Document', ['flowchart'], 'flowchart document', P('M8,20 H92 V70 C74,84 56,58 38,70 C26,78 16,72 8,68 Z'));
add('flMultidoc', 'Multidocument', ['flowchart'], 'flowchart multidocument', `<path d="M16,26 H96 V72 C80,84 64,60 48,72 C36,80 26,74 16,70 Z"/><path d="M12,22 H92 M92,22 V60" fill="none"/><path d="M8,18 H88 V22" fill="none"/>`);
add('flTerminator', 'Terminator', ['flowchart'], 'flowchart terminator start end', RECT(8, 30, 84, 40, 20));
add('flPreparation', 'Preparation', ['flowchart'], 'flowchart preparation hexagon', POLY('24,24 76,24 92,50 76,76 24,76 8,50'));
add('flManualInput', 'Manual Input', ['flowchart'], 'flowchart manual input', POLY('8,34 92,20 92,76 8,76'));
add('flManualOp', 'Manual Operation', ['flowchart'], 'flowchart manual operation trapezoid', POLY('8,24 92,24 76,76 24,76'));
add('flConnector', 'Connector', ['flowchart'], 'flowchart connector circle', CIRCLE(50, 50, 32));
add('flOffPage', 'Off-page Connector', ['flowchart'], 'flowchart off page connector', POLY('16,20 84,20 84,64 50,86 16,64'));
add('flDelay', 'Delay', ['flowchart'], 'flowchart delay', P('M8,24 H64 A26,26 0 0 1 64,76 H8 Z'));
add('flExtract', 'Extract', ['flowchart'], 'flowchart extract triangle', POLY('50,18 88,82 12,82'));
add('flMerge', 'Merge', ['flowchart'], 'flowchart merge', POLY('12,18 88,18 50,82'));
add('flSort', 'Sort', ['flowchart'], 'flowchart sort', `<polygon points="50,12 90,50 50,88 10,50"/><line x1="10" y1="50" x2="90" y2="50"/>`);
add('flSummingJunction', 'Summing Junction', ['flowchart'], 'flowchart summing junction', `<circle cx="50" cy="50" r="34"/><line x1="26" y1="26" x2="74" y2="74"/><line x1="74" y1="26" x2="26" y2="74"/>`);
add('flOr', 'Or', ['flowchart'], 'flowchart or', `<circle cx="50" cy="50" r="34"/><line x1="50" y1="16" x2="50" y2="84"/><line x1="16" y1="50" x2="84" y2="50"/>`);
add('flCollate', 'Collate', ['flowchart'], 'flowchart collate', POLY('14,16 86,16 14,84 86,84'));
add('flStoredData', 'Stored Data', ['flowchart'], 'flowchart stored data', P('M20,20 H92 A16,30 0 0 0 92,80 H20 A16,30 0 0 1 20,20 Z'));
add('flDatabase', 'Database', ['flowchart'], 'flowchart database cylinder', `<path d="M14,26 V74 A36,10 0 0 0 86,74 V26"/><ellipse cx="50" cy="26" rx="36" ry="10"/>`);
add('flDirectAccess', 'Direct Access Storage', ['flowchart'], 'flowchart direct access storage drum', `<path d="M22,20 A14,30 0 0 0 22,80 H78 A14,30 0 0 0 78,20 Z"/><path d="M78,20 A14,30 0 0 0 78,80" fill="none"/>`);
add('flDisplay', 'Display', ['flowchart'], 'flowchart display', P('M8,50 L26,20 H80 A18,30 0 0 1 80,80 H26 Z'));

/* ---- Callouts ---- */
add('rectCallout', 'Rectangular Callout', ['callouts'], 'rectangular callout speech', P('M6,10 H94 V64 H46 L30,88 L34,64 H6 Z'));
add('roundRectCallout', 'Rounded Rectangular Callout', ['callouts'], 'rounded rectangular callout', P('M18,10 H82 A12,12 0 0 1 94,22 V52 A12,12 0 0 1 82,64 H46 L30,88 L34,64 H18 A12,12 0 0 1 6,52 V22 A12,12 0 0 1 18,10 Z'));
add('ovalCallout', 'Oval Callout', ['callouts'], 'oval callout speech bubble', `<ellipse cx="50" cy="40" rx="44" ry="30"/><path d="M40,66 L28,90 L52,66 Z"/>`);
add('cloudCallout', 'Cloud Callout', ['callouts'], 'cloud callout thought', `<path d="M28,30 A14,14 0 0 1 54,22 A16,16 0 0 1 80,32 A13,13 0 0 1 82,58 A15,15 0 0 1 56,66 A16,16 0 0 1 30,60 A14,14 0 0 1 28,30 Z"/><circle cx="30" cy="74" r="6"/><circle cx="20" cy="84" r="4"/>`);
add('lineCallout1', '1-Line Callout', ['callouts'], 'line callout one', `<rect x="40" y="10" width="54" height="34"/><path d="M40,30 L8,86" fill="none"/>`);
add('lineCallout2', '2-Line Callout', ['callouts'], 'line callout two', `<rect x="40" y="10" width="54" height="34"/><path d="M40,36 L20,70 L8,86" fill="none"/>`);
add('lineCallout3', '3-Line Callout', ['callouts'], 'line callout three', `<rect x="40" y="10" width="54" height="34"/><path d="M40,40 L26,60 L26,78 L8,86" fill="none"/>`);
add('wedgeRectCallout', 'Wedge Rectangular Callout', ['callouts'], 'wedge rectangular callout', P('M6,12 H94 V60 H40 L10,90 L26,60 H6 Z'));
add('wedgeRoundRectCallout', 'Wedge Round Rectangle Callout', ['callouts'], 'wedge round rectangle callout', P('M18,12 H82 A12,12 0 0 1 94,24 V48 A12,12 0 0 1 82,60 H40 L10,90 L26,60 H18 A12,12 0 0 1 6,48 V24 A12,12 0 0 1 18,12 Z'));

/* ---- Stars & banners ---- */
[4, 5, 6, 7, 8, 10, 12, 16, 24, 32].forEach((n) => {
  add(`star${n}`, `${n}-Point Star`, ['stars'], `star ${n} point`, POLY(starPts(n, 48, n >= 12 ? 40 : null)));
});
add('explosion1', 'Explosion 1', ['stars'], 'explosion burst star', POLY(starPts(12, 48, 22)));
add('explosion2', 'Explosion 2', ['stars'], 'explosion burst star', POLY(starPts(14, 48, 26, 50, 50, -95)));
add('explosion3', 'Explosion 3', ['stars'], 'explosion burst star', POLY(starPts(10, 48, 18)));
add('explosion4', 'Explosion 4', ['stars'], 'explosion burst star', POLY(starPts(16, 48, 30, 50, 50, -84)));
add('horizontalScroll', 'Horizontal Scroll', ['stars'], 'horizontal scroll banner', P('M18,26 A8,8 0 0 1 34,26 V64 A8,8 0 0 0 50,64 H82 A8,8 0 0 1 66,74 H18 A8,8 0 0 0 34,74 V36 A8,8 0 0 1 18,36 Z'));
add('verticalScroll', 'Vertical Scroll', ['stars'], 'vertical scroll banner', P('M26,18 A8,8 0 0 1 26,34 H64 A8,8 0 0 0 64,50 V82 A8,8 0 0 1 74,66 V18 A8,8 0 0 0 58,34 H36 A8,8 0 0 1 26,18 Z'));
add('wave', 'Wave', ['stars'], 'wave banner', P('M8,32 C28,14 44,50 64,36 C78,26 86,32 92,36 L92,68 C72,86 56,50 36,64 C22,74 14,68 8,64 Z'));
add('doubleWave', 'Double Wave', ['stars'], 'double wave banner', P('M6,32 C18,16 30,48 46,36 C58,26 62,48 76,38 C84,32 90,34 94,36 L94,68 C82,84 70,52 54,64 C42,74 38,52 24,62 C16,68 10,66 6,64 Z'));
add('ribbon', 'Ribbon', ['stars'], 'ribbon banner', P('M10,30 L50,30 L50,20 L90,20 L82,40 L90,60 L50,60 L50,50 L10,50 L18,40 Z'));
add('chevron', 'Chevron', ['stars', 'arrows'], 'chevron arrow banner', POLY('6,20 62,20 90,50 62,80 6,80 34,50'));
add('homePlate', 'Home Plate', ['stars', 'arrows'], 'home plate pentagon arrow', POLY('6,20 66,20 92,50 66,80 6,80'));
add('pieBanner', 'Pie Banner', ['stars'], 'pie banner', P('M8,72 A46,46 0 0 1 92,72 Z'));
add('circularArrowBanner', 'Circular Arrow Banner', ['stars'], 'circular arrow banner', P('M20,74 A38,38 0 1 1 78,80 L70,68 A24,24 0 1 0 34,66 L44,60 L18,88 L8,54 Z'));

/* ---- Equation ---- */
add('eqPlus', 'Plus', ['equation'], 'plus add math', P('M40,10 H60 V40 H90 V60 H60 V90 H40 V60 H10 V40 H40 Z'));
add('eqMinus', 'Minus', ['equation'], 'minus subtract math', RECT(10, 42, 80, 16));
add('eqMultiply', 'Multiply', ['equation'], 'multiply times cross math', P('M28,14 L50,36 L72,14 L86,28 L64,50 L86,72 L72,86 L50,64 L28,86 L14,72 L36,50 L14,28 Z'));
add('eqDivide', 'Divide', ['equation'], 'divide math', `<circle cx="50" cy="24" r="7"/><rect x="14" y="44" width="72" height="12"/><circle cx="50" cy="76" r="7"/>`);
add('eqEqual', 'Equal', ['equation'], 'equal math', `<rect x="14" y="32" width="72" height="12"/><rect x="14" y="56" width="72" height="12"/>`);
add('eqNotEqual', 'Not Equal', ['equation'], 'not equal math', `<rect x="14" y="34" width="72" height="11"/><rect x="14" y="55" width="72" height="11"/><rect x="46" y="10" width="10" height="80" transform="rotate(20 50 50)"/>`);

/* ---- Symbols ---- */
add('heart', 'Heart', ['symbols'], 'heart love', P('M50,86 C4,54 14,18 34,18 C44,18 50,28 50,32 C50,28 56,18 66,18 C86,18 96,54 50,86 Z'));
add('lightningBolt', 'Lightning Bolt', ['symbols'], 'lightning bolt flash', POLY('54,6 24,54 44,54 34,94 78,40 54,40 66,6'));
add('sun', 'Sun', ['symbols'], 'sun weather', (() => {
  let rays = '';
  for (let i = 0; i < 12; i += 1) { const a = (i * 30 * Math.PI) / 180; rays += LINE(r(50 + 30 * Math.cos(a)), r(50 + 30 * Math.sin(a)), r(50 + 44 * Math.cos(a)), r(50 + 44 * Math.sin(a))); }
  return CIRCLE(50, 50, 24) + rays;
})());
add('moon', 'Moon', ['symbols'], 'moon crescent night', P('M64,8 A44,44 0 1 0 64,92 A34,34 0 0 1 64,8 Z'));
add('cloud', 'Cloud', ['symbols'], 'cloud weather', P('M28,72 A16,16 0 0 1 30,42 A18,18 0 0 1 58,32 A16,16 0 0 1 82,46 A14,14 0 0 1 80,72 Z'));
add('smiley', 'Smiley Face', ['symbols'], 'smiley face happy emoji', `<circle cx="50" cy="50" r="42"/><circle cx="36" cy="40" r="5" fill="@S" stroke="none"/><circle cx="64" cy="40" r="5" fill="@S" stroke="none"/><path d="M32,60 Q50,78 68,60" fill="none"/>`);
add('prohibition', 'Prohibition', ['symbols'], 'prohibition no ban forbidden', `<path fill-rule="evenodd" d="M50,8 A42,42 0 1 0 50.1,8 Z M50,20 A30,30 0 0 0 24,66 L66,24 A30,30 0 0 0 50,20 Z M76,34 L34,76 A30,30 0 0 0 76,34 Z"/>`);
add('gear', 'Gear', ['symbols'], 'gear cog settings', (() => {
  const teeth = 8; let d = '';
  for (let i = 0; i < teeth; i += 1) {
    const a0 = (i * 360 / teeth - 12) * Math.PI / 180;
    const a1 = (i * 360 / teeth + 12) * Math.PI / 180;
    const ao0 = (i * 360 / teeth - 8) * Math.PI / 180;
    const ao1 = (i * 360 / teeth + 8) * Math.PI / 180;
    const R = 46, r0 = 36;
    const pt = (ang, rad) => `${r(50 + rad * Math.cos(ang))},${r(50 + rad * Math.sin(ang))}`;
    d += (i === 0 ? 'M' : 'L') + pt(a0, r0) + ' L' + pt(ao0, R) + ' L' + pt(ao1, R) + ' L' + pt(a1, r0) + ' ';
  }
  return `<path fill-rule="evenodd" d="${d}Z M50,36 A14,14 0 1 0 50.1,36 Z"/>`;
})());
add('puzzle', 'Puzzle Piece', ['symbols'], 'puzzle piece jigsaw', P('M18,18 H42 A8,8 0 1 1 58,18 H82 V42 A8,8 0 1 1 82,58 V82 H58 A8,8 0 1 0 42,82 H18 V58 A8,8 0 1 0 18,42 Z'));
add('magnifier', 'Magnifying Glass', ['symbols'], 'magnifying glass search zoom', `<circle cx="42" cy="42" r="28" fill="none"/><line x1="62" y1="62" x2="88" y2="88" stroke-width="8"/>`);
add('checkMark', 'Check Mark', ['symbols'], 'check mark tick correct', POLY('16,50 38,74 84,20 92,30 40,90 8,58'));
add('xMark', 'X', ['symbols'], 'x cross wrong close', P('M20,10 L50,40 L80,10 L90,20 L60,50 L90,80 L80,90 L50,60 L20,90 L10,80 L40,50 L10,20 Z'));
add('info', 'Information', ['symbols'], 'information info i', `<circle cx="50" cy="50" r="42"/><circle cx="50" cy="30" r="6" fill="@S" stroke="none"/><rect x="44" y="42" width="12" height="34" fill="@S" stroke="none"/>`);
add('warning', 'Warning', ['symbols'], 'warning caution alert triangle', `<path d="M50,10 L92,84 H8 Z"/><rect x="45" y="38" width="10" height="26" fill="@S" stroke="none"/><circle cx="50" cy="72" r="5" fill="@S" stroke="none"/>`);

/* ---- Mathematical / diagram ---- */
add('circle', 'Circle', ['diagram'], 'circle round', CIRCLE(50, 50, 42));
add('ring', 'Ring', ['diagram'], 'ring annulus donut', `<path fill-rule="evenodd" d="M50,8 A42,42 0 1 0 50.1,8 Z M50,26 A24,24 0 1 1 49.9,26 Z"/>`);
add('arc', 'Arc', ['diagram'], 'arc curve', P('M8,50 A42,42 0 0 1 92,50'), { line: true });
add('sector', 'Sector', ['diagram'], 'sector pie wedge', P('M50,50 L92,50 A42,42 0 0 0 50,8 Z'));
add('cylinder', 'Cylinder', ['diagram'], 'cylinder tube 3d', `<path d="M14,22 V78 A36,10 0 0 0 86,78 V22"/><ellipse cx="50" cy="22" rx="36" ry="10"/>`);
add('sphere', 'Sphere', ['diagram'], 'sphere ball 3d', `<circle cx="50" cy="50" r="42"/><ellipse cx="50" cy="50" rx="42" ry="14" fill="none"/><ellipse cx="50" cy="50" rx="14" ry="42" fill="none"/>`);
add('pyramid', 'Pyramid', ['diagram'], 'pyramid 3d triangle', `<path d="M50,8 L92,86 H8 Z"/><path d="M50,8 L50,86" fill="none"/>`);
add('cone', 'Cone', ['diagram'], 'cone 3d', `<path d="M50,8 L86,74 A36,12 0 0 1 14,74 Z"/><path d="M14,74 A36,12 0 0 0 86,74" fill="none"/>`);
add('bracketPair', 'Bracket Pair', ['diagram'], 'bracket pair brackets', `<path d="M32,10 H20 V90 H32 M68,10 H80 V90 H68" fill="none"/>`, { line: true });
add('bracePair', 'Brace Pair', ['diagram'], 'brace pair braces curly', `<path d="M34,10 Q22,10 22,26 Q22,44 12,50 Q22,56 22,74 Q22,90 34,90 M66,10 Q78,10 78,26 Q78,44 88,50 Q78,56 78,74 Q78,90 66,90" fill="none"/>`, { line: true });
add('leftBracket', 'Left Bracket', ['diagram'], 'left bracket', `<path d="M62,10 H42 V90 H62" fill="none"/>`, { line: true });
add('rightBracket', 'Right Bracket', ['diagram'], 'right bracket', `<path d="M38,10 H58 V90 H38" fill="none"/>`, { line: true });
add('leftBrace', 'Left Brace', ['diagram'], 'left brace curly', `<path d="M60,10 Q44,10 44,26 Q44,44 30,50 Q44,56 44,74 Q44,90 60,90" fill="none"/>`, { line: true });
add('rightBrace', 'Right Brace', ['diagram'], 'right brace curly', `<path d="M40,10 Q56,10 56,26 Q56,44 70,50 Q56,56 56,74 Q56,90 40,90" fill="none"/>`, { line: true });

/* ------------------------------- categories ------------------------------- */
export const SHAPE_CATEGORIES = [
  { id: 'lines', name: 'Lines' },
  { id: 'rectangles', name: 'Rectangles' },
  { id: 'basic', name: 'Basic Shapes' },
  { id: 'arrows', name: 'Arrows' },
  { id: 'flowchart', name: 'Flowchart' },
  { id: 'callouts', name: 'Callouts' },
  { id: 'stars', name: 'Stars & Banners' },
  { id: 'equation', name: 'Equation' },
  { id: 'symbols', name: 'Symbols' },
  { id: 'diagram', name: 'Diagram' },
];

export const SHAPES = S;
export const ALL_SHAPES = Object.values(S);

/** Shapes belonging to a category, in insertion order. */
export function shapesInCategory(catId) {
  return ALL_SHAPES.filter((s) => s.cats.includes(catId));
}

/** Free-text search across name + keywords + category names. */
export function searchShapes(query) {
  const q = query.trim().toLowerCase();
  if (!q) return ALL_SHAPES;
  const catNames = Object.fromEntries(SHAPE_CATEGORIES.map((c) => [c.id, c.name.toLowerCase()]));
  return ALL_SHAPES.filter((s) => {
    const hay = `${s.name} ${s.kw} ${s.cats.map((c) => catNames[c]).join(' ')}`.toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  });
}

const isBlank = (c) => c == null || c === 'none' || c === 'transparent';

/** Whether a shape has a fillable interior (false for lines/connectors/arcs). */
export function shapeHasFill(id) {
  return !!S[id] && !S[id].line;
}

/** Full standalone SVG markup for a shape at a given size/colour/opacity.
 *  `fill`/`stroke` accept 'none'/'transparent' to clear that part. */
export function shapeSvg(id, { width = 120, height = 90, fill = '#4472C4', stroke = '#2F528F', strokeWidth = 2, opacity = 1 } = {}) {
  const s = S[id];
  if (!s) return '';
  const noFill = s.line || isBlank(fill);
  const strokeCol = isBlank(stroke) ? 'none' : stroke;
  // `@S` (arrowheads, eye-dots) needs a concrete colour; fall back to fill/stroke.
  const tokenStroke = strokeCol === 'none' ? (noFill ? '#333333' : fill) : strokeCol;
  const inner = s.svg.replaceAll('@S', tokenStroke).replaceAll('@F', noFill ? 'none' : fill);
  const op = opacity != null && opacity < 1 ? ` opacity="${Math.max(0, Math.min(1, opacity))}"` : '';
  const g = `<g fill="${noFill ? 'none' : fill}" stroke="${strokeCol}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round"${op}>${inner}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 100 100" preserveAspectRatio="none">${g}</svg>`;
}

/** SVG data-URI (for an <img> src). */
export function shapeDataUri(id, opts) {
  return `data:image/svg+xml,${encodeURIComponent(shapeSvg(id, opts))}`;
}
