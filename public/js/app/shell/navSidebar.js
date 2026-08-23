/**
 * Left navigation rail (shared shell).
 *
 * Built from `config/navigation.js`. Each item dispatches its declarative
 * `{ command, arg }` on the bus (`nav:command`); the command router in the entry
 * point decides the effect. The rail highlights the item/section matching the
 * active workspace, and keeps the workspace switch purely data-driven — adding a
 * nav entry never touches this file.
 */
import { el } from '../../workspace/utils/dom.js';
import { renderIcon } from '../../workspace/icons.js';
import { navSections } from '../config/navigation.js';

export function initNavSidebar({ root, store, bus }) {
  root.replaceChildren();
  const itemEls = [];

  for (const section of navSections) {
    const children = [];
    if (section.label) children.push(el('span', { class: 'app-nav__label' }, section.label));
    for (const item of section.items) {
      const btn = el(
        'button',
        {
          class: 'app-nav__item',
          type: 'button',
          dataset: { id: item.id, workspace: item.workspace || section.workspace || '', view: item.arg || '' },
          title: item.label,
          onClick: () => bus.emit('nav:command', { command: item.command, arg: item.arg, itemId: item.id }),
        },
        [
          el('span', { class: 'app-nav__icon', html: renderIcon(item.icon) }),
          el('span', { class: 'app-nav__text' }, item.label),
        ]
      );
      itemEls.push(btn);
      children.push(btn);
    }
    root.appendChild(el('div', { class: 'app-nav__group' }, children));
  }

  function highlight(state) {
    const wsId = state.activeWorkspaceId;
    itemEls.forEach((btn) => {
      // Home/Recent/Projects highlight by their own view; editors by workspace id.
      const ws = btn.dataset.workspace;
      const isActive = ws === wsId && (ws !== 'home' || btn.dataset.view === (state.homeView || 'home'));
      btn.classList.toggle('is-active', isActive);
    });
  }

  store.subscribe((state, prev) => {
    if (state.activeWorkspaceId !== prev.activeWorkspaceId || state.homeView !== prev.homeView) highlight(state);
  });
  highlight(store.getState());
}
