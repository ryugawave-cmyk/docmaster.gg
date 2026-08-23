/**
 * Chart Data Editor — ONE reusable, type-adaptive spreadsheet for ANY Professional
 * Library chart. It reads the same structured chart spec every chart uses (categories,
 * series[{name,values,color}], colors[], options) and shapes its columns to the chart
 * FAMILY so the right data is editable for each type:
 *
 *   • Pie / Doughnut / Funnel / Waterfall (per-point) → Category | Value | Color
 *   • Scatter / Bubble                                → X Value | Y Value [| Size]
 *   • Column / Bar / Line / Area / Combo / Radar      → Category | Series 1 | Series 2 …
 *
 * It never flattens anything: edits mutate the shared model and re-render live (2D or
 * 3D — same data). `onPreview` fires per keystroke; structural edits/blur `onCommit`
 * so undo/redo capture them. Works on a deep clone so cancelling is clean.
 */
import { el } from '../../workspace/utils/dom.js';
import { TYPE_META, PALETTES, PER_POINT_FAMILIES } from './chartRender.js';

const HEX = (c) => { const m = /^#?([0-9a-fA-F]{6})$/.exec(String(c || '')); return m ? `#${m[1]}` : '#4472c4'; };

export function openChartDataEditor({ chart, onPreview, onCommit, onClose }) {
  const spec = JSON.parse(JSON.stringify(chart));
  if (!Array.isArray(spec.categories)) spec.categories = [];
  if (!Array.isArray(spec.series) || !spec.series.length) spec.series = [{ name: 'Series 1', values: [], color: null }];
  if (!Array.isArray(spec.colors)) spec.colors = [];
  if (!spec.options || typeof spec.options !== 'object') spec.options = {};
  let unitInput = null; // the shared "Unit" field (assigned when the panel is built)

  // Shape the editor to the chart family (the ONE model, viewed the right way).
  const meta = TYPE_META[spec.type] || {};
  const fam = meta.family || 'bar';
  const isPieLike = PER_POINT_FAMILIES.includes(fam); // per-point → Category | Value | Color
  const isScatter = fam === 'scatter';
  const isBubble = !!meta.bubble;
  if (isScatter) {
    if (!spec.series[0]) spec.series[0] = { name: 'Y', values: [], color: null };
    if (isBubble && !spec.series[1]) spec.series[1] = { name: 'Size', values: [], color: null };
  }

  // Square off the grid so every series has one value per row/point.
  const nRows = Math.max(spec.categories.length, ...spec.series.map((s) => s.values.length), 1);
  while (spec.categories.length < nRows) spec.categories.push(isScatter ? String(spec.categories.length + 1) : `Category ${spec.categories.length + 1}`);
  for (const s of spec.series) while (s.values.length < nRows) s.values.push(0);

  const pal = (spec.options && PALETTES[spec.options.palette]) || PALETTES.office;
  const clone = () => JSON.parse(JSON.stringify(spec));
  const preview = () => onPreview?.(clone());
  const commit = () => onCommit?.(clone());

  const body = el('div', { class: 'cde__table' });
  const rowWord = isPieLike ? 'Slice' : isScatter ? 'Point' : 'Row';

  /* ------------------------------ cell factories ------------------------------ */
  function rowHeaderCell(cat, ri, numeric) {
    return el('div', { class: 'cde__cell cde__cell--rowhdr' }, [
      el('input', {
        class: 'cde__cat', type: numeric ? 'number' : 'text', step: 'any', value: cat,
        onInput: (e) => { spec.categories[ri] = e.target.value; preview(); }, onChange: commit,
      }),
      el('div', { class: 'cde__rowctl' }, [
        el('button', { class: 'cde__mini', type: 'button', title: 'Move up', disabled: ri === 0, onClick: () => moveRow(ri, -1) }, '▲'),
        el('button', { class: 'cde__mini', type: 'button', title: 'Move down', disabled: ri === spec.categories.length - 1, onClick: () => moveRow(ri, 1) }, '▼'),
        el('button', { class: 'cde__mini cde__mini--del', type: 'button', title: `Delete ${rowWord.toLowerCase()}`, onClick: () => delRow(ri) }, '🗑'),
      ]),
    ]);
  }
  // Text (not number) so a user CAN type units like "30%" or "12 kg"; the numeric part
  // drives the chart, and any trailing unit is captured into options.valueUnit (which the
  // renderer appends to every value label). Keeps the value numeric for the maths.
  const valInput = (s, ri) => el('input', {
    class: 'cde__val', type: 'text', inputmode: 'decimal', value: s.values[ri] == null ? '' : String(s.values[ri]),
    onInput: (e) => { setValueCell(s, ri, e.target.value); preview(); }, onChange: commit,
  });
  function setValueCell(s, ri, raw) {
    const str = String(raw);
    const num = parseFloat(str.replace(',', '.').replace(/[^0-9.\-]/g, ''));
    s.values[ri] = Number.isFinite(num) ? num : 0;
    const suffix = str.replace(/[0-9.,\s\-]/g, '').trim(); // e.g. "30%" → "%"
    if (suffix) { spec.options.valueUnit = suffix; if (unitInput) unitInput.value = suffix; }
  }
  const colorInput = (ri) => el('input', {
    class: 'cde__color', type: 'color', title: 'Slice colour', value: HEX(spec.colors[ri] || pal[ri % pal.length]),
    onInput: (e) => { spec.colors[ri] = e.target.value; preview(); }, onChange: commit,
  });

  /* -------------------------------- rebuild ---------------------------------- */
  function rebuild() {
    let head; let rows;
    if (isPieLike) {
      head = el('div', { class: 'cde__row cde__row--head' }, [
        el('div', { class: 'cde__cell cde__cell--rowhdr' }, 'Category'),
        el('div', { class: 'cde__cell' }, 'Value'),
        el('div', { class: 'cde__cell' }, 'Color'),
      ]);
      const s = spec.series[0];
      rows = spec.categories.map((cat, ri) => el('div', { class: 'cde__row' }, [
        rowHeaderCell(cat, ri, false),
        el('div', { class: 'cde__cell' }, valInput(s, ri)),
        el('div', { class: 'cde__cell' }, colorInput(ri)),
      ]));
    } else if (isScatter) {
      head = el('div', { class: 'cde__row cde__row--head' }, [
        el('div', { class: 'cde__cell cde__cell--rowhdr' }, 'X Value'),
        el('div', { class: 'cde__cell' }, 'Y Value'),
        ...(isBubble ? [el('div', { class: 'cde__cell' }, 'Size')] : []),
      ]);
      rows = spec.categories.map((cat, ri) => el('div', { class: 'cde__row' }, [
        rowHeaderCell(cat, ri, true),
        el('div', { class: 'cde__cell' }, valInput(spec.series[0], ri)),
        ...(isBubble ? [el('div', { class: 'cde__cell' }, valInput(spec.series[1], ri))] : []),
      ]));
    } else {
      // Multi-series cartesian: Category | Series 1 | Series 2 | …
      head = el('div', { class: 'cde__row cde__row--head' }, [
        el('div', { class: 'cde__cell cde__cell--rowhdr' }, 'Category'),
        ...spec.series.map((s, si) => el('div', { class: 'cde__cell cde__cell--serieshdr' }, [
          el('input', {
            class: 'cde__sname', type: 'text', value: s.name || `Series ${si + 1}`,
            onInput: (e) => { s.name = e.target.value; preview(); }, onChange: commit,
          }),
          spec.series.length > 1 ? el('button', {
            class: 'cde__x', type: 'button', title: 'Delete series', 'aria-label': 'Delete series',
            onClick: () => { spec.series.splice(si, 1); rebuild(); commit(); },
          }, '×') : null,
        ].filter(Boolean))),
      ]);
      rows = spec.categories.map((cat, ri) => el('div', { class: 'cde__row' }, [
        rowHeaderCell(cat, ri, false),
        ...spec.series.map((s) => el('div', { class: 'cde__cell' }, valInput(s, ri))),
      ]));
    }
    body.replaceChildren(head, ...rows);
  }

  /* --------------------------- structural edits ------------------------------ */
  function moveRow(ri, dir) {
    const to = ri + dir;
    if (to < 0 || to >= spec.categories.length) return;
    [spec.categories[ri], spec.categories[to]] = [spec.categories[to], spec.categories[ri]];
    for (const s of spec.series) [s.values[ri], s.values[to]] = [s.values[to], s.values[ri]];
    if (spec.colors.length) [spec.colors[ri], spec.colors[to]] = [spec.colors[to], spec.colors[ri]];
    rebuild(); commit();
  }
  function delRow(ri) {
    if (spec.categories.length <= 1) return;
    spec.categories.splice(ri, 1);
    for (const s of spec.series) s.values.splice(ri, 1);
    if (spec.colors.length) spec.colors.splice(ri, 1); // per-point colours shift with rows
    rebuild(); commit();
  }
  function addRow() {
    spec.categories.push(isScatter ? String(spec.categories.length + 1) : `Category ${spec.categories.length + 1}`);
    for (const s of spec.series) s.values.push(0);
    rebuild(); commit();
  }
  function addSeries() {
    spec.series.push({ name: `Series ${spec.series.length + 1}`, values: spec.categories.map(() => 0), color: null });
    rebuild(); commit();
  }

  const close = () => { document.removeEventListener('keydown', onKey); panel.remove(); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  // Series only make sense for multi-series cartesian families; pie/scatter have fixed columns.
  const canAddSeries = !isPieLike && !isScatter;
  const panel = el('div', { class: 'cde', role: 'dialog', 'aria-label': 'Chart data' }, [
    el('div', { class: 'cde__head' }, [
      el('div', { class: 'cde__title' }, 'Chart data'),
      el('button', { class: 'cde__close', type: 'button', 'aria-label': 'Close', onClick: close, html: '&times;' }),
    ]),
    body,
    el('div', { class: 'cde__foot' }, [
      el('button', { class: 'cde__add', type: 'button', onClick: addRow }, `＋ ${rowWord}`),
      canAddSeries ? el('button', { class: 'cde__add', type: 'button', onClick: addSeries }, '＋ Series') : null,
      el('label', { class: 'cde__unit' }, [
        el('span', {}, 'Unit'),
        (unitInput = el('input', {
          class: 'cde__unitin', type: 'text', maxLength: 6, placeholder: 'e.g. %', value: spec.options.valueUnit || '',
          onInput: (e) => { spec.options.valueUnit = e.target.value; preview(); }, onChange: commit,
        })),
      ]),
      el('span', { class: 'cde__spacer' }),
      el('button', { class: 'cde__done', type: 'button', onClick: close }, 'Done'),
    ].filter(Boolean)),
  ]);

  rebuild();
  document.body.appendChild(panel);
  document.addEventListener('keydown', onKey);
  return { close, element: panel };
}
