import { fields } from './shared.js';

/**
 * Page-level operations. These act on the document structure rather than
 * drawing on the canvas. They present their options here and will run through
 * history commands once implemented.
 */
export default [
  {
    id: 'merge',
    label: 'Merge',
    group: 'pages',
    icon: 'merge',
    cursor: 'default',
    properties: [
      fields.heading('Merge'),
      fields.note('Add more PDFs or images to append their pages to this document.'),
      fields.button('Add files to merge', 'open'),
    ],
  },
  {
    id: 'split',
    label: 'Split',
    group: 'pages',
    icon: 'split',
    cursor: 'default',
    properties: [
      fields.heading('Split'),
      fields.segment(
        'mode',
        'Split by',
        [
          { value: 'range', label: 'Ranges' },
          { value: 'every', label: 'Every N' },
        ],
        'range'
      ),
      { type: 'text', key: 'ranges', label: 'Page ranges', placeholder: 'e.g. 1-3, 5, 8-10', default: '' },
      fields.button('Split document', 'split-run'),
    ],
  },
  {
    id: 'compress',
    label: 'Compress',
    group: 'pages',
    icon: 'compress',
    cursor: 'default',
    properties: [
      fields.heading('Compress'),
      fields.select(
        'quality',
        'Quality',
        [
          { value: 'low', label: 'Smallest file' },
          { value: 'balanced', label: 'Recommended' },
          { value: 'high', label: 'Best quality' },
        ],
        'balanced'
      ),
      fields.button('Compress document', 'compress-run'),
    ],
  },
  {
    id: 'rotate',
    label: 'Rotate',
    group: 'pages',
    icon: 'rotate',
    cursor: 'default',
    properties: [
      fields.heading('Rotate'),
      fields.segment(
        'scope',
        'Apply to',
        [
          { value: 'current', label: 'Current page' },
          { value: 'all', label: 'All pages' },
        ],
        'current'
      ),
      fields.button('Rotate 90° left', 'rotate-left', { variant: 'ghost' }),
      fields.button('Rotate 90° right', 'rotate-right', { variant: 'ghost' }),
    ],
  },
  {
    id: 'delete-pages',
    label: 'Delete',
    group: 'pages',
    icon: 'delete-pages',
    cursor: 'default',
    properties: [
      fields.heading('Delete pages'),
      fields.note('Select pages in the canvas, then remove them from the document.'),
      fields.button('Delete selected pages', 'delete-pages-run', { variant: 'ghost' }),
    ],
  },
  {
    id: 'reorder-pages',
    label: 'Reorder',
    group: 'pages',
    icon: 'reorder-pages',
    cursor: 'default',
    properties: [
      fields.heading('Reorder pages'),
      fields.note('Drag page thumbnails to rearrange the document order.'),
    ],
  },
  {
    id: 'extract-pages',
    label: 'Extract',
    group: 'pages',
    icon: 'extract-pages',
    cursor: 'default',
    properties: [
      fields.heading('Extract pages'),
      { type: 'text', key: 'ranges', label: 'Pages to extract', placeholder: 'e.g. 2, 4-6', default: '' },
      fields.button('Extract to new file', 'extract-run'),
    ],
  },
];
