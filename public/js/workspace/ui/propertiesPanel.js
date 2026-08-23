import { el } from '../utils/dom.js';
import { renderIcon } from '../icons.js';

/**
 * Right-hand properties panel.
 *
 * Renders the active tool's declarative `properties` schema into elegant,
 * collapsible cards. `heading` controls delimit sections; every other control
 * renders below its heading. Values live in `state.toolSettings[toolId]` and
 * flow back through `ctx.setToolSetting`. Schema-driven, so new tools get a
 * polished panel for free.
 */

// Remembers which cards a user collapsed, per tool, for the session.
const collapsed = new Map();

export function initPropertiesPanel(ctx) {
  const { root, store, registry } = ctx;

  function valueOf(toolId, control) {
    const settings = store.getState().toolSettings[toolId] || {};
    return control.key in settings ? settings[control.key] : control.default;
  }

  function render(toolId) {
    const tool = registry.get(toolId);
    root.replaceChildren();
    if (!tool) return;

    root.appendChild(
      el('div', { class: 'ws-panel__header' }, [
        el('span', { class: 'ws-panel__icon', html: renderIcon(tool.icon) }),
        el('div', { class: 'ws-panel__titles' }, [
          el('div', { class: 'ws-panel__title' }, tool.label),
          el('div', { class: 'ws-panel__subtitle' }, 'Tool properties'),
        ]),
      ])
    );

    const body = el('div', { class: 'ws-panel__body' });
    for (const section of toSections(tool.properties || [])) {
      body.appendChild(renderSection(tool, section, ctx, valueOf));
    }
    root.appendChild(body);
  }

  store.subscribe((state, prev) => {
    if (state.activeToolId !== prev.activeToolId) render(state.activeToolId);
  });
  render(store.getState().activeToolId);
}

/** Split a flat properties list into sections keyed by `heading` controls. */
function toSections(properties) {
  const sections = [];
  let current = { title: null, controls: [] };
  for (const control of properties) {
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

function renderSection(tool, section, ctx, valueOf) {
  const controls = section.controls
    .map((c) => buildControl(c, tool.id, ctx, valueOf))
    .filter(Boolean);
  const pad = el('div', { class: 'ws-card__pad' }, controls);

  // Untitled leading section (rare): render without a collapsible header.
  if (!section.title) {
    return el('section', { class: 'ws-card' }, pad);
  }

  const key = `${tool.id}::${section.title}`;
  const isCollapsed = collapsed.get(key) === true;

  const card = el('section', { class: `ws-card${isCollapsed ? ' is-collapsed' : ''}` });
  const inner = el('div', { class: 'ws-card__inner' }, pad);
  const bodyWrap = el('div', { class: 'ws-card__body' }, inner);
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

/** Build a single control node from its descriptor. */
function buildControl(control, toolId, ctx, valueOf) {
  const set = (value) => ctx.setToolSetting(toolId, control.key, value);

  switch (control.type) {
    case 'note':
      return el('p', { class: 'ws-note' }, control.text);

    case 'select': {
      const select = el(
        'select',
        { class: 'ws-select', onChange: (e) => set(e.target.value) },
        control.options.map((opt) =>
          el('option', { value: opt.value, selected: opt.value === valueOf(toolId, control) }, opt.label)
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
        value: valueOf(toolId, control) || '',
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
      ta.value = valueOf(toolId, control) || '';
      return field(control.label, ta);
    }

    case 'number': {
      const input = el('input', {
        class: 'ws-input',
        type: 'number',
        min: control.min,
        max: control.max,
        step: control.step || 1,
        value: valueOf(toolId, control),
        onInput: (e) => set(Number(e.target.value)),
      });
      return field(control.label, input);
    }

    case 'range': {
      const valEl = el('span', { class: 'ws-field__value' }, withUnit(valueOf(toolId, control), control.unit));
      const input = el('input', {
        class: 'ws-range',
        type: 'range',
        min: control.min,
        max: control.max,
        step: control.step || 1,
        value: valueOf(toolId, control),
        onInput: (e) => {
          const v = Number(e.target.value);
          valEl.textContent = withUnit(v, control.unit);
          set(v);
        },
      });
      return field(control.label, input, valEl);
    }

    case 'color': {
      const current = valueOf(toolId, control);
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
      const current = valueOf(toolId, control);
      const multiple = !!control.multiple;
      const isOn = (v) => (multiple ? Array.isArray(current) && current.includes(v) : current === v);
      const group = el('div', { class: 'ws-segment', role: 'group', 'aria-label': control.label });
      control.options.forEach((opt) => {
        const btn = el(
          'button',
          {
            class: `ws-segment__btn${isOn(opt.value) ? ' is-on' : ''}`,
            type: 'button',
            onClick: () => {
              if (multiple) {
                const arr = new Set(Array.isArray(current) ? current : []);
                arr.has(opt.value) ? arr.delete(opt.value) : arr.add(opt.value);
                const next = [...arr];
                set(next);
                group.querySelectorAll('.ws-segment__btn').forEach((b, i) => {
                  b.classList.toggle('is-on', next.includes(control.options[i].value));
                });
              } else {
                set(opt.value);
                group.querySelectorAll('.ws-segment__btn').forEach((b) =>
                  b.classList.toggle('is-on', b === btn)
                );
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
        checked: !!valueOf(toolId, control),
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
          onClick: () => ctx.doAction(control.action),
        },
        control.label
      );

    default:
      return null;
  }
}

function field(label, control, valueEl) {
  return el('div', { class: 'ws-field' }, [
    el('div', { class: 'ws-field__label' }, [document.createTextNode(label), valueEl].filter(Boolean)),
    control,
  ]);
}

function withUnit(value, unit) {
  return unit ? `${value}${unit}` : String(value);
}
