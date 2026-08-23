/**
 * Professional Library — chart picker panel.
 *
 * A polished, categorised, searchable library dedicated (initially) to charts,
 * graphs and data visualisation. This is a SEPARATE tool from the Shapes picker
 * (docShapePicker.js) and shares none of its state — the architecture below (a
 * flat catalogue of "resources" grouped into sections) is deliberately generic so
 * the Professional Library can grow future resource kinds without touching Shapes.
 *
 * Layout: an icon'd category rail on the left (with a "coming soon" promo card)
 * and a single scrollable canvas on the right that shows EVERY category at once as
 * a titled, horizontally-scrollable strip — Pie/Column/Bar as full-width rows, then
 * Line/Area/Scatter as a compact tri-column, then Other. Clicking a category scrolls
 * its section into view; scrolling the canvas highlights the category in view.
 *
 * Picking a chart calls back with the chart type id; the workspace turns that into
 * a real editable chart object via editor.insertChart(defaultChart(id)).
 */
import { el } from '../../../workspace/utils/dom.js';
import { CHART_CATALOG, chartTypeLabel } from '../../editor/chartRender.js';
// Premium 3D-styled PREVIEW thumbnails — separate from the real chart engine, so
// inserting still builds a real editable chart (see chartThumbs.js header).
import { chartThumb, isThumb3D } from './chartThumbs.js';

/* ---- inline icons (stroke, currentColor) — category rail + chrome ---- */
const IC = {
  pie: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M12 3v9"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>',
  column: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V11"/><path d="M12 21V4"/><path d="M19 21v-7"/></svg>',
  bar: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h14"/><path d="M3 12h9"/><path d="M3 19h17"/></svg>',
  line: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 3 6-8"/><circle cx="8" cy="11" r="1.2"/><circle cx="12" cy="14" r="1.2"/></svg>',
  area: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 16l4-5 4 3 4-6 5 4v5H3z"/></svg>',
  scatter: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="15" r="1.6"/><circle cx="11" cy="9" r="1.6"/><circle cx="15" cy="16" r="1.6"/><circle cx="18" cy="7" r="1.6"/></svg>',
  other: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 4v8l5 3"/></svg>',
  financial: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16"/><path d="M7 8h3v8H7"/><path d="M15 4v16"/><path d="M15 6h3v6h-3"/></svg>',
  business: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V9l7-5 7 5v12"/><path d="M10 21v-6h4v6"/></svg>',
  statistical: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V4"/><path d="M4 20h16"/><rect x="8" y="9" width="3" height="6"/><path d="M9.5 6v3"/><path d="M9.5 15v3"/></svg>',
  hierarchy: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="4" rx="1"/><rect x="3" y="16" width="6" height="4" rx="1"/><rect x="15" y="16" width="6" height="4" rx="1"/><path d="M12 7v5M12 12H6v4M12 12h6v4"/></svg>',
  project: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h9"/><path d="M4 12h13"/><path d="M4 18h7"/><circle cx="18" cy="6" r="1.4"/><circle cx="20" cy="12" r="1.4"/></svg>',
};
const IC_SEARCH = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>';
const IC_CHEVRON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
const IC_STAR = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.2 5.2L20 9l-4 3.6L17 19l-5-3-5 3 1-6.4L4 9l5.8-.8z"/></svg>';

// How the right-hand canvas lays out the catalogue: 'row' groups are full-width
// strips; a 'cols' group renders its categories side-by-side as compact columns.
// Every category is a full-width scrollable row so the rail buttons all jump to a
// distinct, properly-sized section (consistent across the whole expanded library).
const LAYOUT = [
  { kind: 'row', cats: ['pie'] },
  { kind: 'row', cats: ['column'] },
  { kind: 'row', cats: ['bar'] },
  { kind: 'row', cats: ['line'] },
  { kind: 'row', cats: ['area'] },
  { kind: 'row', cats: ['scatter'] },
  { kind: 'row', cats: ['financial'] },
  { kind: 'row', cats: ['business'] },
  { kind: 'row', cats: ['statistical'] },
  { kind: 'row', cats: ['hierarchy'] },
  { kind: 'row', cats: ['project'] },
  { kind: 'row', cats: ['other'] },
];
const catById = (id) => CHART_CATALOG.find((c) => c.id === id);

