/**
 * The object model — an extensible registry of document object *types*.
 *
 * Everything a user can place on a page (text, image, shape, ink stroke,
 * annotation, signature, comment, form field, …) is a plain-data object stored
 * in `page.objects`. It never carries behaviour; instead its `type` string
 * points at a **type definition** registered here. That definition knows how to:
 *
 *   - `create(props)`   build a well-formed object of this type
 *   - `bounds(obj)`     report its page-space bounding box (spatial index + dirty)
 *   - `hitTest(obj,p)`  answer "is this point on me?" precisely (optional)
 *   - `draw(g,obj,env)` paint it onto a 2D context
 *   - `layer`           which render layer it belongs to by default
 *
 * This split is what makes the engine pluggable: a new feature (OCR text runs,
 * an AI suggestion overlay, a signature field, a redaction box) ships a type
 * definition and immediately gains storage, hit testing, spatial indexing,
 * layered rendering, selection and undo/redo — without touching the core.
 *
 * Objects are intentionally flat and serialisable so save/export, undo/redo and
 * eventual PDF round-tripping stay simple:
 *
 *   {
 *     id, type, layer, x, y, width, height,
 *     rotation, opacity, z, locked, hidden,
 *     data: { ...type-specific fields }
 *   }
 */

import { nextObjectId } from './ids.js';
import { rectContainsPoint, rotatePoint, rectCenter, distanceToSegment } from './geometry.js';
import { LAYERS } from './layers.js';

/**
 * Create a registry of object types. One is owned by each engine instance, so
 * plugins can register types without leaking into other documents/tabs.
 */
export function createObjectModel() {
  /** @type {Map<string, object>} */
  const types = new Map();

  /**
   * Register a type definition. `partial` may omit any behaviour hook; sensible
   * axis-aligned-box defaults are filled in so a minimal `{ type }` still works.
   */
  function register(def) {
    if (!def || !def.type) throw new Error('Object type needs a `type`');
    if (types.has(def.type)) throw new Error(`Duplicate object type: ${def.type}`);
    types.set(def.type, {
      type: def.type,
      layer: def.layer || LAYERS.CONTENT,
      // How much to inflate the hit box (px) so thin/interactive objects are grabbable.
      hitTolerance: def.hitTolerance ?? 3,
      create: def.create || ((props) => ({ ...props })),
      bounds: def.bounds || defaultBounds,
      hitTest: def.hitTest || null, // null → fall back to (rotated) bounds test
      draw: def.draw || (() => {}),
      // Optional: serialise/clone hooks for types holding non-JSON data.
      clone: def.clone || null,
    });
    return types.get(def.type);
  }

  function get(type) {
    return types.get(type);
  }

  function has(type) {
    return types.has(type);
  }

  /**
   * Build a complete object of `type` from partial props. The registered type
   * gets to shape its own `data`; the engine owns the common envelope so every
   * object is spatially indexable and renderable the moment it exists.
   */
  function create(type, props = {}) {
    const def = types.get(type);
    if (!def) throw new Error(`Unknown object type: ${type}`);
    const built = def.create(props) || {};
    return {
      id: props.id || nextObjectId(),
      type,
      layer: props.layer || built.layer || def.layer,
      x: built.x ?? props.x ?? 0,
      y: built.y ?? props.y ?? 0,
      width: built.width ?? props.width ?? 0,
      height: built.height ?? props.height ?? 0,
      rotation: built.rotation ?? props.rotation ?? 0,
      opacity: built.opacity ?? props.opacity ?? 1,
      z: props.z ?? 0,
      locked: props.locked ?? false,
      hidden: props.hidden ?? false,
      data: built.data ?? props.data ?? {},
    };
  }

  /** Page-space bounding box of an object, via its type (defaults to its box). */
  function bounds(obj) {
    const def = types.get(obj.type);
    return (def?.bounds || defaultBounds)(obj);
  }

  /**
   * Precise hit test. Uses the type's own `hitTest` when provided (e.g. a line
   * only hits near the stroke); otherwise tests the object's box, honouring
   * rotation by mapping the point back into the object's local frame.
   */
  function hitTest(obj, point) {
    if (obj.hidden) return false;
    const def = types.get(obj.type);
    if (def?.hitTest) return def.hitTest(obj, point, def);
    const tol = def?.hitTolerance ?? 0;
    const local = obj.rotation
      ? rotatePoint(point, rectCenter(obj), -obj.rotation)
      : point;
    return rectContainsPoint(
      { x: obj.x - tol, y: obj.y - tol, width: obj.width + tol * 2, height: obj.height + tol * 2 },
      local
    );
  }

  /** Paint an object, applying the common envelope (opacity/rotation) once. */
  function draw(g, obj, env = {}) {
    if (obj.hidden) return;
    const def = types.get(obj.type);
    if (!def) return;
    g.save();
    if (obj.opacity != null && obj.opacity < 1) g.globalAlpha = obj.opacity;
    if (obj.rotation) {
      const c = rectCenter(obj);
      g.translate(c.x, c.y);
      g.rotate((obj.rotation * Math.PI) / 180);
      g.translate(-c.x, -c.y);
    }
    def.draw(g, obj, env);
    g.restore();
  }

  return { register, get, has, create, bounds, hitTest, draw, types };
}

