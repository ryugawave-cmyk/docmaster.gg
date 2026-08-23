/**
 * Declarative control renderer.
 *
 * Turns a flat list of control descriptors (the same schema language the old
 * tool panels used — heading/note/select/text/number/range/color/segment/
 * checkbox/button) into DOM. Extracted from the original properties panel so
 * BOTH the contextual properties panel and any future inline panels can share
 * one renderer. It is purely presentational: values come in via `getValue`,
 * changes go out via `onChange`.
 *
 * @param {object[]} schema
 * @param {object} opts
 * @param {(key:string)=>any} opts.getValue
 * @param {(key:string, value:any)=>void} opts.onChange
 * @param {(action:string)=>void} [opts.onAction]  for `button` controls
 * @returns {DocumentFragment}
 */
import { el } from '../../workspace/utils/dom.js';
import { renderIcon } from '../../workspace/icons.js';

export function renderControls(schema, opts) {
  const frag = document.createDocumentFragment();
  for (const section of toSections(schema || [])) {
    frag.appendChild(renderSection(section, opts));
  }
  return frag;
}

/** Split a flat list into collapsible sections keyed by `heading` controls. */
function toSections(schema) {
  const sections = [];
  let current = { title: null, controls: [] };
  for (const control of schema) {
    if (control.type === 'heading') {
      if (current.controls.length) sections.push(current);
      current = { title: control.text, controls: [] };
    } else {
      current.controls.push(control);
    }
  }
  if (current.controls.length) sections.push(current);
  return sections;
}

// Remembers which cards the user collapsed for the session.
const collapsed = new Map();

function renderSection(section, opts) {
  const controls = section.controls.map((c) => buildControl(c, opts)).filter(Boolean);
  const pad = el('div', { class: 'ws-card__pad' }, controls);

  if (!section.title) return el('section', { class: 'ws-card' }, pad);

  const key = section.title;
  const isCollapsed = collapsed.get(key) === true;
  const card = el('section', { class: `ws-card${isCollapsed ? ' is-collapsed' : ''}` });
  const bodyWrap = el('div', { class: 'ws-card__body' }, el('div', { class: 'ws-card__inner' }, pad));
  const chevron = el('span', { class: 'ws-card__chevron', html: renderIcon('chevron') });
  const head = el(
    'button',
    {
      class: 'ws-card__head',
      type: 'button',
      'aria-expanded': String(!isCollapsed),
      onClick: () => {
        const next = !card.classList.contains('is-collapsed');
        card.classList.toggle('is-collapsed', next);
        head.setAttribute('aria-expanded', String(!next));
        collapsed.set(key, next);
      },
    },
    [el('span', { class: 'ws-card__title' }, section.title), chevron]
  );
  card.appendChild(head);
  card.appendChild(bodyWrap);
  return card;
}

function buildControl(control, opts) {
  const { getValue, onChange, onAction } = opts;
  const value = () => {
    const v = getValue ? getValue(control.key) : undefined;
    return v === undefined ? control.default : v;
  };
  const set = (v) => onChange && onChange(control.key, v);

  switch (control.type) {
    case 'note':
      return el('p', { class: 'ws-note' }, control.text);

    case 'select': {
      const select = el(
        'select',
        { class: 'ws-select', onChange: (e) => set(e.target.value) },
        control.options.map((opt) =>
          el('option', { value: opt.value, selected: opt.value === value() }, opt.label)
        )
      );
      return field(control.label, select);
    }

    case 'text':
    case 'password': {
      const input = el('input', {
        class: 'ws-input',
        type: control.type,
        placeholder: control.placeholder || '',
        value: value() || '',
        onInput: (e) => set(e.target.value),
      });
      return field(control.label, input);
    }

    case 'textarea': {
      const ta = el('textarea', {
        class: 'ws-textarea',
        placeholder: control.placeholder || '',
        onInput: (e) => set(e.target.value),
      });
      ta.value = value() || '';
      return field(control.label, ta);
    }

    case 'number': {
      const input = el('input', {
        class: 'ws-input',
        type: 'number',
        min: control.min,
        max: control.max,
        step: control.step || 1,
        value: value(),
        onInput: (e) => set(Number(e.target.value)),
      });
      return field(control.label, input);
    }

    case 'range': {
      const valEl = el('span', { class: 'ws-field__value' }, withUnit(value(), control.unit));
      const input = el('input', {
        class: 'ws-range',
        type: 'range',
        min: control.min,
        max: control.max,
        step: control.step || 1,
        value: value(),
        onInput: (e) => {
          const v = Number(e.target.value);
          valEl.textContent = withUnit(v, control.unit);
          set(v);
        },
      });
      return field(control.label, input, valEl);
    }

    case 'color': {
      const current = value();
      const hex = el('span', { class: 'ws-color__hex' }, current);
      const picker = el('input', {
        type: 'color',
        value: current,
        'aria-label': control.label,
        onInput: (e) => {
          hex.textContent = e.target.value;
          set(e.target.value);
        },
      });
      return field(control.label, el('div', { class: 'ws-color' }, [picker, hex]));
    }

    case 'segment': {
      const multiple = !!control.multiple;
      const isOn = (v) => { const c = value(); return multiple ? Array.isArray(c) && c.includes(v) : c === v; };
      const group = el('div', { class: `ws-segment${control.className ? ` ${control.className}` : ''}`, role: 'group', 'aria-label': control.label });
      control.options.forEach((opt) => {
        const btn = el(
          'button',
          {
            class: `ws-segment__btn${isOn(opt.value) ? ' is-on' : ''}`,
            type: 'button',
            onClick: () => {
              if (multiple) {
                // Read the LIVE value each click so multiple toggles accumulate
                // (clicking B then U → both on, not just the last one).
                const cur = value();
                const arr = new Set(Array.isArray(cur) ? cur : []);
                arr.has(opt.value) ? arr.delete(opt.value) : arr.add(opt.value);
                const next = [...arr];
                set(next);
                group.querySelectorAll('.ws-segment__btn').forEach((b, i) => {
                  b.classList.toggle('is-on', next.includes(control.options[i].value));
                });
              } else {
                set(opt.value);
                group.querySelectorAll('.ws-segment__btn').forEach((b) => b.classList.toggle('is-on', b === btn));
              }
            },
          },
          opt.label
        );
        group.appendChild(btn);
      });
      return field(control.label, group);
    }

    case 'checkbox': {
      const input = el('input', {
        type: 'checkbox',
        checked: !!value(),
        onChange: (e) => set(e.target.checked),
      });
      return el('label', { class: 'ws-checkbox' }, [input, control.label]);
    }

    case 'button':
      return el(
        'button',
        {
          class: `ws-action-btn${control.variant === 'ghost' ? ' ws-action-btn--ghost' : ''}`,
          type: 'button',
          onClick: () => onAction && onAction(control.action),
        },
        control.label
      );

    default:
      return null;
  }
}

function field(label, control, valueEl) {
  return el('div', { class: 'ws-field' }, [
    el('div', { class: 'ws-field__label' }, [document.createTextNode(label || ''), valueEl].filter(Boolean)),
    control,
  ]);
}

function withUnit(value, unit) {
  return unit ? `${value}${unit}` : String(value);
}
