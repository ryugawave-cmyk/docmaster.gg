/**
 * Shared top toolbar (adaptive).
 *
 * There is exactly ONE toolbar. It has fixed shell chrome (home, doc name,
 * history, zoom, export, panel toggle) plus a MIDDLE region that the active
 * workspace fills via `getToolbar()`. On every workspace change — or when a
 * workspace emits `toolbar:refresh` — the middle region is rebuilt, so the same
 * bar "adapts" without the shell knowing anything PDF- or Document-specific.
 *
 * Fixed buttons carry `data-action`; the entry point's delegated click handler
 * routes them. Workspace items carry an `action` string routed to the active
 * workspace's `handleAction`.
 */
import { el } from '../../workspace/utils/dom.js';
import { renderIcon } from '../../workspace/icons.js';
import { formatZoom } from '../../workspace/utils/format.js';

export function initToolbar({ root, store, bus, manager }) {
  const slot = root.querySelector('[data-region="toolbar-workspace"]');
  const docNameEl = root.querySelector('[data-bind="docName"]');
  const zoomEl = root.querySelector('[data-bind="zoom"]');
  const undoBtn = root.querySelector('[data-action="undo"]');
  const redoBtn = root.querySelector('[data-action="redo"]');

  // At most one toolbar overflow menu open at a time.
  let openMenu = null;
  const closeMenu = () => { if (openMenu) { openMenu.el.remove(); openMenu.btn?.setAttribute('aria-expanded', 'false'); openMenu = null; } };
  document.addEventListener('click', closeMenu);

  function renderWorkspaceGroup() {
    closeMenu();
    slot.replaceChildren();
    const ws = manager.current();
    const model = ws?.getToolbar?.() || { groups: [] };
    for (const group of model.groups) {
      const g = el('div', { class: `ws-toolbar__group${group.className ? ` ${group.className}` : ''}`, role: 'group' });
      for (const item of group.items) {
        g.appendChild(renderItem(item, ws));
      }
      slot.appendChild(g);
    }
  }

  /** Overflow popover: a ws-btn that toggles a menu of secondary/contextual items. */
  function renderMenu(item, ws) {
    const btn = el('button', {
      class: `ws-btn ws-btn--menu${item.active ? ' is-active' : ''}`,
      type: 'button', 'data-tip': item.tip || item.label, 'aria-label': item.label || item.tip,
      'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onClick: (e) => {
        e.stopPropagation();
        const wasThis = openMenu && openMenu.btn === btn;
        closeMenu();
        if (wasThis) return;
        const menu = el('div', { class: 'app-menu app-menu--toolbar', role: 'menu' },
          (item.items || []).map((sub) => sub.type === 'separator'
            ? el('div', { class: 'app-menu__sep' })
            : el('button', {
                class: `app-menu__item${sub.disabled ? ' is-disabled' : ''}`,
                type: 'button', role: 'menuitem', disabled: !!sub.disabled,
                onClick: (ev) => { ev.stopPropagation(); closeMenu(); if (!sub.disabled) ws?.handleAction?.(sub.action, sub); },
              }, [
                sub.icon ? el('span', { class: 'app-menu__icon', html: renderIcon(sub.icon) }) : null,
                el('span', { class: 'app-menu__label' }, sub.label),
              ].filter(Boolean))
          )
        );
        btn.setAttribute('aria-expanded', 'true');
        btn.parentElement.appendChild(menu);
        openMenu = { el: menu, btn };
      },
    }, [
      item.icon ? el('span', { class: 'ws-btn__ico', html: renderIcon(item.icon) }) : null,
      item.label ? el('span', { class: 'ws-btn__txt' }, item.label) : null,
      el('span', { class: 'ws-btn__ico ws-btn__caret', html: renderIcon('chevron') }),
    ].filter(Boolean));
    return btn;
  }

  function renderItem(item, ws) {
    if (item.type === 'separator') return el('span', { class: 'ws-toolbar__sep' });
    if (item.type === 'label') return el('span', { class: 'ws-toolbar__text' }, item.label);
    if (item.type === 'menu') return renderMenu(item, ws);
    const btn = el(
      'button',
      {
        class: `ws-btn${item.accent ? ' ws-btn--accent' : ''}${item.active ? ' is-active' : ''}`,
        type: 'button',
        'data-tip': item.tip || item.label,
        'aria-label': item.label || item.tip,
        onClick: () => {
          if (item.action) ws?.handleAction?.(item.action, item);
        },
      },
      [
        item.icon ? el('span', { class: 'ws-btn__ico', html: renderIcon(item.icon) }) : null,
        item.label ? el('span', { class: 'ws-btn__txt' }, item.label) : null,
      ].filter(Boolean)
    );
    return btn;
  }

  function applyReadModel(state) {
    if (docNameEl) docNameEl.textContent = state.docName || 'Untitled';
    if (zoomEl) zoomEl.textContent = formatZoom(state.zoom);
    if (undoBtn) undoBtn.disabled = !state.canUndo;
    if (redoBtn) redoBtn.disabled = !state.canRedo;
  }

  bus.on('workspace:change', renderWorkspaceGroup);
  bus.on('toolbar:refresh', renderWorkspaceGroup);
  store.subscribe((state, prev) => {
    if (
      state.docName !== prev.docName ||
      state.zoom !== prev.zoom ||
      state.canUndo !== prev.canUndo ||
      state.canRedo !== prev.canRedo
    ) {
      applyReadModel(state);
    }
  });
  applyReadModel(store.getState());
  renderWorkspaceGroup();
}