/** Default bounds: the stored box (rotation is handled by callers via geometry). */
function defaultBounds(obj) {
  return { x: obj.x, y: obj.y, width: obj.width, height: obj.height };
}

/* -------------------------------------------------------------------------- *
 * Core object types.
 *
 * These cover the categories the product already exposes as tools. They are the
 * reference implementations plugins imitate. Rendering here is deliberately
 * lightweight — the point is a correct, hit-testable, indexable model, not a
 * finished visual design.
 * -------------------------------------------------------------------------- */

/** Register the built-in types onto a model. Called once at engine construction. */
export function registerCoreTypes(model) {
  // --- Text box -----------------------------------------------------------
  model.register({
    type: 'text',
    layer: LAYERS.CONTENT,
    create: (p) => ({
      width: p.width ?? 220,
      height: p.height ?? 40,
      data: {
        content: p.content ?? '',
        font: p.font ?? 'Inter',
        fontSize: p.fontSize ?? 16,
        color: p.color ?? '#1a1c2e',
        align: p.align ?? 'left',
        style: p.style ?? [], // ['bold','italic','underline']
      },
    }),
    draw: (g, obj) => {
      const d = obj.data;
      const weight = d.style?.includes('bold') ? '600' : '400';
      const italic = d.style?.includes('italic') ? 'italic ' : '';
      g.fillStyle = d.color;
      g.font = `${italic}${weight} ${d.fontSize}px ${d.font}, sans-serif`;
      g.textBaseline = 'top';
      g.textAlign = d.align === 'center' ? 'center' : d.align === 'right' ? 'right' : 'left';
      const tx = d.align === 'center' ? obj.x + obj.width / 2 : d.align === 'right' ? obj.x + obj.width : obj.x;
      // Simple line wrapping so large text blocks stay inside their box.
      wrapText(g, d.content, tx, obj.y, obj.width, d.fontSize * 1.35);
    },
  });

  // --- Raster image -------------------------------------------------------
  model.register({
    type: 'image',
    layer: LAYERS.CONTENT,
    create: (p) => ({
      width: p.width ?? 160,
      height: p.height ?? 120,
      data: { src: p.src ?? null, fit: p.fit ?? 'contain' },
    }),
    draw: (g, obj, env) => {
      const img = env.resolveImage?.(obj.data.src);
      if (img && img.complete && img.naturalWidth) {
        g.drawImage(img, obj.x, obj.y, obj.width, obj.height);
      } else {
        // Placeholder box until the bitmap is decoded (env re-marks dirty on load).
        g.fillStyle = '#eef0f6';
        g.fillRect(obj.x, obj.y, obj.width, obj.height);
      }
    },
  });

  // --- Vector shape (rect / ellipse / line / arrow) -----------------------
  model.register({
    type: 'shape',
    layer: LAYERS.ANNOTATION,
    hitTolerance: 4,
    create: (p) => ({
      width: p.width ?? 120,
      height: p.height ?? 80,
      data: {
        kind: p.kind ?? 'rect',
        fill: p.fill ?? '#6366f1',
        stroke: p.stroke ?? '#4f46e5',
        strokeWidth: p.strokeWidth ?? 2,
      },
    }),
    hitTest: (obj, point, def) => shapeHitTest(obj, point, def.hitTolerance),
    draw: (g, obj) => drawShape(g, obj),
  });

  // --- Freehand ink / highlighter ----------------------------------------
  model.register({
    type: 'ink',
    layer: LAYERS.MARKUP,
    hitTolerance: 6,
    create: (p) => ({
      // Bounds are derived from the point list by the caller (recomputeInkBounds).
      x: p.x ?? 0,
      y: p.y ?? 0,
      width: p.width ?? 0,
      height: p.height ?? 0,
      data: {
        points: p.points ?? [], // [{x,y}, …] in page space
        color: p.color ?? '#ef4444',
        size: p.size ?? 4,
        highlighter: p.highlighter ?? false,
      },
    }),
    hitTest: (obj, point, def) => inkHitTest(obj, point, def.hitTolerance),
    draw: (g, obj) => drawInk(g, obj),
  });

  // --- Sticky/text annotation box (border + tint) ------------------------
  model.register({
    type: 'annotation',
    layer: LAYERS.MARKUP,
    create: (p) => ({
      width: p.width ?? 180,
      height: p.height ?? 60,
      data: { color: p.color ?? '#f59e0b', note: p.note ?? '' },
    }),
    draw: (g, obj) => {
      g.fillStyle = hexToRgba(obj.data.color, 0.14);
      g.strokeStyle = obj.data.color;
      g.lineWidth = 1.5;
      g.fillRect(obj.x, obj.y, obj.width, obj.height);
      g.strokeRect(obj.x, obj.y, obj.width, obj.height);
    },
  });

  // --- Signature (drawn/typed/uploaded ink or bitmap) --------------------
  model.register({
    type: 'signature',
    layer: LAYERS.CONTENT,
    create: (p) => ({
      width: p.width ?? 200,
      height: p.height ?? 80,
      data: {
        mode: p.mode ?? 'draw', // 'draw' | 'type' | 'upload'
        strokes: p.strokes ?? [], // array of point arrays for drawn signatures
        src: p.src ?? null, // bitmap for uploaded signatures
        text: p.text ?? '',
        color: p.color ?? '#1a1c2e',
      },
    }),
    draw: (g, obj, env) => drawSignature(g, obj, env),
  });

  // --- Comment pin (anchor for a threaded discussion) --------------------
  model.register({
    type: 'comment',
    layer: LAYERS.MARKUP,
    hitTolerance: 8,
    create: (p) => ({
      width: 26,
      height: 26,
      data: { color: p.color ?? '#f59e0b', thread: p.thread ?? [], resolved: false },
    }),
    hitTest: (obj, point) => {
      const c = rectCenter(obj);
      return Math.hypot(point.x - c.x, point.y - c.y) <= obj.width / 2 + 4;
    },
    draw: (g, obj) => {
      const c = rectCenter(obj);
      g.fillStyle = obj.data.resolved ? '#9aa0b8' : obj.data.color;
      g.beginPath();
      g.arc(c.x, c.y, obj.width / 2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = '600 13px Inter, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(obj.data.thread?.length || ''), c.x, c.y + 0.5);
    },
  });

  // --- Form field (text input / checkbox / signature slot) ---------------
  model.register({
    type: 'formField',
    layer: LAYERS.ANNOTATION,
    create: (p) => ({
      width: p.width ?? 180,
      height: p.height ?? 32,
      data: {
        field: p.field ?? 'text', // 'text' | 'checkbox' | 'signature'
        name: p.name ?? '',
        value: p.value ?? '',
        required: p.required ?? false,
      },
    }),
    draw: (g, obj) => {
      g.strokeStyle = '#6366f1';
      g.setLineDash([4, 3]);
      g.lineWidth = 1.5;
      g.strokeRect(obj.x + 0.5, obj.y + 0.5, obj.width - 1, obj.height - 1);
      g.setLineDash([]);
    },
  });

  return model;
}

/* ------------------------------- helpers -------------------------------- */

/** Recompute an ink object's box from its points. Keeps the index accurate. */
export function recomputeInkBounds(obj) {
  const pts = obj.data.points;
  if (!pts || !pts.length) return obj;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = obj.data.size / 2 + 1;
  obj.x = minX - pad;
  obj.y = minY - pad;
  obj.width = maxX - minX + pad * 2;
  obj.height = maxY - minY + pad * 2;
  return obj;
}

function shapeHitTest(obj, point, tol) {
  const { kind } = obj.data;
  const local = obj.rotation ? rotatePoint(point, rectCenter(obj), -obj.rotation) : point;
  if (kind === 'line' || kind === 'arrow') {
    const a = { x: obj.x, y: obj.y };
    const b = { x: obj.x + obj.width, y: obj.y + obj.height };
    return distanceToSegment(local, a, b) <= (obj.data.strokeWidth || 1) / 2 + tol;
  }
  const box = { x: obj.x - tol, y: obj.y - tol, width: obj.width + tol * 2, height: obj.height + tol * 2 };
  if (!rectContainsPoint(box, local)) return false;
  if (kind === 'ellipse') {
    const c = rectCenter(obj);
    const rx = obj.width / 2 + tol;
    const ry = obj.height / 2 + tol;
    const nx = (local.x - c.x) / (rx || 1);
    const ny = (local.y - c.y) / (ry || 1);
    return nx * nx + ny * ny <= 1;
  }
  return true;
}

function drawShape(g, obj) {
  const d = obj.data;
  g.fillStyle = d.fill;
  g.strokeStyle = d.stroke;
  g.lineWidth = d.strokeWidth;
  switch (d.kind) {
    case 'ellipse': {
      const c = rectCenter(obj);
      g.beginPath();
      g.ellipse(c.x, c.y, obj.width / 2, obj.height / 2, 0, 0, Math.PI * 2);
      g.fill();
      if (d.strokeWidth) g.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      const a = { x: obj.x, y: obj.y };
      const b = { x: obj.x + obj.width, y: obj.y + obj.height };
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.stroke();
      if (d.kind === 'arrow') drawArrowHead(g, a, b, d.strokeWidth);
      break;
    }
    default: {
      g.fillRect(obj.x, obj.y, obj.width, obj.height);
      if (d.strokeWidth) g.strokeRect(obj.x, obj.y, obj.width, obj.height);
    }
  }
}

function drawArrowHead(g, from, to, w) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const len = 8 + w * 2;
  g.beginPath();
  g.moveTo(to.x, to.y);
  g.lineTo(to.x - len * Math.cos(angle - Math.PI / 7), to.y - len * Math.sin(angle - Math.PI / 7));
  g.lineTo(to.x - len * Math.cos(angle + Math.PI / 7), to.y - len * Math.sin(angle + Math.PI / 7));
  g.closePath();
  g.fillStyle = g.strokeStyle;
  g.fill();
}

