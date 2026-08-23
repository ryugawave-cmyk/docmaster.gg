import { fields, FONT_OPTIONS, ALIGN_OPTIONS } from './shared.js';

/** Annotation / creation tools that add content to a page. */
export default [
  {
    id: 'text',
    label: 'Text',
    group: 'annotate',
    icon: 'text',
    cursor: 'text',
    shortcut: 'T',
    properties: [
      fields.heading('Text'),
      fields.select('font', 'Font', FONT_OPTIONS, 'Inter'),
      { type: 'number', key: 'fontSize', label: 'Size', min: 6, max: 200, step: 1, unit: 'px', default: 16 },
      {
        type: 'segment',
        key: 'style',
        label: 'Style',
        multiple: true,
        options: [
          { value: 'bold', label: 'B' },
          { value: 'italic', label: 'I' },
          { value: 'underline', label: 'U' },
        ],
        default: [],
      },
      fields.heading('Appearance'),
      fields.color('color', 'Color', '#1a1c2e'),
      fields.segment('align', 'Alignment', ALIGN_OPTIONS, 'left'),
      fields.opacity(),
      fields.note('Click on the page to add a text box.'),
    ],
  },
  {
    id: 'image',
    label: 'Image',
    group: 'annotate',
    icon: 'image',
    cursor: 'crosshair',
    shortcut: 'I',
    properties: [
      fields.heading('Image'),
      fields.select(
        'fit',
        'Fit',
        [
          { value: 'contain', label: 'Contain' },
          { value: 'cover', label: 'Cover' },
          { value: 'stretch', label: 'Stretch' },
        ],
        'contain'
      ),
      fields.opacity(),
      fields.button('Choose image', 'open', { variant: 'ghost' }),
      fields.note('Place an image, then drag to position and resize it.'),
    ],
  },
  {
    id: 'shapes',
    label: 'Shapes',
    group: 'annotate',
    icon: 'shapes',
    cursor: 'crosshair',
    shortcut: 'S',
    properties: [
      fields.heading('Shape'),
      fields.segment(
        'shape',
        'Type',
        [
          { value: 'rect', label: 'Rectangle' },
          { value: 'ellipse', label: 'Ellipse' },
          { value: 'line', label: 'Line' },
          { value: 'arrow', label: 'Arrow' },
        ],
        'rect'
      ),
      fields.heading('Appearance'),
      fields.fill('#6366f1'),
      fields.stroke('#4f46e5'),
      fields.strokeWidth(2),
      fields.opacity(),
    ],
  },
  {
    id: 'draw',
    label: 'Draw',
    group: 'annotate',
    icon: 'draw',
    cursor: 'crosshair',
    shortcut: 'P',
    properties: [
      fields.heading('Freehand'),
      fields.color('color', 'Color', '#ef4444'),
      fields.size(4, 40),
      fields.opacity(),
    ],
  },
  {
    id: 'highlight',
    label: 'Highlight',
    group: 'annotate',
    icon: 'highlight',
    cursor: 'crosshair',
    shortcut: 'U',
    properties: [
      fields.heading('Highlighter'),
      fields.color('color', 'Color', '#ffd54a'),
      fields.size(14, 48),
      fields.opacity(40),
    ],
  },
  {
    id: 'eraser',
    label: 'Eraser',
    group: 'annotate',
    icon: 'eraser',
    cursor: 'crosshair',
    shortcut: 'E',
    properties: [
      fields.heading('Eraser'),
      fields.size(16, 80),
      fields.note('Drag over annotations to remove them. Does not affect the original document.'),
    ],
  },
  {
    id: 'comments',
    label: 'Comment',
    group: 'annotate',
    icon: 'comments',
    cursor: 'crosshair',
    shortcut: 'C',
    properties: [
      fields.heading('Comments'),
      fields.color('color', 'Pin color', '#f59e0b'),
      fields.note('Click anywhere to drop a comment pin and start a thread.'),
    ],
  },
  {
    id: 'signature',
    label: 'Sign',
    group: 'annotate',
    icon: 'signature',
    cursor: 'crosshair',
    properties: [
      fields.heading('Signature'),
      fields.segment(
        'mode',
        'Create with',
        [
          { value: 'draw', label: 'Draw' },
          { value: 'type', label: 'Type' },
          { value: 'upload', label: 'Upload' },
        ],
        'draw'
      ),
      fields.color('color', 'Ink', '#1a1c2e'),
      fields.note('Create your signature once, then place it on any page.'),
    ],
  },
];
