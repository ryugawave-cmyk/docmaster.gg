/** Formatting and math helpers. */

/** Human-readable byte size. */
export function formatBytes(bytes) {
  if (!bytes || bytes < 1) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const decimals = value < 10 && i > 0 && !Number.isInteger(value) ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[i]}`;
}

/** Clamp a number to the inclusive range [min, max]. */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Format a 0..1 zoom factor as a percentage string. */
export function formatZoom(zoom) {
  return `${Math.round(zoom * 100)}%`;
}
