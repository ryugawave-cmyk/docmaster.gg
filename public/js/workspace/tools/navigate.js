import { fields } from './shared.js';

/** Navigation tools: selecting and panning. */
export default [
  {
    id: 'selection',
    label: 'Select',
    group: 'navigate',
    icon: 'selection',
    cursor: 'default',
    shortcut: 'V',
    properties: [
      fields.heading('Selection'),
      fields.note('Click objects to select, move and resize them. Drag on an empty area to marquee-select.'),
    ],
  },
  {
    id: 'hand',
    label: 'Hand',
    group: 'navigate',
    icon: 'hand',
    cursor: 'grab',
    shortcut: 'H',
    properties: [
      fields.heading('Hand'),
      fields.note('Drag to pan around the document. Tip: hold Space with any tool to pan temporarily.'),
    ],
  },
];
