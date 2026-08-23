/**
 * Reusable property-control descriptors shared across tool definitions.
 *
 * The properties panel renders these declaratively, so a tool describes its
 * controls as data instead of building DOM. Supported control `type`s:
 *   heading | note | select | number | range | color | segment | text |
 *   textarea | password | checkbox | button
 */

export const fields = {
  heading: (text) => ({ type: 'heading', text }),
  note: (text) => ({ type: 'note', text }),

  opacity: (def = 100) => ({
    type: 'range',
    key: 'opacity',
    label: 'Opacity',
    min: 0,
    max: 100,
    step: 1,
    unit: '%',
    default: def,
  }),

  color: (key = 'color', label = 'Color', def = '#1a1c2e') => ({
    type: 'color',
    key,
    label,
    default: def,
  }),

  fill: (def = '#6366f1') => ({ type: 'color', key: 'fill', label: 'Fill', default: def }),
  stroke: (def = '#1a1c2e') => ({ type: 'color', key: 'stroke', label: 'Stroke', default: def }),

  strokeWidth: (def = 2) => ({
    type: 'range',
    key: 'strokeWidth',
    label: 'Stroke width',
    min: 0,
    max: 24,
    step: 1,
    unit: 'px',
    default: def,
  }),

  size: (def = 6, max = 60) => ({
    type: 'range',
    key: 'size',
    label: 'Size',
    min: 1,
    max,
    step: 1,
    unit: 'px',
    default: def,
  }),

  select: (key, label, options, def) => ({
    type: 'select',
    key,
    label,
    options,
    default: def ?? options[0]?.value,
  }),

  segment: (key, label, options, def) => ({
    type: 'segment',
    key,
    label,
    options,
    default: def ?? options[0]?.value,
  }),

  button: (label, action, opts = {}) => ({ type: 'button', label, action, ...opts }),
};

export const FONT_OPTIONS = [
  { value: 'Inter', label: 'Inter' },
  { value: 'Arial', label: 'Arial' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Times New Roman', label: 'Times New Roman' },
  { value: 'Courier New', label: 'Courier New' },
];

export const ALIGN_OPTIONS = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
  { value: 'justify', label: 'Justify' },
];