function inkHitTest(obj, point, tol) {
  const pts = obj.data.points;
  const reach = obj.data.size / 2 + tol;
  for (let i = 1; i < pts.length; i += 1) {
    if (distanceToSegment(point, pts[i - 1], pts[i]) <= reach) return true;
  }
  return pts.length === 1 ? Math.hypot(point.x - pts[0].x, point.y - pts[0].y) <= reach : false;
}

function drawInk(g, obj) {
  const d = obj.data;
  const pts = d.points;
  if (!pts.length) return;
  g.strokeStyle = d.color;
  g.lineWidth = d.size;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  if (d.highlighter) {
    g.globalCompositeOperation = 'multiply';
  }
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) g.lineTo(pts[i].x, pts[i].y);
  g.stroke();
}

function drawSignature(g, obj, env) {
  const d = obj.data;
  if (d.mode === 'upload' && d.src) {
    const img = env.resolveImage?.(d.src);
    if (img && img.complete) g.drawImage(img, obj.x, obj.y, obj.width, obj.height);
    return;
  }
  if (d.mode === 'type') {
    g.fillStyle = d.color;
    g.font = `italic 600 ${Math.min(obj.height * 0.7, 40)}px Georgia, serif`;
    g.textBaseline = 'middle';
    g.fillText(d.text || 'Signature', obj.x, obj.y + obj.height / 2);
    return;
  }
  // Drawn: replay stroke paths, scaled into the object box.
  g.strokeStyle = d.color;
  g.lineWidth = 2.2;
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (const stroke of d.strokes || []) {
    if (!stroke.length) continue;
    g.beginPath();
    g.moveTo(obj.x + stroke[0].x * obj.width, obj.y + stroke[0].y * obj.height);
    for (let i = 1; i < stroke.length; i += 1) {
      g.lineTo(obj.x + stroke[i].x * obj.width, obj.y + stroke[i].y * obj.height);
    }
    g.stroke();
  }
}

function wrapText(g, text, x, y, maxWidth, lineHeight) {
  if (!text) return;
  for (const paragraph of String(text).split('\n')) {
    const words = paragraph.split(' ');
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (g.measureText(test).width > maxWidth && line) {
        g.fillText(line, x, y);
        line = word;
        y += lineHeight;
      } else {
        line = test;
      }
    }
    g.fillText(line, x, y);
    y += lineHeight;
  }
}

/** Expand a #rrggbb colour to an rgba() string at the given alpha. */
export function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
