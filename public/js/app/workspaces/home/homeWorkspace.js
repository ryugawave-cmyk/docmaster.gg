/**
 * DocMaster Home — a minimal, editor-first launcher.
 *
 * The home screen is deliberately bare: the DocMaster brand, two large cards
 * (New PDF / New Document) and a Quick PDF Tools grid — nothing else. While Home
 * is active the shared shell chrome (top toolbar, left nav, properties panel,
 * status bar) is fully collapsed (`store.homeMode` → `.app.is-home-mode`), so the
 * full editing interface appears only *after* entering an editor. Every action is
 * dispatched on the bus as a `nav:command`; the router (app/index.js) decides
 * what happens, so this file stays declarative.
 */
import { el } from '../../../workspace/utils/dom.js';
import { renderIcon } from '../../../workspace/icons.js';

// Full 3D "app icon" builder. The SVG IS the whole object — a glossy squircle
// tile (top highlight + bottom shade), a drop-shadowed white sheet with a curled
// folded corner, then per-icon content. `id` namespaces the gradients/clip/filter
// so several can share a page. viewBox 96 gives room for smooth 3D shading.
function icon3d(id, tileTop, tileBottom, foldFill, content) {
  return `
<svg class="ws-icon" viewBox="0 0 96 96" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="${id}T" x1="30" y1="4" x2="66" y2="94" gradientUnits="userSpaceOnUse">
      <stop stop-color="${tileTop}"/><stop offset="1" stop-color="${tileBottom}"/>
    </linearGradient>
    <linearGradient id="${id}P" x1="48" y1="22" x2="48" y2="78" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ffffff"/><stop offset="1" stop-color="#e2e5ea"/>
    </linearGradient>
    <linearGradient id="${id}F" x1="58" y1="23" x2="68" y2="34" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ffffff" stop-opacity=".85"/><stop offset="1" stop-color="${foldFill}"/>
    </linearGradient>
    <clipPath id="${id}C"><rect x="3" y="3" width="90" height="90" rx="26"/></clipPath>
    <filter id="${id}S" x="-25%" y="-20%" width="150%" height="155%">
      <feDropShadow dx="0" dy="2.4" stdDeviation="2.6" flood-color="#0a1020" flood-opacity="0.3"/>
    </filter>
  </defs>
  <g clip-path="url(#${id}C)">
    <rect x="3" y="3" width="90" height="90" fill="url(#${id}T)"/>
    <ellipse cx="38" cy="16" rx="52" ry="30" fill="#ffffff" opacity="0.28"/>
    <ellipse cx="54" cy="100" rx="58" ry="34" fill="#00130a" opacity="0.18"/>
    <rect x="3.75" y="3.75" width="88.5" height="88.5" rx="25.25" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="1.5"/>
  </g>
  <g filter="url(#${id}S)">
    <path d="M33 23h25l10 10v37a4 4 0 0 1-4 4H33a4 4 0 0 1-4-4V27a4 4 0 0 1 4-4Z" fill="url(#${id}P)"/>
    <path d="M58 23l10 10H62a4 4 0 0 1-4-4Z" fill="url(#${id}F)"/>
  </g>
  ${content}
</svg>`;
}

const PDF_ART = icon3d('hp', '#ff7285', '#e11d48', '#f4a6b1', `
  <path d="M48.5 39l7.5 13.5H41Z" fill="#e11d48" opacity=".92"/>
  <rect x="33" y="55" width="31" height="13.5" rx="3.2" fill="#e11d48"/>
  <text x="48.5" y="64.7" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="9.6" font-weight="800" fill="#ffffff">PDF</text>`);

const DOC_ART = icon3d('hd', '#39dca0', '#0ea371', '#38bdf8', `
  <g stroke="#9bc0ff" stroke-width="3.1" stroke-linecap="round">
    <path d="M36 41h20"/><path d="M36 49h22"/><path d="M36 57h14"/>
  </g>
  <circle cx="60" cy="59" r="10.5" fill="#10b981" stroke="#ffffff" stroke-width="3"/>
  <path d="M60 53.6v10.8M54.6 59h10.8" stroke="#ffffff" stroke-width="3" stroke-linecap="round"/>`);

