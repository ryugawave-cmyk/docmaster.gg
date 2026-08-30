/**
 * Advanced Export / Conversion panel.
 *
 * A full-screen overlay opened from the editor's Export → "Advanced Export"
 * choice. The editor stays mounted underneath (no work is lost); closing the
 * panel returns straight to it. It hosts the non-trivial export tools —
 * Compress and the PDF → Word/Excel/PowerPoint/JPG/PNG/HTML converters — as an
 * organised list + a per-tool settings pane, rather than a cluttered toolbar.
 *
 * All conversions run client-side from the editor's WYSIWYG model (see
 * services/convert/*). This module only owns the UI, progress, error handling
 * and wiring; the actual file building lives in the converters.
 *
 * Responsive: a two-pane layout on desktop/tablet; a full-screen, vertically
 * stacked bottom-sheet on phones (driven by CSS).
 */
import { el } from '../../workspace/utils/dom.js';
import { renderIcon } from '../../workspace/icons.js';
import { exportEditorToPdf } from './pdfExport.js';
import { modelHasVisibleContent } from './pdfExport.js';
import { compressToTarget } from './pdfCompressor.js';
import { buildContentModel } from '../services/convert/model.js';
import { modelToDocx } from '../services/convert/docx.js';
import { convertToWordAI } from '../services/convert/aiWordConvert.js';
import { extractBakedImages, maskExtractedText } from '../services/convert/rasterImages.js';
import { modelToXlsx } from '../services/convert/xlsx.js';
import { modelToPptx } from '../services/convert/pptx.js';
import { modelToHtml } from '../services/convert/html.js';
import { modelToImages } from '../services/convert/images.js';

const TOOLS = [
  { id: 'compress', icon: 'compress', label: 'Compress PDF', desc: 'Reduce the file size' },
  { id: 'word', icon: 'word', label: 'PDF → Word', desc: 'Editable .docx document' },
  { id: 'excel', icon: 'layers', label: 'PDF → Excel', desc: 'Spreadsheet .xlsx' },
  { id: 'ppt', icon: 'template', label: 'PDF → PowerPoint', desc: 'Editable slides .pptx' },
  { id: 'jpg', icon: 'image', label: 'PDF → JPG', desc: 'JPEG image per page' },
  { id: 'png', icon: 'image', label: 'PDF → PNG', desc: 'PNG image per page' },
  { id: 'html', icon: 'link', label: 'PDF → HTML', desc: 'Standalone web page', locked: true },
];

// Scale is the raster oversample (≥1 keeps text at/above native, so it never
// blurs); quality is the JPEG fallback. Both are floored so even "High" stays
// crisp — text-heavy pages are shipped losslessly by the exporter regardless, so
// higher levels shrink the file without destroying legibility.
const COMPRESS_LEVELS = [
  { id: 'low', label: 'Low', hint: 'Best quality, larger file', scale: 2, quality: 0.9 },
  { id: 'recommended', label: 'Recommended', hint: 'Balanced quality & size', scale: 1.75, quality: 0.75 },
  { id: 'high', label: 'High', hint: 'Smallest file, still sharp text', scale: 1.5, quality: 0.6 },
];

// PDF → Word: the two headline modes get large, premium selection cards. Just the
// title (+ a "Recommended" badge) — no explanatory copy or keyword chips — so the
// choice stays clean and users pick on the label alone.
const WORD_MODE_CARDS = [
  { id: 'ai', icon: 'sparkle', title: 'Editable (AI)', recommended: true },
  { id: 'exact', icon: 'document', title: 'Exact Copy' },
];
// Power-user modes, tucked into a collapsed "Advanced options" disclosure so the
// primary choice stays uncluttered. Same wiring/values as the cards.
const WORD_MODE_ADVANCED = [
  { id: 'editable', label: 'Plain Text', desc: 'Text only, images removed — easiest for heavy rewriting.' },
];

