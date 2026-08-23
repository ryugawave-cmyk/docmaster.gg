/**
 * DOC editor Shape picker — a large, categorized, searchable Office-style shape
 * library (see editor/shapeLibrary.js). Opens as a modal; picking a shape calls
 * back with the shape id + chosen colour so the workspace can insert it (as an
 * SVG image, riding the existing image pipeline). Deliberately richer than the
 * PDF editor's basic shape palette, which is left untouched.
 */
import { el } from '../../../workspace/utils/dom.js';
import { SHAPE_CATEGORIES, shapesInCategory, searchShapes, shapeSvg } from '../../editor/shapeLibrary.js';

// A compact Office-like colour set; the first is the default.
const COLORS = [
  { name: 'Blue', fill: '#4472C4', stroke: '#2F528F' },
  { name: 'Orange', fill: '#ED7D31', stroke: '#AE5A21' },
  { name: 'Green', fill: '#70AD47', stroke: '#4E7A31' },
  { name: 'Gold', fill: '#FFC000', stroke: '#BF9000' },
  { name: 'Red', fill: '#C00000', stroke: '#800000' },
  { name: 'Purple', fill: '#7030A0', stroke: '#4E2270' },
  { name: 'Gray', fill: '#808080', stroke: '#404040' },
  { name: 'Outline', fill: '#ffffff', stroke: '#333333' },
];

export function openShapePicker({ onPick }) {
  let color = COLORS[0];
  let activeCat = SHAPE_CATEGORIES[0].id;
  let query = '';

  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  /* --- tiles grid --- */
  const grid = el('div', { class: 'dsp__grid' });
  const groupTitle = el('div', { class: 'dsp__group-title' });

  function tile(shape) {
    const b = el('button', {
      class: 'dsp-tile', type: 'button', title: shape.name, 'aria-label': shape.name,
      onMousedown: (e) => e.preventDefault(),
      onClick: () => { close(); onPick({ id: shape.id, fill: color.fill, stroke: color.stroke }); },
    }, [
      el('span', { class: 'dsp-tile__svg', html: shapeSvg(shape.id, { width: 46, height: 34, fill: color.fill, stroke: color.stroke }) }),
      el('span', { class: 'dsp-tile__name' }, shape.name),
    ]);
    return b;
  }

  function renderGrid() {
    grid.replaceChildren();
    if (query.trim()) {
      const results = searchShapes(query);
      groupTitle.textContent = results.length ? `Results (${results.length})` : 'No shapes found';
      for (const s of results) grid.appendChild(tile(s));
    } else {
      const cat = SHAPE_CATEGORIES.find((c) => c.id === activeCat);
      groupTitle.textContent = cat.name;
      for (const s of shapesInCategory(activeCat)) grid.appendChild(tile(s));
    }
  }

  /* --- category rail --- */
  const catList = el('div', { class: 'dsp__cats' },
    SHAPE_CATEGORIES.map((c) => el('button', {
      class: `dsp__cat${c.id === activeCat ? ' is-active' : ''}`, type: 'button', dataset: { cat: c.id },
      onMousedown: (e) => e.preventDefault(),
      onClick: () => {
        activeCat = c.id; query = ''; search.value = '';
        catList.querySelectorAll('.dsp__cat').forEach((b) => b.classList.toggle('is-active', b.dataset.cat === c.id));
        renderGrid();
      },
    }, c.name)));

  /* --- search --- */
  const search = el('input', {
    class: 'dsp__search', type: 'search', placeholder: 'Search shapes…', 'aria-label': 'Search shapes',
    onInput: (e) => { query = e.target.value; renderGrid(); },
  });

  /* --- colour swatches --- */
  const swatches = el('div', { class: 'dsp__colors' },
    COLORS.map((c) => el('button', {
      class: `dsp__color${c === color ? ' is-active' : ''}`, type: 'button', title: c.name, 'aria-label': `${c.name} colour`,
      style: `background:${c.fill};border-color:${c.stroke}`,
      onMousedown: (e) => e.preventDefault(),
      onClick: () => {
        color = c;
        swatches.querySelectorAll('.dsp__color').forEach((b, i) => b.classList.toggle('is-active', COLORS[i] === c));
        renderGrid(); // re-tint previews
      },
    })));

  const dialog = el('div', { class: 'dsp', role: 'dialog', 'aria-label': 'Insert shape', onClick: (e) => e.stopPropagation() }, [
    el('div', { class: 'dsp__head' }, [
      el('div', { class: 'dsp__title' }, 'Shapes'),
      search,
      el('div', { class: 'dsp__colors-wrap' }, swatches),
      el('button', { class: 'dsp__close', type: 'button', 'aria-label': 'Close', onClick: close, html: '&times;' }),
    ]),
    el('div', { class: 'dsp__body' }, [catList, el('div', { class: 'dsp__main' }, [groupTitle, grid])]),
  ]);

  const backdrop = el('div', { class: 'dsp__backdrop', onClick: close }, dialog);
  renderGrid();
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  setTimeout(() => search.focus(), 0);
  return { close };
}