const EXCEL_ART = icon3d('hx', '#4ade80', '#15a34a', '#bbf7d0', `
  <rect x="36" y="38.5" width="26" height="6" rx="1.2" fill="#16a34a"/>
  <g fill="#d3ecdd">
    <rect x="36" y="47" width="7.6" height="5.4" rx=".8"/><rect x="45.2" y="47" width="7.6" height="5.4" rx=".8"/><rect x="54.4" y="47" width="7.6" height="5.4" rx=".8"/>
    <rect x="36" y="54" width="7.6" height="5.4" rx=".8"/><rect x="45.2" y="54" width="7.6" height="5.4" rx=".8"/><rect x="54.4" y="54" width="7.6" height="5.4" rx=".8"/>
    <rect x="36" y="61" width="7.6" height="5.4" rx=".8"/><rect x="45.2" y="61" width="7.6" height="5.4" rx=".8"/><rect x="54.4" y="61" width="7.6" height="5.4" rx=".8"/>
  </g>
  <rect x="26" y="49" width="21" height="21" rx="4.6" fill="#15803d"/>
  <path d="M31.5 54.5l10 10M41.5 54.5l-10 10" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round"/>`);

// The primary entry points. The first two open their editor immediately; Excel is
// a locked, forward-looking placeholder that opens a "Coming soon" dialog instead.
const START_ACTIONS = [
  { icon: 'pdf', art: PDF_ART, title: 'New PDF', desc: 'Start a blank PDF workspace', tone: 'a', command: 'new-pdf' },
  { icon: 'new-doc', art: DOC_ART, title: 'New Document', desc: 'Write from a blank page', tone: 'c', command: 'new-document' },
  { icon: 'new-doc', art: EXCEL_ART, title: 'Excel Spreadsheet', desc: 'Create spreadsheets and data tables', tone: 'e', locked: true },
];

