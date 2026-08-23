/**
 * Built-in contextual property providers.
 *
 * These are the panels the right sidebar shows based on the current selection.
 * They are intentionally workspace-agnostic — a "text" selection shows the same
 * typography controls whether it came from a PDF or a Document. Each provider
 * returns a declarative schema (rendered by shell/controls.js); wiring the
 * `onChange` back into a real object model is a NEXT-PHASE concern, so for now
 * changes simply echo a toast so the panel is demonstrably live.
 *
 * Add a provider here (or from a workspace) to support a new selection kind.
 */
import { SelectionKind } from '../core/selection.js';

const f = {
  heading: (text) => ({ type: 'heading', text }),
  note: (text) => ({ type: 'note', text }),
  select: (key, label, options, def) => ({ type: 'select', key, label, options, default: def }),
  range: (key, label, min, max, def, unit, step) => ({ type: 'range', key, label, min, max, default: def, unit, step }),
  number: (key, label, def, min, max) => ({ type: 'number', key, label, default: def, min, max }),
  color: (key, label, def) => ({ type: 'color', key, label, default: def }),
  segment: (key, label, options, def, multiple, className) => ({ type: 'segment', key, label, options, default: def, multiple, className }),
  text: (key, label, placeholder) => ({ type: 'text', key, label, placeholder }),
  checkbox: (key, label, def) => ({ type: 'checkbox', key, label, default: def }),
  button: (action, label, variant) => ({ type: 'button', action, label, variant }),
};

/** Advanced text controls — shown when a text object/run is selected. The most
 *  used controls (font, size, B/I/U/S, colour, alignment) live in the top
 *  contextual formatting bar (see blankEditorShell.js), so this panel keeps only
 *  the advanced settings that would otherwise clutter fast editing. */
const textProvider = {
  kind: SelectionKind.TEXT,
  title: 'Text',
  subtitle: 'Advanced text',
  icon: 'text',
  schema: () => [
    f.heading('Typography'),
    f.color('highlight', 'Highlight', '#ffe64d'),
    f.select('textCase', 'Case', [
      { value: 'none', label: 'Normal' },
      { value: 'uppercase', label: 'UPPERCASE' },
      { value: 'lowercase', label: 'lowercase' },
      { value: 'capitalize', label: 'Capitalize' },
    ], 'none'),
    f.heading('Paragraph'),
    f.range('lineHeight', 'Line height', 1, 3, 1.4, '×', 0.1),
    f.range('letterSpacing', 'Letter spacing', -2, 10, 0, 'px', 0.5),
    f.heading('Appearance'),
    f.range('opacity', 'Opacity', 0, 100, 100, '%'),
    f.number('rotation', 'Rotation', 0, -360, 360),
  ],
};

/** Curated professional font list — system faces plus the web fonts loaded in
 *  the workspace layout. Kept here so the picker and any inline UI share it. */