// Decorative hero illustration for the detail header — a premium, 3D-looking
// document icon: a layered sheet with depth, a glossy shine, a folded corner,
// a light beam sweeping behind it and a 3D red "PDF" tab. One crisp SVG so it
// renders identically everywhere (no fragile CSS pseudo-element stacks).
const HERO_ART_SVG = `
<svg viewBox="0 0 184 134" fill="none" xmlns="http://www.w3.org/2000/svg" role="presentation">
  <defs>
    <linearGradient id="bpxHeroPaper" x1="46" y1="20" x2="120" y2="120" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ffffff"/><stop offset="1" stop-color="#dbdefb"/>
    </linearGradient>
    <linearGradient id="bpxHeroBack" x1="60" y1="14" x2="128" y2="110" gradientUnits="userSpaceOnUse">
      <stop stop-color="#c7cbf4"/><stop offset="1" stop-color="#a6abe6"/>
    </linearGradient>
    <linearGradient id="bpxHeroFold" x1="104" y1="20" x2="128" y2="46" gradientUnits="userSpaceOnUse">
      <stop stop-color="#c0c4f0"/><stop offset="1" stop-color="#9ea3e0"/>
    </linearGradient>
    <linearGradient id="bpxHeroGloss" x1="46" y1="18" x2="86" y2="70" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ffffff" stop-opacity="0.9"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bpxHeroBadge" x1="70" y1="88" x2="122" y2="122" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ff6274"/><stop offset="1" stop-color="#d51c46"/>
    </linearGradient>
    <linearGradient id="bpxHeroBadgeGloss" x1="70" y1="88" x2="70" y2="104" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ffffff" stop-opacity="0.5"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bpxHeroBeam" x1="0" y1="0" x2="1" y2="0">
      <stop stop-color="#a982ff" stop-opacity="0"/><stop offset="0.5" stop-color="#c4b0ff" stop-opacity="0.75"/><stop offset="1" stop-color="#7fb0ff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="bpxHeroGlow" cx="0.5" cy="0.5" r="0.5">
      <stop stop-color="#8b5cf6" stop-opacity="0.5"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/>
    </radialGradient>
    <filter id="bpxHeroSoft" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="6"/>
    </filter>
    <filter id="bpxHeroShadow" x="-40%" y="-30%" width="180%" height="180%">
      <feDropShadow dx="0" dy="13" stdDeviation="13" flood-color="#39157f" flood-opacity="0.6"/>
    </filter>
    <filter id="bpxHeroBadgeShadow" x="-40%" y="-40%" width="180%" height="200%">
      <feDropShadow dx="0" dy="7" stdDeviation="7" flood-color="#a01234" flood-opacity="0.55"/>
    </filter>
  </defs>
  <rect x="-30" y="46" width="260" height="24" fill="url(#bpxHeroBeam)" transform="rotate(-19 96 66)" filter="url(#bpxHeroSoft)"/>
  <ellipse cx="104" cy="60" rx="72" ry="60" fill="url(#bpxHeroGlow)"/>
  <g transform="rotate(8 94 68)">
    <g filter="url(#bpxHeroShadow)">
      <path d="M56 20a6 6 0 0 1 6-6h44l22 22v56a6 6 0 0 1-6 6H62a6 6 0 0 1-6-6V20Z" fill="url(#bpxHeroBack)" opacity="0.85"/>
      <path d="M44 30a6 6 0 0 1 6-6h50l22 22v60a6 6 0 0 1-6 6H50a6 6 0 0 1-6-6V30Z" fill="url(#bpxHeroPaper)"/>
    </g>
    <path d="M100 24l22 22h-16a6 6 0 0 1-6-6V24Z" fill="url(#bpxHeroFold)"/>
    <path d="M50 24h30L52 78v-48a6 6 0 0 1 6-6Z" fill="url(#bpxHeroGloss)" opacity="0.55"/>
    <g fill="#aeb2e2" opacity="0.85">
      <rect x="54" y="50" width="42" height="4.5" rx="2.25"/>
      <rect x="54" y="61" width="54" height="4.5" rx="2.25"/>
      <rect x="54" y="72" width="54" height="4.5" rx="2.25"/>
      <rect x="54" y="83" width="34" height="4.5" rx="2.25"/>
    </g>
  </g>
  <g transform="rotate(-8 96 102)" filter="url(#bpxHeroBadgeShadow)">
    <rect x="70" y="88" width="52" height="26" rx="7" fill="url(#bpxHeroBadge)"/>
    <rect x="72.5" y="90.5" width="47" height="12" rx="5" fill="url(#bpxHeroBadgeGloss)"/>
    <text x="96" y="105.5" text-anchor="middle" font-family="Inter, Segoe UI, sans-serif" font-size="13.5" font-weight="800" letter-spacing="0.6" fill="#ffffff">PDF</text>
  </g>
</svg>`;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * @param {{ mount:HTMLElement, bus:object, getModel:()=>object,
 *   getDocName:()=>string, downloadBlob:(blob:Blob,name:string)=>void,
 *   isDark:()=>boolean }} deps
 */