// Polished "Coming soon" dialog for locked start cards. Appended to <body> so it
// overlays the whole app; closes on the button, backdrop click, or Escape.
function showComingSoon(action) {
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.classList.remove('is-open');
    setTimeout(() => overlay.remove(), 180);
  }
  const overlay = el('div', {
    class: 'home__soon-overlay',
    onClick: (e) => { if (e.target === overlay) close(); },
  }, [
    el('div', { class: 'home__soon', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${action.title} — coming soon` }, [
      el('span', { class: 'home__soon-icon', html: action.art }),
      el('span', { class: 'home__soon-tag' }, 'Coming soon'),
      el('h3', { class: 'home__soon-title' }, action.title),
      el('p', { class: 'home__soon-desc' },
        'This tool is in active development. Spreadsheets and data tables are coming to Alvion Office soon — stay tuned!'),
      el('button', { class: 'home__soon-btn', type: 'button', onClick: close }, 'Got it'),
    ]),
  ]);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => overlay.classList.add('is-open'));
}

// Tool sections — placeholders today (each toasts "coming soon"). The grids use
// an auto-fill layout so new tools drop in without crowding or unbalancing the
// page. `command` decides which coming-soon channel the click flows through.
const TOOL_SECTIONS = [
  {
    id: 'pdf', icon: 'pdf', tone: 'pdf', command: 'pdf-tool',
    title: 'PDF Tools', desc: 'Merge, split, compress, convert and secure your PDF files.',
    tools: [
      { icon: 'merge', title: 'Merge', arg: 'merge' },
      { icon: 'split', title: 'Split', arg: 'split' },
      { icon: 'compress', title: 'Compress', arg: 'compress' },
      { icon: 'image-pdf', title: 'Image → PDF', arg: 'image-to-pdf' },
      { icon: 'rotate', title: 'Rotate', arg: 'rotate' },
      { icon: 'extract-pages', title: 'Extract Pages', arg: 'extract-pages' },
      { icon: 'reorder-pages', title: 'Organize Pages', arg: 'organize-pages' },
    ],
  },
  {
    id: 'doc', icon: 'new-doc', tone: 'doc', command: 'doc-tool',
    title: 'Document Tools', desc: 'Write, format, convert and export your documents.',
    tools: [
      { icon: 'word', title: 'Word → PDF', arg: 'word-to-pdf' },
      { icon: 'export', title: 'PDF → Word', arg: 'pdf-to-word' },
      { icon: 'edit', title: 'DOCX Editor', arg: 'docx-editor' },
      { icon: 'export', title: 'Export PDF', arg: 'export-pdf' },
      { icon: 'sliders', title: 'Advanced Export', arg: 'advanced-export' },
    ],
  },
];

export function createHomeWorkspace({ bus, store, services }) {
  let root = null;

  const dispatch = (command, arg) => bus.emit('nav:command', { command, arg });

  function mount(container) {
    root = el('div', { class: 'home' });
    container.appendChild(root);
    // Dropping a PDF/document onto the landing page opens it in the editor.
    services.fileManager.enableDropZone(root, (files) => bus.emit('file:dropped', files));
    render();
  }

  function render() {
    if (!root) return;
    root.replaceChildren(
      el('header', { class: 'home__brand' }, [
        el('span', { class: 'home__logo' }, [el('img', { class: 'home__logo-img', src: '/images/logo-mark.png', alt: '' })]),
        el('span', { class: 'home__name' }, [el('b', {}, 'Alvion'), ' Office']),
      ]),

      el('div', { class: 'home__hero' }, [
        el('h1', { class: 'home__title' }, 'What would you like to create?'),
        el('div', { class: 'home__cards' }, START_ACTIONS.map((a) =>
          el('button', {
            class: `home__card home__card--${a.tone}${a.locked ? ' is-locked' : ''}`, type: 'button',
            onClick: a.locked ? () => showComingSoon(a) : () => dispatch(a.command, a.arg),
          }, [
            a.locked ? el('span', { class: 'home__card-badge' }, 'Soon') : null,
            el('span', { class: 'home__card-icon', html: a.art || renderIcon(a.icon) }),
            el('span', { class: 'home__card-title' }, a.title),
            el('span', { class: 'home__card-desc' }, a.desc),
          ])
        )),
      ]),

      el('div', { class: 'home__sections' }, TOOL_SECTIONS.flatMap((sec, i) => [
        i > 0 ? el('div', { class: 'home__divider' }) : null,
        el('section', { class: 'home__section' }, [
          el('div', { class: 'home__section-head' }, [
            el('span', { class: `home__section-icon home__section-icon--${sec.tone}`, html: renderIcon(sec.icon) }),
            el('div', { class: 'home__section-heading' }, [
              el('h2', { class: 'home__section-title' }, sec.title),
              el('p', { class: 'home__section-desc' }, sec.desc),
            ]),
          ]),
          el('div', { class: 'home__tools-grid' }, sec.tools.map((t) =>
            el('button', {
              class: 'home__tool', type: 'button', title: t.title,
              onClick: () => dispatch(sec.command, t.arg),
            }, [
              el('span', { class: 'home__tool-ico', html: renderIcon(t.icon) }),
              el('span', { class: 'home__tool-name' }, t.title),
            ])
          )),
        ]),
      ].filter(Boolean))),
    );
  }

  return {
    id: 'home',
    label: 'Home',
    icon: 'home',
    accepts: () => false,
    mount,
    activate() {
      // Collapse all shared chrome — the home screen is a clean, distraction-free launcher.
      store.setState({ homeMode: true, docName: 'Alvion Office', totalPages: 0, file: null, pageSize: null });
    },
    deactivate() { store.setState({ homeMode: false }); },
    onActivate() {},
    getToolbar: () => ({ groups: [] }),
    getTools: () => [],
    handleAction: () => false,
    open: () => Promise.resolve(),
    export: () => Promise.resolve(),
  };
}