export const FONT_OPTIONS = [
  { value: 'Inter', label: 'Inter' },
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { value: 'Helvetica, Arial, sans-serif', label: 'Helvetica' },
  { value: "'Times New Roman', Times, serif", label: 'Times New Roman' },
  { value: 'Georgia, serif', label: 'Georgia' },
  { value: 'Calibri, "Segoe UI", sans-serif', label: 'Calibri' },
  { value: '"Courier New", Courier, monospace', label: 'Courier New' },
  { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { value: 'Tahoma, Geneva, sans-serif', label: 'Tahoma' },
  { value: '"Trebuchet MS", sans-serif', label: 'Trebuchet MS' },
  { value: 'Roboto, sans-serif', label: 'Roboto' },
  { value: 'Poppins, sans-serif', label: 'Poppins' },
  { value: '"Open Sans", sans-serif', label: 'Open Sans' },
  { value: 'Lato, sans-serif', label: 'Lato' },
  { value: 'Montserrat, sans-serif', label: 'Montserrat' },
  { value: 'Nunito, sans-serif', label: 'Nunito' },
  { value: 'Merriweather, serif', label: 'Merriweather' },
  { value: 'Sora, sans-serif', label: 'Sora' },
];

/** Image controls — shown when an image object is selected. */
const imageProvider = {
  kind: SelectionKind.IMAGE,
  title: 'Image',
  subtitle: 'Image properties',
  icon: 'image',
  schema: () => [
    // Pick a new file → crop it → drop it into the selected image's exact slot;
    // the engine keeps the box's position, size, rotation and page, so there's no
    // manual re-fitting (PowerPoint's "Change Picture").
    f.button('replace-image', 'Replace Image'),
    // Interactive marquee crop: drag a frame over the image, then Apply.
    f.button('crop-image', 'Crop Image'),
    f.heading('Size & position'),
    f.number('width', 'Width', 320, 1),
    f.number('height', 'Height', 240, 1),
    f.checkbox('lockAspect', 'Lock aspect ratio', true),
    f.number('rotation', 'Rotation', 0, -360, 360),
    f.heading('Appearance'),
    f.range('opacity', 'Opacity', 0, 100, 100, '%'),
    f.range('radius', 'Corner radius', 0, 200, 0, 'px'),
    f.select('fit', 'Fit', [
      { value: 'contain', label: 'Contain' },
      { value: 'cover', label: 'Cover' },
      { value: 'fill', label: 'Fill' },
    ], 'contain'),
  ],
};

/** Shape controls — shown when a shape / drawing object is selected. */
const shapeProvider = {
  kind: 'shape',
  title: 'Shape',
  subtitle: 'Shape properties',
  icon: 'shapes',
  schema: () => [
    f.heading('Shape'),
    // A curated set of the annotation shapes that cover the vast majority of
    // PDF editing use cases — deliberately not a full vector-design palette.
    f.select('shapeType', 'Type', [
      { value: 'rect', label: 'Rectangle' },
      { value: 'roundRect', label: 'Rounded Rectangle' },
      { value: 'circle', label: 'Circle' },
      { value: 'ellipse', label: 'Ellipse' },
      { value: 'triangle', label: 'Triangle' },
      { value: 'diamond', label: 'Diamond' },
      { value: 'line', label: 'Line' },
      { value: 'arrow', label: 'Arrow' },
      { value: 'doubleArrow', label: 'Double Arrow' },
      { value: 'speech', label: 'Speech Bubble' },
      { value: 'star', label: 'Star' },
      { value: 'heart', label: 'Heart' },
    ], 'rect'),
    f.color('fill', 'Fill', '#e0e7ff'),
    f.color('stroke', 'Border', '#4f46e5'),
    f.number('strokeWidth', 'Border width', 1.5, 0, 40),
    f.range('radius', 'Corner radius', 0, 200, 4, 'px'),
    f.range('opacity', 'Opacity', 0, 100, 100, '%'),
  ],
};

/** Stamp controls — shown when a stamp object is selected. Stamps resize with a
 *  locked aspect ratio, so size lives on the handles; the panel owns colour,
 *  opacity and rotation. */
const stampProvider = {
  kind: 'stamp',
  title: 'Stamp',
  subtitle: 'Stamp properties',
  icon: 'stamp',
  schema: () => [
    f.heading('Appearance'),
    f.color('color', 'Colour', '#dc2626'),
    f.range('opacity', 'Opacity', 0, 100, 100, '%'),
    f.number('rotation', 'Rotation', 0, -360, 360),
  ],
};

/** Page controls — shown when a PDF/document page is selected. */
const pageProvider = {
  kind: SelectionKind.PAGE,
  title: 'Page',
  subtitle: 'Page properties',
  icon: 'document',
  schema: (descriptor) => [
    f.heading('Page'),
    f.note(descriptor?.label ? `Selected: ${descriptor.label}` : 'A page is selected.'),
    f.select('size', 'Size', [
      { value: 'A4', label: 'A4' },
      { value: 'Letter', label: 'Letter' },
      { value: 'Legal', label: 'Legal' },
      { value: 'custom', label: 'Custom' },
    ], 'A4'),
    f.segment('orientation', 'Orientation', [
      { value: 'portrait', label: 'Portrait' },
      { value: 'landscape', label: 'Landscape' },
    ], 'portrait'),
    f.number('rotation', 'Rotation', 0, -270, 270),
    f.color('background', 'Background', '#ffffff'),
    f.heading('Margins'),
    f.range('margin', 'All margins', 0, 96, 24, 'px'),
  ],
};

/** Document properties — the default panel when nothing is selected. */
const documentProvider = {
  kind: SelectionKind.NONE,
  title: 'Document',
  subtitle: 'Document properties',
  icon: 'document',
  schema: () => [
    f.heading('Document'),
    f.text('title', 'Title', 'Untitled'),
    f.text('author', 'Author'),
    f.heading('Canvas'),
    f.select('pageSize', 'Page size', [
      { value: 'A4', label: 'A4' },
      { value: 'Letter', label: 'Letter' },
      { value: 'Legal', label: 'Legal' },
    ], 'A4'),
    f.color('background', 'Background', '#ffffff'),
    f.note('Select an object on the canvas to edit its properties here.'),
  ],
};

export const builtinPropertyProviders = [
  documentProvider, // 'none' — keep first so it is the guaranteed fallback
  textProvider,
  imageProvider,
  shapeProvider,
  stampProvider,
  pageProvider,
];
