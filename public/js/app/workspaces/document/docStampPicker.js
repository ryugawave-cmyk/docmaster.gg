/**
 * DOC editor Stamp picker — the same categorized, searchable stamp library the
 * PDF editor uses (see editor/stampLibrary.js), presented as a modal. Picking a
 * stamp calls back with its definition so the workspace can drop it into the
 * document (as an SVG image, riding the existing image pipeline). Reuses the
 * Shapes picker's modal shell (.dsp) for a consistent look.
 */
import { el } from '../../../workspace/utils/dom.js';
import { renderIcon } from '../../../workspace/icons.js';
import { STAMP_CATEGORIES, stampSvgMarkup, makeStampDef } from '../../editor/stampLibrary.js';

// Stamps the user adds this session — kept module-level so they persist across
// re-opens of the picker (matching the PDF editor's behaviour).
const customStamps = [];

export function openStampPicker({ onPick }) {
  let activeCat = 'all';
  let query = '';

  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  const grid = el('div', { class: 'dstp__grid' });
  const groupTitle = el('div', { class: 'dsp__group-title' });
  const catList = el('div', { class: 'dsp__cats' });

  const allCats = () => STAMP_CATEGORIES
    .concat(customStamps.length ? [{ id: 'custom', name: 'Custom', stamps: customStamps }] : []);

  function tile(def) {
    return el('button', {
      class: 'dstp-tile', type: 'button', title: def.text, 'aria-label': def.text,
      onMousedown: (e) => e.preventDefault(),
      onClick: () => { close(); onPick(def); },
    }, el('span', { class: 'dstp-tile__art', html: stampSvgMarkup(def) }));
  }

  function renderGrid() {
    const q = query.trim().toLowerCase();
    const defs = allCats()
      .filter((c) => activeCat === 'all' || c.id === activeCat)
      .flatMap((c) => c.stamps)
      .filter((d) => !q || d.text.toLowerCase().includes(q));
    groupTitle.textContent = q
      ? (defs.length ? `Results (${defs.length})` : 'No stamps found')
      : (allCats().find((c) => c.id === activeCat)?.name || 'All stamps');
    grid.replaceChildren(...(defs.length
      ? defs.map((d) => tile(d))
      : [el('div', { class: 'dstp__empty' }, 'No stamps match your search.')]));
  }

  function renderCats() {
    const cats = [{ id: 'all', name: 'All' }, ...STAMP_CATEGORIES.map((c) => ({ id: c.id, name: c.name })),
      ...(customStamps.length ? [{ id: 'custom', name: 'Custom' }] : [])];
    catList.replaceChildren(...cats.map((c) => el('button', {
      class: `dsp__cat${c.id === activeCat ? ' is-active' : ''}`, type: 'button', dataset: { cat: c.id },
      onMousedown: (e) => e.preventDefault(),
      onClick: () => { activeCat = c.id; renderCats(); renderGrid(); },
    }, c.name)));
  }

  const addCustom = () => {
    const text = (window.prompt('Custom stamp text', '') || '').trim();
    if (!text) return;
    const def = makeStampDef(text.toUpperCase(), 'double', '#dc2626');
    customStamps.unshift(def);
    activeCat = 'custom'; query = ''; search.value = '';
    renderCats(); renderGrid();
  };

  const search = el('input', {
    class: 'dsp__search', type: 'search', placeholder: 'Search stamps…', 'aria-label': 'Search stamps',
    onInput: (e) => { query = e.target.value; renderGrid(); },
  });

  const dialog = el('div', { class: 'dsp', role: 'dialog', 'aria-label': 'Insert stamp', onClick: (e) => e.stopPropagation() }, [
    el('div', { class: 'dsp__head' }, [
      el('div', { class: 'dsp__title' }, 'Stamps'),
      search,
      el('button', { class: 'dsp__close', type: 'button', 'aria-label': 'Close', onClick: close, html: '&times;' }),
    ]),
    el('div', { class: 'dsp__body' }, [catList, el('div', { class: 'dsp__main' }, [groupTitle, grid])]),
    el('div', { class: 'dstp__foot' }, [
      el('button', { class: 'dstp__add', type: 'button', onMousedown: (e) => e.preventDefault(), onClick: addCustom },
        [el('span', { class: 'dstp__add-ico', html: renderIcon('plus') }), 'Add Custom Stamp']),
    ]),
  ]);

  const backdrop = el('div', { class: 'dsp__backdrop', onClick: close }, dialog);
  renderCats();
  renderGrid();
  document.body.appendChild(backdrop);
  document.addEventListener('keydown', onKey);
  setTimeout(() => search.focus(), 0);
  return { close };
}
