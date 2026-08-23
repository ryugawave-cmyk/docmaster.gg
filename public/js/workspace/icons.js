/**
 * Inline SVG icon set for the workspace (single source of truth for the app).
 * Each entry is the inner markup of a 24x24, stroke-based icon.
 */
const ICONS = {
  // Brand / chrome
  logo: '<path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8.5 13.5 11 16l4.5-5"/>',
  open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  save: '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 3v5h8"/><path d="M7 21v-6h10v6"/>',
  export: '<path d="M12 3v11m0 0-3.5-3.5M12 14l3.5-3.5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 1 1 0 10H9"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 1 0 0 10h6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  fit: '<path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  print: '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="7" rx="1"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  account: '<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>',

  // App shell navigation
  home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9"/>',
  recent: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  document: '<path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h8M8 17h6"/>',
  'new-doc': '<path d="M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M13 2v5h5"/><path d="M12 11v6M9 14h6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  template: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
  pdf: '<path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8.2 17v-3.2h1a1 1 0 0 1 0 2h-1M12 13.8V17M15.8 13.8H14.4V17M14.4 15.4h1.1"/>',
  upload: '<path d="M12 16V4m0 0-4 4m4-4 4 4"/><path d="M20 16v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 6.5"/>',

  // Navigate
  selection: '<path d="M5 3l6.5 16 2.4-6.6L20.5 10 5 3Z"/>',
  hand: '<path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11m0-.5V5a1.5 1.5 0 0 1 3 0v6m0-.5V6.5a1.5 1.5 0 0 1 3 0V14c0 3.5-2.3 6-6 6s-4.8-1.7-6-3.6L3.5 13a1.6 1.6 0 0 1 2.7-1.7L8 13.5"/>',

  // Annotate / create
  text: '<path d="M5 5h14M12 5v14M9 19h6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-4 4 3 3-2 4 3"/>',
  shapes: '<rect x="3" y="12" width="9" height="9" rx="1"/><circle cx="16.5" cy="7.5" r="4.5"/>',
  chart: '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5" rx="0.5"/><rect x="12" y="8" width="3" height="9" rx="0.5"/><rect x="17" y="5" width="3" height="12" rx="0.5"/>',
  draw: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  highlight: '<path d="M4 21h16"/><path d="M6 15 14 7l3 3-8 8H6v-3Z"/><path d="M13 6l3 3"/>',
  eraser: '<path d="m14 4 6 6-9 9H7l-4-4 9-9a1.4 1.4 0 0 1 2 0Z"/><path d="M9 21h11"/><path d="m9 9 6 6"/>',
  comments: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5A8 8 0 1 1 21 12Z"/>',
  signature: '<path d="M3 17c3-1 4-4 4-6.5C7 9 6.3 8 5.4 8 4.6 8 4 9 4.5 11c.8 3.2 3.4 4 5.5 2.4 1-.8 1.7-2.4 2.6-2.4S14 12.5 16 12.5s2.5-1.5 4-1.5"/><path d="M3 21h18"/>',

  // Pages
  merge: '<path d="M8 3H5a2 2 0 0 0-2 2v3M3 16v3a2 2 0 0 0 2 2h3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3"/><path d="m9 12 3 3 3-3M12 8v7"/>',
  split: '<path d="M12 3v6m0 6v6"/><path d="M6 9 3 12l3 3M18 9l3 3-3 3"/><path d="M3 12h6m6 0h6"/>',
  compress: '<path d="M4 14h6v6M20 10h-6V4"/><path d="m14 10 7-7M3 21l7-7"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 4v5h-5"/>',
  'delete-pages': '<path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M10 11v6M14 11v6"/>',
  'reorder-pages': '<rect x="4" y="4" width="9" height="16" rx="1"/><path d="M18 7v13m0 0 3-3m-3 3-3-3"/>',
  'extract-pages': '<rect x="4" y="3" width="11" height="18" rx="1"/><path d="M21 12h-7m0 0 3-3m-3 3 3 3"/>',

  // Document
  watermark: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 15c1.3 0 1.3-1.8 2.6-1.8S11 15 12.3 15s1.3-1.8 2.6-1.8S16.2 15 17.5 15"/><path d="M9 9h6"/>',
  protect: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 15v3"/>',
  unlock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.7-2.4"/><path d="M12 15v3"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 15v3"/>',
  'image-pdf': '<path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><circle cx="9.5" cy="12.5" r="1.3"/><path d="m7 18 2.5-2.2L12 18l2-1.6L17 19"/>',
  word: '<path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m8 12 1.4 5L11 13l1.6 4L14 12"/>',
  more: '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  stamp: '<path d="M9 4a3 3 0 0 1 6 0c0 1.5-1 2.2-1.4 3.2-.4 1 .1 1.8 1 1.8h1.4a2 2 0 0 1 2 2v1H6v-1a2 2 0 0 1 2-2h1.4c.9 0 1.4-.8 1-1.8C10 6.2 9 5.5 9 4Z"/><rect x="4" y="16" width="16" height="4" rx="1"/>',
  'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/>',
  bookmark: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1Z"/>',
  attachment: '<path d="M21 11.5 12.5 20a4.5 4.5 0 0 1-6.4-6.4l8-8a3 3 0 0 1 4.3 4.3l-8 8a1.5 1.5 0 0 1-2.2-2.2l7.4-7.4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  redact: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h6"/><path d="m14 14 5 5m0-5-5 5" stroke-width="1.4"/>',
  moon: '<path d="M20 13.5A8 8 0 1 1 10.5 4a6.5 6.5 0 0 0 9.5 9.5Z"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h13M20 18h0.01"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  share: '<path d="M12 15V4m0 0-4 4m4-4 4 4"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.2 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.6 2.3-2.6 3.8"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 6-3 7-3 7h18s-3-1-3-7Z"/><path d="M10.5 20a2 2 0 0 0 3 0"/>',
  cloud: '<path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.3A3.5 3.5 0 0 1 17 18Z"/><path d="m9.5 14 1.8 1.8L15 12" stroke-width="1.4"/>',
  outline: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/>',
  reorder: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="m4 6 1.5-1.5L7 6M4 18l1.5 1.5L7 18"/>',
  // Rich-text formatting (Document editor)
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7Zm0 7h7a3.5 3.5 0 0 1 0 7H7Z" stroke-width="2.6"/>',
  italic: '<path d="M10 5h8M6 19h8M14 5 10 19"/>',
  underline: '<path d="M7 5v6a5 5 0 0 0 10 0V5M5 21h14"/>',
  strikethrough: '<path d="M4 12h16M7 7a4 3 0 0 1 8 0M8 16a4 3 0 0 0 8 0"/>',
  superscript: '<path d="M4 7l7 10M11 7l-7 10"/><path d="M17 5.5a1.5 1.5 0 0 1 3 0c0 1.1-3 1.7-3 3.5h3" stroke-width="1.3"/>',
  subscript: '<path d="M4 7l7 10M11 7l-7 10"/><path d="M17 15.5a1.5 1.5 0 0 1 3 0c0 1.1-3 1.7-3 3.5h3" stroke-width="1.3"/>',
  'clear-format': '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H8"/><path d="m5 11 9 9"/>',
  'line-spacing': '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 4v16M4 4 2 6.5M4 4l2 2.5M4 20l-2-2.5M4 20l2-2.5"/>',
  'list-bullet': '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>',
  'list-numbered': '<path d="M10 6h10M10 12h10M10 18h10"/><path d="M4 5h1.5v4M4 9h3M4 15.5a1 1 0 0 1 2 0c0 .8-2 1.3-2 2.5h2"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16M15 4v16"/>',
  'align-left': '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>',
  'align-center': '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>',
  'align-right': '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>',
  'align-justify': '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
  'bring-front': '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/>',
  'send-back': '<rect x="4" y="4" width="12" height="12" rx="2"/><path d="M20 8v10a2 2 0 0 1-2 2H8"/>',
  ocr: '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h.01M12 12h.01M17 12h.01"/>',
  ai: '<path d="M12 3a3 3 0 0 0-3 3 3 3 0 0 0-3 3 3 3 0 0 0 0 6 3 3 0 0 0 3 3 3 3 0 0 0 6 0 3 3 0 0 0 3-3 3 3 0 0 0 0-6 3 3 0 0 0-3-3 3 3 0 0 0-3-3Z"/><path d="M12 8v8M8.5 10.5l7 3M15.5 10.5l-7 3"/>',
  bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
  sparkle: '<path d="M12 3l1.7 5.1a3 3 0 0 0 1.9 1.9L21 12l-5.4 1.7a3 3 0 0 0-1.9 1.9L12 21l-1.7-5.4a3 3 0 0 0-1.9-1.9L3 12l5.4-1.7a3 3 0 0 0 1.9-1.9L12 3Z"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
};

/**
 * Return an inline `<svg>` markup string for the given icon name.
 * @param {string} name
 * @returns {string}
 */
export function renderIcon(name) {
  const inner = ICONS[name] || ICONS.selection;
  return `<svg class="ws-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/**
 * Replace every `[data-icon]` element under `root` with its rendered icon.
 * @param {ParentNode} root
 */
export function hydrateIcons(root) {
  root.querySelectorAll('[data-icon]').forEach((node) => {
    node.innerHTML = renderIcon(node.dataset.icon);
  });
}

export { ICONS };