export function openChartPicker({ onPick }) {
  let query = '';
  let activeCat = CHART_CATALOG[0].id;
  const sections = [];            // [{ id, node }] — for scroll-to + scroll-spy
  const catButtons = new Map();   // id -> sidebar button

  const close = () => { document.removeEventListener('keydown', onKey); backdrop.remove(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  /* -------------------------------- tiles -------------------------------- */
  function tile(typeId, compact = false) {
    const preview = el('span', { class: 'prolib-tile__svg', html: chartThumb(typeId) });
    if (isThumb3D(typeId)) preview.appendChild(el('span', { class: 'prolib-tile__badge' }, '3D'));
    return el('button', {
      class: `prolib-tile${compact ? ' is-compact' : ''}${isThumb3D(typeId) ? ' is-3d' : ''}`,
      type: 'button', title: chartTypeLabel(typeId), 'aria-label': chartTypeLabel(typeId),
      onMousedown: (e) => e.preventDefault(),
      onClick: () => { close(); onPick(typeId); },
    }, [preview, el('span', { class: 'prolib-tile__name' }, chartTypeLabel(typeId))]);
  }

  /* --------------------------- section builders -------------------------- */
  function secHead(name, strip, small = false) {
    return el('div', { class: `prolib__sec-head${small ? ' is-sm' : ''}` }, [
      el('h3', { class: 'prolib__sec-title' }, name),
      el('button', {
        class: 'prolib__sec-arrow', type: 'button', 'aria-label': `Scroll ${name}`,
        onMousedown: (e) => e.preventDefault(),
        onClick: () => strip.scrollBy({ left: Math.max(220, strip.clientWidth * 0.8), behavior: 'smooth' }),
        html: IC_CHEVRON,
      }),
    ]);
  }

  function rowSection(cat) {
    const strip = el('div', { class: 'prolib__strip' }, cat.items.map((id) => tile(id)));
    const node = el('div', { class: 'prolib__section', dataset: { cat: cat.id } }, [secHead(cat.name, strip), strip]);
    sections.push({ id: cat.id, node });
    return node;
  }

  function colsGroup(ids) {
    const cols = ids.map((id) => {
      const cat = catById(id);
      const strip = el('div', { class: 'prolib__strip is-compact' }, cat.items.map((t) => tile(t, true)));
      const node = el('div', { class: 'prolib__col', dataset: { cat: cat.id } }, [secHead(cat.name, strip, true), strip]);
      sections.push({ id: cat.id, node });
      return node;
    });
    return el('div', { class: 'prolib__cols' }, cols);
  }

  const sectionsWrap = el('div', { class: 'prolib__sections' },
    LAYOUT.map((g) => (g.kind === 'cols' ? colsGroup(g.cats) : rowSection(catById(g.cats[0])))));

  /* ------------------------------ search view ---------------------------- */
  const resultsGrid = el('div', { class: 'prolib__grid' });
  const resultsTitle = el('div', { class: 'prolib__group-title' });
  const resultsWrap = el('div', { class: 'prolib__results', hidden: true }, [resultsTitle, resultsGrid]);

  const allTypes = () => CHART_CATALOG.flatMap((c) => c.items.map((id) => ({ id, cat: c.name })));

  function renderSearch() {
    const q = query.trim().toLowerCase();
    if (!q) { resultsWrap.hidden = true; sectionsWrap.hidden = false; return; }
    sectionsWrap.hidden = true; resultsWrap.hidden = false;
    const results = allTypes().filter((t) => chartTypeLabel(t.id).toLowerCase().includes(q) || t.cat.toLowerCase().includes(q));
    resultsTitle.textContent = results.length ? `Results (${results.length})` : 'No charts found';
    resultsGrid.replaceChildren(...results.map((t) => tile(t.id)));
  }

  /* --------------------------- category rail ----------------------------- */
  function setActive(id, doScroll) {
    if (id === activeCat && !doScroll) return;
    activeCat = id;
    catButtons.forEach((btn, cid) => btn.classList.toggle('is-active', cid === id));
    if (doScroll) {
      const sec = sections.find((s) => s.id === id);
      if (sec) {
        const top = sec.node.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 6;
        main.scrollTo({ top, behavior: 'smooth' });
      }
    }
  }

  const catRail = el('div', { class: 'prolib__cats' }, [
    el('div', { class: 'prolib__cats-head' }, 'Categories'),
    ...CHART_CATALOG.map((c) => {
      const btn = el('button', {
        class: `prolib__cat${c.id === activeCat ? ' is-active' : ''}`, type: 'button', dataset: { cat: c.id },
        onMousedown: (e) => e.preventDefault(),
        onClick: () => { if (query) { query = ''; search.value = ''; renderSearch(); } setActive(c.id, true); },
      }, [el('span', { class: 'prolib__cat-ic', html: IC[c.id] || IC.other }), el('span', {}, c.name)]);
      catButtons.set(c.id, btn);
      return btn;
    }),
    el('div', { class: 'prolib__promo' }, [
      el('div', { class: 'prolib__promo-ic', html: IC_STAR }),
      el('div', { class: 'prolib__promo-title' }, 'More professional resources coming soon'),
      el('div', { class: 'prolib__promo-text' }, 'Advanced diagrams, infographics, timelines and more.'),
    ]),
  ]);

  const search = el('input', {
    class: 'prolib__search', type: 'search', placeholder: 'Search charts…', 'aria-label': 'Search charts',
    onInput: (e) => { query = e.target.value; renderSearch(); },
  });

  const main = el('div', { class: 'prolib__main' }, [sectionsWrap, resultsWrap]);

  // Scroll-spy: highlight whichever section sits nearest the top of the canvas.
  let raf = 0;
  main.addEventListener('scroll', () => {
    if (raf || !resultsWrap.hidden) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const top = main.getBoundingClientRect().top + 12;
      let best = null, bestDist = Infinity;
      for (const s of sections) {
        const r = s.node.getBoundingClientRect();
        const dist = Math.abs(r.top - top);
        if (r.bottom > top && dist < bestDist) { bestDist = dist; best = s.id; }
      }
      if (best) setActive(best, false);
    });
  });

  const dialog = el('div', { class: 'prolib', role: 'dialog', 'aria-label': 'Professional Library', onClick: (e) => e.stopPropagation() }, [
    el('div', { class: 'prolib__head' }, [
      el('div', { class: 'prolib__brand' }, [
        el('div', { class: 'prolib__title' }, 'Professional Library'),
        el('div', { class: 'prolib__subtitle' }, 'Charts, graphs & data visualization'),
      ]),
      el('div', { class: 'prolib__search-wrap' }, [
        el('span', { class: 'prolib__search-ic', html: IC_SEARCH }),
        search,
      ]),
      el('button', { class: 'prolib__close', type: 'button', 'aria-label': 'Close', onClick: close, html: '&times;' }),
    ]),
    el('div', { class: 'prolib__body' }, [catRail, main]),
  ]);

  const backdrop = el('div', { class: 'prolib__backdrop', onClick: close }, dialog);
  renderSearch();
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  setTimeout(() => search.focus(), 0);
  return { close };
}
