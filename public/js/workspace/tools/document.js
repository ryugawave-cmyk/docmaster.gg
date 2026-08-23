import { fields } from './shared.js';

/** Whole-document operations: watermark, protection, OCR and AI. */
export default [
  {
    id: 'watermark',
    label: 'Watermark',
    group: 'document',
    icon: 'watermark',
    cursor: 'default',
    properties: [
      fields.heading('Watermark'),
      { type: 'text', key: 'text', label: 'Text', placeholder: 'CONFIDENTIAL', default: '' },
      fields.heading('Style'),
      fields.color('color', 'Color', '#94a3b8'),
      fields.opacity(30),
      fields.select(
        'position',
        'Position',
        [
          { value: 'center', label: 'Center' },
          { value: 'tile', label: 'Tiled' },
          { value: 'diagonal', label: 'Diagonal' },
        ],
        'diagonal'
      ),
      fields.button('Apply watermark', 'watermark-run'),
    ],
  },
  {
    id: 'protect',
    label: 'Protect',
    group: 'document',
    icon: 'protect',
    cursor: 'default',
    properties: [
      fields.heading('Password protect'),
      { type: 'password', key: 'password', label: 'Password', placeholder: 'Enter a password', default: '' },
      fields.heading('Permissions'),
      { type: 'checkbox', key: 'restrictPrint', label: 'Disallow printing', default: false },
      { type: 'checkbox', key: 'restrictCopy', label: 'Disallow copying text', default: false },
      fields.button('Protect document', 'protect-run'),
    ],
  },
  {
    id: 'ocr',
    label: 'OCR',
    group: 'document',
    icon: 'ocr',
    cursor: 'default',
    properties: [
      fields.heading('Recognize text (OCR)'),
      fields.select(
        'language',
        'Language',
        [
          { value: 'eng', label: 'English' },
          { value: 'spa', label: 'Spanish' },
          { value: 'fra', label: 'French' },
          { value: 'deu', label: 'German' },
        ],
        'eng'
      ),
      fields.note('Make scanned pages searchable and selectable.'),
      fields.button('Run OCR', 'ocr-run'),
    ],
  },
  {
    id: 'ai',
    label: 'AI Tools',
    group: 'document',
    icon: 'ai',
    cursor: 'default',
    properties: [
      fields.heading('AI document tools'),
      fields.segment(
        'task',
        'Task',
        [
          { value: 'summarize', label: 'Summarize' },
          { value: 'ask', label: 'Ask' },
          { value: 'extract', label: 'Extract' },
        ],
        'summarize'
      ),
      fields.heading('Prompt'),
      { type: 'textarea', key: 'prompt', label: 'Prompt', placeholder: 'Summarize this document in 5 bullet points…', default: '' },
      fields.button('Run AI task', 'ai-run'),
    ],
  },
];
