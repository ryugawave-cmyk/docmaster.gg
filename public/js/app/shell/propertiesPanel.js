/**
 * Contextual properties panel (shared shell, right sidebar).
 *
 * The panel is SELECTION-DRIVEN, not tool-driven: it listens for
 * `selection:change` on the bus, resolves a provider from the property registry
 * by the selection's `kind`, and renders that provider's schema. This is what
 * makes it "automatically change based on the current selection":
 *
 *   Text → typography · Image → image · Page → page · (nothing) → document
 *
 * Because providers are workspace-agnostic, the same panel serves the PDF and
 * Document workspaces with no branching here.
 */
import { el } from '../../workspace/utils/dom.js';
import { renderIcon } from '../../workspace/icons.js';
import { renderControls } from './controls.js';

export function initPropertiesPanel({ root, store, bus, properties }) {
  // Per-kind property values for the session (until the object model owns them).
  const valuesByKind = new Map();

  let currentKind = null;
  let currentTarget = null;
  let titleEl = null;

  function render(descriptor) {
    const provider = properties.resolve(descriptor);
    root.replaceChildren();
    if (!provider) return;

    // Seed the panel's control values from the selection the first time we show
    // this kind (so it reflects the caret's current formatting).
    if (!valuesByKind.has(provider.kind)) valuesByKind.set(provider.kind, { ...(descriptor.values || {}) });

    titleEl = el('div', { class: 'ws-panel__title' }, descriptor.label || provider.title);
    root.appendChild(
      el('div', { class: 'ws-panel__header' }, [
        el('span', { class: 'ws-panel__icon', html: renderIcon(provider.icon) }),
        el('div', { class: 'ws-panel__titles' }, [
          titleEl,
          el('div', { class: 'ws-panel__subtitle' }, provider.subtitle || 'Properties'),
        ]),
      ])
    );

    const bag = () => {
      if (!valuesByKind.has(provider.kind)) valuesByKind.set(provider.kind, { ...(descriptor.values || {}) });
      return valuesByKind.get(provider.kind);
    };

    const body = el('div', { class: 'ws-panel__body' });
    body.appendChild(
      renderControls(provider.schema(descriptor), {
        getValue: (key) => bag()[key],
        onChange: (key, value) => {
          bag()[key] = value;
          provider.onChange?.(descriptor, key, value, { store, bus });
          bus.emit('property:change', { kind: provider.kind, key, value, descriptor });
        },
        onAction: (action) => bus.emit('action', action),
      })
    );
    root.appendChild(body);
  }

  bus.on('selection:change', (descriptor) => {
    store.setState({ selection: descriptor });
    // Full rebuild when the KIND changes, or when a DIFFERENT object of the same
    // kind is selected (descriptor.target changes) — the latter reseeds the panel
    // from that object's values. Same-kind updates without a target change (e.g.
    // the caret moving within one text run) just refresh the header, so controls
    // the user is interacting with (sliders, pickers) are never destroyed mid-gesture.
    const targetChanged = descriptor.target != null && descriptor.target !== currentTarget;
    currentTarget = descriptor.target;
    if (descriptor.kind !== currentKind) {
      currentKind = descriptor.kind;
      render(descriptor);
    } else if (targetChanged) {
      valuesByKind.set(descriptor.kind, { ...(descriptor.values || {}) });
      render(descriptor);
    } else if (titleEl) {
      const provider = properties.resolve(descriptor);
      titleEl.textContent = descriptor.label || provider?.title || '';
    }
  });

  const initial = store.getState().selection || { kind: 'none' };
  currentKind = initial.kind;
  render(initial);
}
