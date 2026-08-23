/**
 * Geometry primitives for the document engine.
 *
 * Everything in the engine speaks the same coordinate language: **page space**,
 * a top-left origin measured in the page's own CSS pixels (the same units the
 * canvas `drawPage` already uses). Zoom and device-pixel-ratio are applied by
 * the renderer, never stored on objects — so an object's geometry is stable no
 * matter how the page is displayed.
 *
 * These are pure, allocation-light functions. They are the shared foundation
 * for hit testing, selection bounds, dirty-region tracking and transforms, so
 * they are kept dependency-free and side-effect-free.
 *
 * Shapes:
 *   Point = { x, y }
 *   Rect  = { x, y, width, height }   // x,y is the top-left corner
 */

/** @typedef {{x:number, y:number}} Point */
/** @typedef {{x:number, y:number, width:number, height:number}} Rect */

/** Construct a rect, normalising negative width/height to a top-left origin. */
export function rect(x, y, width, height) {
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }
  return { x, y, width, height };
}

/** A rect spanning two arbitrary corner points (used for marquee/drag boxes). */
export function rectFromPoints(a, b) {
  return rect(a.x, a.y, b.x - a.x, b.y - a.y);
}

/** True if a point falls inside (or on the edge of) a rect. */
export function rectContainsPoint(r, p) {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/** True if two rects overlap at all (touching edges count as overlap). */
export function rectsIntersect(a, b) {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}

/** True if `outer` fully contains `inner` (used by marquee "enclose" selection). */
export function rectContainsRect(outer, inner) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** The smallest rect containing both inputs. Either argument may be null. */
export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** The overlap of two rects, or null when they do not intersect. */
export function intersectRect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** Grow a rect outwards by `amount` on every side (for hit tolerance / handles). */
export function inflateRect(r, amount) {
  return { x: r.x - amount, y: r.y - amount, width: r.width + amount * 2, height: r.height + amount * 2 };
}

/** Snap a rect outwards to whole pixels — the renderer clears on integer bounds. */
export function roundRectOut(r) {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return {
    x,
    y,
    width: Math.ceil(r.x + r.width) - x,
    height: Math.ceil(r.y + r.height) - y,
  };
}

/** The centre point of a rect. */
export function rectCenter(r) {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/** Rotate a point around a pivot by `deg` degrees (clockwise in screen space). */
export function rotatePoint(p, pivot, deg) {
  if (!deg) return { x: p.x, y: p.y };
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - pivot.x;
  const dy = p.y - pivot.y;
  return {
    x: pivot.x + dx * cos - dy * sin,
    y: pivot.y + dx * sin + dy * cos,
  };
}

/**
 * The axis-aligned bounding box of a rect after it is rotated about its centre.
 * The engine stores un-rotated boxes; this expands them so the spatial index and
 * dirty tracker cover the actual painted footprint of a rotated object.
 */
export function rotatedBounds(r, deg) {
  if (!deg) return { ...r };
  const c = rectCenter(r);
  const corners = [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height },
  ].map((p) => rotatePoint(p, c, deg));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of corners) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Shortest distance from a point to a line segment (for line/ink hit testing). */
export function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Clamp helper (mirrors utils/format so the engine stays self-contained). */
export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}
