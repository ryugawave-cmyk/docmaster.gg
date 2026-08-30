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

// Where the user last dragged the floating panel (viewport px, top-left). Remembered
// for the page session so re-opening Edit Data restores the panel where they left it,
// off to the side of the chart. Cleared implicitly on reload.
let lastPos = null;

export function openChartDataEditor({ chart, onPreview, onCommit, onClose }) {
  const spec = JSON.parse(JSON.stringify(chart));
  if (!Array.isArray(spec.categories)) spec.categories = [];
  if (!Array.isArray(spec.series) || !spec.series.length) spec.series = [{ name: 'Series 1', values: [], color: null }];
  if (!Array.isArray(spec.colors)) spec.colors = [];
  if (!spec.options || typeof spec.options !== 'object') spec.options = {};
  // Per-point custom labels the user types below each value (round-trips on the spec
  // and renders on the matching slice/bar/point via the chart engine's pointLabels).
  if (!spec.pointLabels || typeof spec.pointLabels !== 'object' || Array.isArray(spec.pointLabels)) spec.pointLabels = {};
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
        placeholder: numeric ? '' : `Category ${ri + 1}`,
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
    class: 'cde__val', type: 'text', inputmode: 'decimal', placeholder: '0',
    value: s.values[ri] == null ? '' : String(s.values[ri]),
    onInput: (e) => { setValueCell(s, ri, e.target.value); preview(); }, onChange: commit,
  });
  // The engine keys custom labels "p{i}" for per-point charts (pie/funnel/…) and
  // "s{si}p{i}" otherwise — match it so the label lands on the right slice/bar/point.
  const labelId = (si, ri) => (isPieLike ? `p${ri}` : `s${si}p${ri}`);
  // A value cell = the number PLUS a small "label" field beneath it, so anyone can
  // type their own number/text on that data point right here — no hidden gestures.
  const valueCell = (s, ri, si, withLabel = true) => {
    const num = valInput(s, ri);
    if (!withLabel) return num;
    const id = labelId(si, ri);
    const lbl = el('input', {
      class: 'cde__ptlbl', type: 'text', placeholder: 'label',
      value: (spec.pointLabels[id] != null ? String(spec.pointLabels[id]) : ''),
      onInput: (e) => {
        const v = e.target.value;
        if (v) spec.pointLabels[id] = v; else delete spec.pointLabels[id];
        preview();
      },
      onChange: commit,
    });
    return el('div', { class: 'cde__cellstack' }, [num, lbl]);
  };
  function setValueCell(s, ri, raw) {
    const str = String(raw);
    const num = parseFloat(str.replace(',', '.').replace(/[^0-9.\-]/g, ''));
    // Blank cell → null (no data), so the chart shows a placeholder slice instead of a 0.
    s.values[ri] = str.trim() === '' ? null : (Number.isFinite(num) ? num : 0);
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
        el('div', { class: 'cde__cell' }, valueCell(s, ri, 0)),
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
        el('div', { class: 'cde__cell' }, valueCell(spec.series[0], ri, 0)),
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
        ...spec.series.map((s, si) => el('div', { class: 'cde__cell' }, valueCell(s, ri, si))),
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
    // Blank new row (name + values) so the user fills it in; the input placeholders hint
    // the expected content, and a null value renders no slice until a number is typed.
    spec.categories.push(isScatter ? String(spec.categories.length + 1) : '');
    for (const s of spec.series) s.values.push(null);
    rebuild(); commit();
  }
  function addSeries() {
    spec.series.push({ name: `Series ${spec.series.length + 1}`, values: spec.categories.map(() => 0), color: null });
    rebuild(); commit();
  }

  const close = () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    panel.remove();
    onClose?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  /** A footer checkbox that turns a data-label option on/off live (so the user's own
   *  category names / values appear on the chart when they want them). */
  const labelToggle = (key, label) => el('label', { class: 'cde__toggle' }, [
    el('input', {
      type: 'checkbox', checked: !!spec.options[key],
      onChange: (e) => { spec.options[key] = e.target.checked; preview(); commit(); },
    }),
    el('span', {}, label),
  ]);

  // Series only make sense for multi-series cartesian families; pie/scatter have fixed columns.
  const canAddSeries = !isPieLike && !isScatter;

  /* --------------------- Y-Axis controls (numeric-axis charts) ---------------- *
   * Auto by default (the chart picks a nice 0→max range). Switch to Custom to set
   * an exact Min / Max / Interval, decimals, thousands grouping, label size, axis
   * title, and show/hide axis + gridlines. Validated live so the chart never breaks
   * (Min < Max, Interval > 0, numbers only). Only shown for families with a value
   * axis; pie/doughnut/funnel/radar/gauge don't get irrelevant controls.            */
  const AXIS_FAMS = ['bar', 'line', 'area', 'scatter', 'combo', 'waterfall', 'candlestick', 'pareto', 'histogram', 'boxplot'];
  const hasValueAxis = AXIS_FAMS.includes(fam);
  function axisControls() {
    const o = spec.options;
    const axNum = (label, key, opt = {}) => {
      const input = el('input', {
        class: 'cde__axnum', type: 'number', step: opt.step || 'any', min: opt.min, placeholder: opt.ph || '',
        value: o[key] == null ? '' : String(o[key]),
        onInput: (e) => {
          const s = e.target.value.trim();
          const n = parseFloat(s);
          o[key] = s === '' ? null : (Number.isFinite(n) ? n : null);
          validate(); preview();
        },
        onChange: commit,
      });
      return { field: el('label', { class: 'cde__axfield' }, [el('span', {}, label), input]), input };
    };
    const minF = axNum('Min', 'axisMin', { ph: '0' });
    const maxF = axNum('Max', 'axisMax', { ph: 'auto' });
    const stepF = axNum('Interval', 'axisStep', { ph: 'auto' });
    const decF = axNum('Decimals', 'axisDecimals', { ph: '0', step: '1', min: '0' });
    const sizeF = axNum('Label size', 'axisLabelSize', { ph: '10', step: '1', min: '6' });
    const customRow = el('div', { class: 'cde__axrow' }, [minF.field, maxF.field, stepF.field, decF.field, sizeF.field]);

    function validate() {
      const min = Number(o.axisMin), max = Number(o.axisMax), step = Number(o.axisStep);
      const badRange = Number.isFinite(min) && Number.isFinite(max) && max <= min;
      minF.input.classList.toggle('is-invalid', badRange);
      maxF.input.classList.toggle('is-invalid', badRange);
      stepF.input.classList.toggle('is-invalid', Number.isFinite(step) && step <= 0);
    }
    const autoBox = el('input', {
      type: 'checkbox', checked: o.axisAuto !== false,
      onChange: (e) => { o.axisAuto = e.target.checked; customRow.hidden = e.target.checked; preview(); commit(); },
    });
    customRow.hidden = o.axisAuto !== false;
    validate();

    const check = (key, label) => el('label', { class: 'cde__toggle' }, [
      el('input', { type: 'checkbox', checked: !!o[key], onChange: (e) => { o[key] = e.target.checked; preview(); commit(); } }),
      el('span', {}, label),
    ]);
    const titleInput = el('input', {
      class: 'cde__axtitle', type: 'text', placeholder: 'Axis title', value: o.axisTitleY || '',
      onInput: (e) => { o.axisTitleY = e.target.value; if (e.target.value) o.showAxisTitles = true; preview(); }, onChange: commit,
    });
    return el('div', { class: 'cde__axis' }, [
      el('div', { class: 'cde__axtop' }, [
        el('span', { class: 'cde__axcap' }, 'Y-Axis'),
        el('label', { class: 'cde__toggle' }, [autoBox, el('span', {}, 'Auto')]),
        check('showAxis', 'Axis'),
        check('showGridlines', 'Gridlines'),
        check('axisThousands', '1,000s'),
        check('showAxisTitles', 'Title'),
      ]),
      customRow,
      el('div', { class: 'cde__axrow' }, [
        el('label', { class: 'cde__axfield cde__axfield--wide' }, [el('span', {}, 'Title text'), titleInput]),
      ]),
    ]);
  }

  const panel = el('div', { class: 'cde', role: 'dialog', 'aria-label': 'Chart data' }, [
    el('div', { class: 'cde__head' }, [
      el('div', { class: 'cde__title' }, 'Chart data'),
      el('button', { class: 'cde__close', type: 'button', 'aria-label': 'Close', onClick: close, html: '&times;' }),
    ]),
    body,
    ...(hasValueAxis ? [axisControls()] : []),
    el('div', { class: 'cde__foot' }, [
      el('button', { class: 'cde__add', type: 'button', onClick: addRow }, `＋ ${rowWord}`),
      canAddSeries ? el('button', { class: 'cde__add', type: 'button', onClick: addSeries }, '＋ Series') : null,
      // Show-your-own-text/numbers: charts insert clean (no labels); tick these to
      // display the category names and/or the values you typed, right on the chart.
      el('div', { class: 'cde__labels' }, [
        el('span', { class: 'cde__labels-cap' }, 'Show'),
        labelToggle('showCatLabels', 'Names'),
        labelToggle('showDataLabels', 'Values'),
      ]),
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

  /* ------------------------ movable floating panel --------------------------- *
   * The panel floats over the editor (never a modal backdrop) so the chart stays
   * visible behind it; the user drags it by the header to any spot in the viewport
   * and keeps editing while watching the chart update. All chart-editing behaviour
   * above is untouched — this only positions the container.                       */
  const header = panel.querySelector('.cde__head');
  // Keep the panel from being dragged fully off-screen: always leave a strip of it
  // visible, and never push the header (the drag handle) past the top/bottom edges.
  const clampPos = (left, top) => {
    const r = panel.getBoundingClientRect();
    const keep = 48;
    const headH = header ? header.offsetHeight || 48 : 48;
    return {
      left: Math.min(window.innerWidth - keep, Math.max(keep - r.width, left)),
      top: Math.min(Math.max(0, window.innerHeight - headH), Math.max(0, top)),
    };
  };
  const applyPos = (left, top) => {
    const p = clampPos(left, top);
    panel.style.right = 'auto';
    panel.style.left = `${Math.round(p.left)}px`;
    panel.style.top = `${Math.round(p.top)}px`;
    lastPos = { left: p.left, top: p.top };
  };
  // Restore last session position (re-clamped to the current viewport); otherwise
  // keep the CSS default (top-right, beside the chart — not centre-locked).
  if (lastPos) applyPos(lastPos.left, lastPos.top);
  // Re-clamp on resize so a shrunk window can never strand the panel off-screen.
  function onResize() { if (lastPos) applyPos(lastPos.left, lastPos.top); }
  window.addEventListener('resize', onResize);

  let drag = null;
  header?.addEventListener('pointerdown', (e) => {
    // Don't start a drag from the close button; only the primary pointer/button.
    if (e.button !== 0 || e.target.closest('.cde__close')) return;
    const r = panel.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    panel.classList.add('is-dragging');
    header.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  header?.addEventListener('pointermove', (e) => {
    if (drag) applyPos(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    panel.classList.remove('is-dragging');
    header.releasePointerCapture?.(e.pointerId);
  };
  header?.addEventListener('pointerup', endDrag);
  header?.addEventListener('pointercancel', endDrag);

  document.addEventListener('keydown', onKey);
  return { close, element: panel };
}