export function createExportPanel({ mount, bus, getModel, getDocName, downloadBlob, isDark }) {
  let overlay = null;
  let selectedId = 'compress';
  const settings = {
    wordMode: 'ai', imgRes: 'screen',
    compressMode: 'level', compressLevel: 'recommended',
    compressTargetValue: 0, compressTargetUnit: 'KB',
  };
  let busy = false;

  const baseName = () => (getDocName() || 'document').replace(/\.[^.]+$/, '');

  function open() {
    if (overlay) return;
    selectedId = 'compress';
    overlay = el('div', {
      class: `bpx-exp bpx-exp--pro${isDark && isDark() ? ' is-dark' : ''}`, role: 'dialog', 'aria-modal': 'true',
      'aria-label': 'Export and convert',
      onClick: (e) => { if (e.target === overlay) close(); },
    }, [
      el('div', { class: 'bpx-exp__sheet' }, [
        el('div', { class: 'bpx-exp__head' }, [
          el('span', { class: 'bpx-exp__head-spacer' }),
          el('button', { class: 'bpx-exp__x', type: 'button', 'aria-label': 'Close', html: renderIcon('close'), onClick: close }),
        ]),
        el('div', { class: 'bpx-exp__body' }, [nav, detail]),
      ]),
    ]);
    (mount || document.body).appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    renderNav();
    selectTool('compress');
  }

  function close() {
    if (busy) return; // don't yank a conversion in progress
    if (!overlay) return;
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    overlay = null;
  }

  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

  /* ------------------------------ nav list ------------------------------ */
  const nav = el('nav', { class: 'bpx-exp__nav', 'aria-label': 'Export options' });
  function renderNav() {
    nav.replaceChildren(...TOOLS.map((t) => el('button', {
      class: `bpx-exp__opt${t.id === selectedId ? ' is-active' : ''}${t.locked ? ' is-locked' : ''}`,
      type: 'button', 'data-id': t.id,
      'aria-disabled': t.locked ? 'true' : null,
      title: t.locked ? 'Not available right now' : null,
      onClick: () => { if (!busy && !t.locked) selectTool(t.id); },
    }, [
      el('span', { class: 'bpx-exp__opt-ico', html: renderIcon(t.icon) }),
      el('span', { class: 'bpx-exp__opt-txt' }, [
        el('span', { class: 'bpx-exp__opt-lbl' }, t.label),
        el('span', { class: 'bpx-exp__opt-desc' }, t.desc),
      ]),
      t.locked
        ? el('span', { class: 'bpx-exp__opt-locktag' }, [
            el('span', { class: 'bpx-exp__opt-soon' }, 'Coming soon'),
            el('span', { class: 'bpx-exp__opt-lock', html: renderIcon('lock'), 'aria-hidden': 'true' }),
          ])
        : el('span', { class: 'bpx-exp__opt-chev', html: renderIcon('chevron') }),
    ])));
  }

  /* ------------------------------ detail -------------------------------- */
  const detail = el('section', { class: 'bpx-exp__detail' });

  function selectTool(id) {
    selectedId = id;
    for (const b of nav.querySelectorAll('.bpx-exp__opt')) b.classList.toggle('is-active', b.dataset.id === id);
    overlay?.querySelector('.bpx-exp__sheet')?.classList.add('is-detail'); // mobile: reveal detail pane
    renderForm();
  }

  const tool = () => TOOLS.find((t) => t.id === selectedId);

  // A longer, benefit-led subtitle per tool for the big detail header (the list
  // keeps the short one). Falls back to the tool's own desc.
  const DETAIL_SUBS = {
    compress: 'Reduce the file size without losing quality',
    word: 'Turn your PDF into a fully editable Word document',
    excel: 'Pull tables and text into an editable spreadsheet',
    ppt: 'Slides that look exactly like the PDF, with editable text',
    jpg: 'Export crisp JPEG images, one per page',
    png: 'Export lossless PNG images, one per page',
    html: 'Publish a clean, standalone web page',
  };

  function renderForm() {
    const t = tool();
    const settingsEl = el('div', { class: 'bpx-exp__settings' }, buildSettings(t.id));
    const convertBtn = el('button', { class: 'bpx-exp__go', type: 'button', onClick: runConvert },
      [el('span', { html: renderIcon('sparkle') }), t.id === 'compress' ? 'Compress PDF' : 'Convert & Download']);
    detail.replaceChildren(
      el('div', { class: 'bpx-exp__detail-head' }, [
        el('button', { class: 'bpx-exp__detail-back', type: 'button', 'aria-label': 'Back to list', html: renderIcon('chevron'),
          onClick: () => overlay?.querySelector('.bpx-exp__sheet')?.classList.remove('is-detail') }),
        el('span', { class: 'bpx-exp__detail-ico', html: renderIcon(t.icon) }),
        el('div', { class: 'bpx-exp__detail-txt' }, [
          el('h3', { class: 'bpx-exp__detail-title' }, t.label),
          el('p', { class: 'bpx-exp__detail-sub' }, DETAIL_SUBS[t.id] || t.desc),
        ]),
        // Decorative hero artwork — a clean, self-contained SVG document with a
        // PDF badge. Purely visual (aria-hidden); crisp at any scale.
        el('div', { class: 'bpx-exp__hero-art', 'aria-hidden': 'true', html: HERO_ART_SVG }),
      ]),
      el('div', { class: 'bpx-exp__middle' }, [
        settingsEl,
        el('div', { class: 'bpx-exp__status', 'aria-live': 'polite' }),
      ]),
      el('div', { class: 'bpx-exp__foot' }, [
        el('div', { class: 'bpx-exp__safe' }, [
          el('span', { class: 'bpx-exp__safe-ico', html: renderIcon('shield'), 'aria-hidden': 'true' }),
          el('div', { class: 'bpx-exp__safe-txt' }, [
            el('span', { class: 'bpx-exp__safe-lbl' }, 'Private & secure'),
            el('span', { class: 'bpx-exp__safe-sub' }, 'Everything runs in your browser — files never leave your device.'),
          ]),
        ]),
        convertBtn,
      ]),
    );
  }

  function buildSettings(id) {
    if (id === 'compress') return compressSettings();
    if (id === 'word') {
      return [wordModeSelector()];
    }
    if (id === 'jpg' || id === 'png') {
      return [radioGroup('Resolution', [
        { id: 'screen', label: 'Standard', desc: 'Good for screen / sharing' },
        { id: 'high', label: 'High', desc: 'Sharper, larger files' },
      ], settings.imgRes, (v) => { settings.imgRes = v; }, { icon: 'image' })];
    }
    // excel / ppt / html: no options
    const note = {
      excel: 'Extracts text into rows & columns, one sheet for the whole document.',
      ppt: 'One slide per page — the page kept exactly as it looks, with the text as editable boxes on top.',
      html: 'A clean, standalone HTML page with headings, paragraphs and images.',
    }[id];
    return [el('p', { class: 'bpx-exp__note' }, note || '')];
  }

  function radioGroup(title, items, current, onPick, opts = {}) {
    const group = el('div', { class: 'bpx-exp__group', role: 'radiogroup', 'aria-label': title }, [
      groupTitle(title, opts.icon),
      ...items.map((it) => {
        const card = el('button', {
          class: `bpx-exp__radio${it.id === current ? ' is-on' : ''}`, type: 'button', role: 'radio',
          'aria-checked': it.id === current ? 'true' : 'false',
          onClick: () => {
            onPick(it.id);
            for (const c of group.querySelectorAll('.bpx-exp__radio')) {
              const on = c === card; c.classList.toggle('is-on', on); c.setAttribute('aria-checked', on ? 'true' : 'false');
            }
          },
        }, [
          el('span', { class: 'bpx-exp__radio-dot' }),
          el('span', { class: 'bpx-exp__radio-txt' }, [
            el('span', { class: 'bpx-exp__radio-lbl' }, it.label),
            it.desc ? el('span', { class: 'bpx-exp__radio-desc' }, it.desc) : null,
          ]),
          it.trail ? el('span', { class: 'bpx-exp__radio-trail', html: renderIcon(it.trail), 'aria-hidden': 'true' }) : null,
        ]);
        return card;
      }),
    ]);
    return group;
  }

  // Uppercase section heading with an optional accent icon (matches the mockup's
  // "Compression Mode" / "Compression Level" headers).
  function groupTitle(title, icon) {
    return el('div', { class: 'bpx-exp__group-title' }, [
      icon ? el('span', { class: 'bpx-exp__group-ico', html: renderIcon(icon), 'aria-hidden': 'true' }) : null,
      el('span', {}, title),
    ]);
  }

  // Horizontal "segmented" cards for the compression level — a bar-chart icon +
  // label + hint, three across, with the selected one lit purple.
  function levelCards(current, onPick) {
    const group = el('div', { class: 'bpx-exp__group', role: 'radiogroup', 'aria-label': 'Compression level' }, [
      groupTitle('Compression level', 'chart'),
      el('div', { class: 'bpx-exp__levels' }, COMPRESS_LEVELS.map((l) => {
        const card = el('button', {
          class: `bpx-exp__level${l.id === current ? ' is-on' : ''}`, type: 'button', role: 'radio',
          'aria-checked': l.id === current ? 'true' : 'false',
          onClick: () => {
            onPick(l.id);
            for (const c of group.querySelectorAll('.bpx-exp__level')) {
              const on = c === card; c.classList.toggle('is-on', on); c.setAttribute('aria-checked', on ? 'true' : 'false');
            }
          },
        }, [
          el('span', { class: 'bpx-exp__level-ico', html: renderIcon('chart'), 'aria-hidden': 'true' }),
          el('span', { class: 'bpx-exp__level-txt' }, [
            el('span', { class: 'bpx-exp__level-lbl' }, l.label),
            el('span', { class: 'bpx-exp__level-hint' }, l.hint),
          ]),
        ]);
        return card;
      })),
    ]);
    return group;
  }

  // PDF → Word mode selector: two premium cards for the headline modes. The
  // "Advanced options" row is locked (coming soon) — a placeholder for future
  // power-user modes — so only the two cards are selectable for now.
  function wordModeSelector() {
    const wrap = el('div', { class: 'bpx-exp__wordmode' });

    // Advanced modes aren't selectable yet; make sure we never sit on one.
    if (WORD_MODE_ADVANCED.some((m) => m.id === settings.wordMode)) settings.wordMode = 'ai';

    const sync = () => {
      for (const c of wrap.querySelectorAll('.bpx-exp__card')) {
        const on = c.dataset.mode === settings.wordMode;
        c.classList.toggle('is-on', on);
        c.setAttribute('aria-checked', on ? 'true' : 'false');
      }
    };
    const pick = (v) => { settings.wordMode = v; sync(); };

    const cards = el('div', { class: 'bpx-exp__cards', role: 'radiogroup', 'aria-label': 'Conversion mode' },
      WORD_MODE_CARDS.map((m) => el('button', {
        class: `bpx-exp__card${m.id === settings.wordMode ? ' is-on' : ''}`, type: 'button', role: 'radio',
        dataset: { mode: m.id }, 'aria-checked': m.id === settings.wordMode ? 'true' : 'false',
        onClick: () => pick(m.id),
      }, [
        el('span', { class: 'bpx-exp__card-check', html: renderIcon('check'), 'aria-hidden': 'true' }),
        el('span', { class: 'bpx-exp__card-ico', html: renderIcon(m.icon), 'aria-hidden': 'true' }),
        el('div', { class: 'bpx-exp__card-body' }, [
          el('div', { class: 'bpx-exp__card-head' }, [
            el('span', { class: 'bpx-exp__card-title' }, m.title),
            m.recommended ? el('span', { class: 'bpx-exp__card-badge' }, 'Recommended') : null,
          ]),
        ]),
      ])));

    // Locked disclosure — no expansion; signals more modes are on the way.
    const toggle = el('div', {
      class: 'bpx-exp__adv-toggle is-locked', 'aria-disabled': 'true',
      title: 'More conversion modes coming soon',
    }, [
      el('span', {}, 'Advanced options'),
      el('span', { class: 'bpx-exp__adv-soon' }, 'Coming soon'),
      el('span', { class: 'bpx-exp__adv-lock', html: renderIcon('lock'), 'aria-hidden': 'true' }),
    ]);

    wrap.replaceChildren(cards, toggle);
    return wrap;
  }

  // Compress has a two-tier form: a Compression MODE (Original / Reduce size /
  // Custom size), and — depending on the mode — either the level radios or a
  // target-size input. Changing the mode re-renders only the sub-area.
  function compressSettings() {
    const sub = el('div', { class: 'bpx-exp__subsettings' });
    const renderSub = () => {
      if (settings.compressMode === 'level') {
        sub.replaceChildren(levelCards(settings.compressLevel, (v) => { settings.compressLevel = v; }));
      } else if (settings.compressMode === 'custom') {
        sub.replaceChildren(customSizeGroup());
      } else {
        sub.replaceChildren(el('p', { class: 'bpx-exp__note' },
          'The PDF is exported at its original size and quality — no compression is applied.'));
      }
    };
    const modeGroup = radioGroup('Compression mode', [
      { id: 'level', label: 'Reduce size', desc: 'Balanced automatic compression', trail: 'bolt' },
      { id: 'custom', label: 'Custom size', desc: 'Compress toward a target file size', trail: 'sliders' },
      { id: 'original', label: 'Original', desc: 'No compression — export at original size', trail: 'document' },
    ], settings.compressMode, (v) => { settings.compressMode = v; renderSub(); }, { icon: 'layers' });
    renderSub();
    return [modeGroup, sub];
  }

  function customSizeGroup() {
    const num = el('input', {
      class: 'bpx-exp__num', type: 'number', min: '0', step: 'any', inputmode: 'decimal',
      // Starts empty (placeholder only) — the user types their own target; no
      // preset number is shown.
      placeholder: 'e.g. 750', 'aria-label': 'Target size',
      value: settings.compressTargetValue > 0 ? String(settings.compressTargetValue) : '',
      // Any positive number is allowed (100, 400, 750, 1, 2, 5, 1.5, …) — no
      // preset sizes. Kept as a float so fractional MB targets work.
      onInput: (e) => { const v = parseFloat(e.target.value); settings.compressTargetValue = v > 0 ? v : 0; },
    });
    const unit = el('select', {
      class: 'bpx-exp__unit', 'aria-label': 'Size unit',
      onChange: (e) => { settings.compressTargetUnit = e.target.value; },
    }, [
      el('option', { value: 'KB', selected: settings.compressTargetUnit === 'KB' ? 'selected' : null }, 'KB'),
      el('option', { value: 'MB', selected: settings.compressTargetUnit === 'MB' ? 'selected' : null }, 'MB'),
    ]);
    return el('div', { class: 'bpx-exp__group' }, [
      el('div', { class: 'bpx-exp__group-title' }, 'Target file size'),
      el('div', { class: 'bpx-exp__sizerow' }, [num, unit]),
      el('p', { class: 'bpx-exp__hint' },
        'We’ll get as close to this size as possible while keeping the best quality. Very small targets may reduce sharpness.'),
    ]);
  }

  /* ---------------------------- conversion ------------------------------ */
  function statusEl() { return detail.querySelector('.bpx-exp__status'); }

  function setWorking(msg) {
    busy = true;
    overlay?.classList.add('is-busy');
    statusEl().replaceChildren(el('div', { class: 'bpx-exp__working' }, [
      el('span', { class: 'bpx-exp__spin' }), el('span', {}, msg || 'Working…'),
    ]));
  }
  function setError(msg) {
    busy = false;
    overlay?.classList.remove('is-busy');
    statusEl().replaceChildren(el('div', { class: 'bpx-exp__result is-error' }, [
      el('span', { class: 'bpx-exp__result-ico', html: renderIcon('close') }),
      el('div', {}, [
        el('div', { class: 'bpx-exp__result-lbl' }, 'Conversion failed'),
        el('div', { class: 'bpx-exp__result-sub' }, msg || 'Something went wrong. Please try again.'),
      ]),
    ]));
  }
  function setDone({ blob, filename, extra, warn }) {
    busy = false;
    overlay?.classList.remove('is-busy');
    const dl = () => { downloadBlob(blob, filename); };
    const main = el('div', { class: 'bpx-exp__result-main' }, [
      el('div', { class: 'bpx-exp__result-lbl' }, `${filename}`),
      el('div', { class: 'bpx-exp__result-sub' }, `${fmtBytes(blob.size)}${extra ? ` · ${extra}` : ''}`),
    ]);
    if (warn) main.appendChild(el('div', { class: 'bpx-exp__result-warn' }, warn));
    statusEl().replaceChildren(el('div', { class: 'bpx-exp__result is-ok' }, [
      el('span', { class: 'bpx-exp__result-ico', html: renderIcon('save') }),
      main,
      el('button', { class: 'bpx-exp__dl', type: 'button', onClick: dl }, [el('span', { html: renderIcon('save') }), 'Download']),
    ]));
    // The flow is Convert → Download; auto-start the download and also leave the
    // button so the user can save again.
    dl();
  }

  async function runConvert() {
    if (busy) return;
    const model = getModel();
    if (!modelHasVisibleContent(model)) {
      setError('This document is empty. Add or open a PDF first.');
      return;
    }
    const id = selectedId;
    const base = baseName();

    // Text-based targets need extractable text (a scanned PDF has none). Layout
    // Word / HTML can also carry the document's discrete images, so they only
    // need text OR images.
    const scannedMsg = 'No selectable text was found (the PDF may be scanned). Try PDF → JPG/PNG instead, or run OCR first.';
    if (id === 'excel' || id === 'ppt' || id === 'html' || id === 'word') {
      const content = buildContentModel(model, getDocName());
      // Original-Layout Word and HTML can carry the document's images, so they
      // only need text OR images; the text-first targets need real text.
      // Exact-Layout Word reproduces the page raster verbatim, so it is valid even
      // for a scanned/image-only PDF (nothing is lost — it just isn't editable text).
      // AI Layout also reads the page raster (the model looks at the image), so it
      // likewise doesn't require a pre-extracted text layer.
      const exactWord = id === 'word' && (settings.wordMode === 'exact' || settings.wordMode === 'ai');
      // PowerPoint lays each page down as a raster backdrop with the editable text on
      // top, so — like Exact/AI Word — it reproduces the page verbatim and is valid
      // even for a scanned/image-only PDF (it simply carries no editable text boxes).
      const exactLook = exactWord || id === 'ppt';
      const imagesOk = id === 'html' || (id === 'word' && settings.wordMode === 'layout');
      const ok = exactLook || (imagesOk ? (content.hasText || content.hasImages) : content.hasText);
      if (!ok) { setError(scannedMsg); return; }
    }

    try {
      if (id === 'compress') {
        // Original: no compression — export at full quality/size.
        if (settings.compressMode === 'original') {
          setWorking('Preparing…');
          const blob = await exportEditorToPdf(model);
          setDone({ blob, filename: `${base}.pdf`, extra: 'original size · no compression' });
          return;
        }
        // Custom size: any positive KB/MB value is the MAXIMUM output size. Find
        // the highest quality that fits; if it already fits, return unchanged.
        if (settings.compressMode === 'custom') {
          const target = settings.compressTargetValue * (settings.compressTargetUnit === 'MB' ? 1024 * 1024 : 1024);
          if (!(target > 0)) { setError('Enter a target size greater than 0.'); return; }
          setWorking('Compressing to target size…');
          const res = await compressToTarget(model, target, (m) => setWorking(m));
          // Verification failure is not fatal (the file is still usable), but the
          // user should know a page looked off after the page-by-page check.
          const verifyNote = res.verify.ok ? null : `check: ${res.verify.issues.join('; ')}`;
          if (res.unchanged) {
            // Target ≥ original: hand back the original, never inflated to match.
            setDone({ blob: res.blob, filename: `${base}.pdf`, extra: `original size · already within ${fmtBytes(target)} target`, warn: verifyNote });
          } else if (res.met) {
            setDone({
              blob: res.blob, filename: `${base}-compressed.pdf`,
              extra: `highest quality under ${fmtBytes(target)} target`,
              warn: res.warn || verifyNote,
            });
          } else {
            setDone({
              blob: res.blob, filename: `${base}-compressed.pdf`,
              extra: `smallest readable size — ${fmtBytes(target)} not reachable without destroying quality`,
              warn: res.warn || verifyNote,
            });
          }
          return;
        }
        // Reduce size (level-based) — the default.
        const lvl = COMPRESS_LEVELS.find((l) => l.id === settings.compressLevel) || COMPRESS_LEVELS[1];
        setWorking('Compressing…');
        // Baseline (standard-quality) size for an honest before/after comparison.
        const baseline = await exportEditorToPdf(model);
        const blob = await exportEditorToPdf(model, { scale: lvl.scale, quality: lvl.quality });
        const saved = baseline.size - blob.size;
        const pct = baseline.size ? Math.max(0, Math.round((saved / baseline.size) * 100)) : 0;
        setDone({ blob, filename: `${base}-compressed.pdf`, extra: saved > 0 ? `${pct}% smaller than ${fmtBytes(baseline.size)}` : 'already well compressed' });
        return;
      }
      if (id === 'word') {
        // AI Layout: an on-device model detects tables/paragraphs per page and the
        // PDF's own text fills them → real editable Word tables. Runs in a Worker;
        // first use downloads the model. Slower, but rebuilds true editable tables.
        if (settings.wordMode === 'ai') {
          // Recover the page's baked-in pictures (signature/photo/QR/logo) so the AI
          // rebuild can place them as real editable images. Best-effort → [] on fail.
          setWorking('Recovering images…');
          const extraImages = await extractBakedImages(model);
          setWorking('Loading AI model…');
          const blob = await convertToWordAI(model, {
            name: getDocName(),
            extraImages,
            onProgress: (done, total, msg) => setWorking(msg || `Analysing pages… ${done}/${total}`),
          });
          setDone({ blob, filename: `${base}.docx` });
          return;
        }
        // Exact Layout reproduces each page 1:1 (raster + editable text boxes at
        // true positions). We pre-erase the extracted glyphs from the raster so an
        // overlay box can't let the baked original bleed through in Google Docs.
        // Best-effort: masking failure just uses the original background.
        // Exact reproduces each page 1:1 from the raster (which already carries every
        // picture exactly), so it only needs the text-erased background — NOT recovered
        // images, which are best-effort and could drop a blank crop over real text.
        let cleanBg = null;
        if (settings.wordMode === 'exact') {
          setWorking('Preparing pages…');
          cleanBg = await maskExtractedText(model);
        }
        // The Editable Layout rebuilds vector-side, so the PDF's baked-in images
        // (photo, signature, QR, logos) must be recovered from the page raster and
        // placed as real pictures. Best-effort: recovery failure yields no images.
        let extraImages = null;
        if (settings.wordMode === 'layout') {
          setWorking('Recovering images…');
          extraImages = await extractBakedImages(model);
        }
        setWorking('Building Word document…');
        const blob = modelToDocx(model, { mode: settings.wordMode, name: getDocName(), extraImages, cleanBg });
        setDone({ blob, filename: `${base}.docx` });
        return;
      }
      if (id === 'excel') {
        setWorking('Building spreadsheet…');
        const blob = modelToXlsx(model, { name: getDocName() });
        setDone({ blob, filename: `${base}.xlsx` });
        return;
      }
      if (id === 'ppt') {
        // Exact-look slides: erase the extracted glyphs from each page raster so the
        // raster backdrop is clean under the editable text overlay (same masking the
        // Exact-Copy DOCX uses). Best-effort — a failure just uses the original bg.
        setWorking('Preparing pages…');
        const cleanBg = await maskExtractedText(model);
        setWorking('Building slides…');
        const blob = modelToPptx(model, { name: getDocName(), cleanBg });
        setDone({ blob, filename: `${base}.pptx` });
        return;
      }
      if (id === 'jpg' || id === 'png') {
        setWorking('Rendering pages…');
        const out = await modelToImages(model, {
          format: id, resolution: settings.imgRes, name: getDocName(),
          onProgress: (d, tot) => setWorking(`Rendering pages… ${d}/${tot}`),
        });
        setDone(out);
        return;
      }
      if (id === 'html') {
        setWorking('Building HTML…');
        const blob = modelToHtml(model, { name: getDocName() });
        setDone({ blob, filename: `${base}.html` });
        return;
      }
    } catch (err) {
      console.error('[export-convert]', id, err);
      setError(err && err.message ? err.message : 'Something went wrong. Please try again.');
    }
  }

  return {
    open,
    close,
    isOpen: () => !!overlay,
    destroy() { close(); },
  };
}
