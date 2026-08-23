import { el } from '../utils/dom.js';
import { renderIcon } from '../icons.js';
import { groupLabels } from '../tools/index.js';

/**
 * Left tool rail. Built entirely from the tool registry so any registered tool
 * appears automatically, grouped and highlighted when active.
 */
export function initSidebar(ctx) {
  const { root, store, registry } = ctx;
  root.replaceChildren();

  for (const [group, tools] of registry.groups()) {
    const section = el('div', { class: 'ws-sidebar__group' }, [
      el('span', { class: 'ws-sidebar__label' }, groupLabels[group] || group),
      ...tools.map((tool) =>
        el('button', {
          class: 'ws-tool',
          type: 'button',
          dataset: { tool: tool.id },
          title: tool.shortcut ? `${tool.label} (${tool.shortcut})` : tool.label,
          'aria-label': tool.label,
          'aria-pressed': 'false',
          html: `<span class="ws-tool__icon">${renderIcon(tool.icon)}</span><span class="ws-tool__label">${tool.label}</span>`,
          onClick: () => ctx.setActiveTool(tool.id),
        })
      ),
    ]);
    root.appendChild(section);
  }

  function highlight(activeId) {
    root.querySelectorAll('.ws-tool').forEach((btn) => {
      const on = btn.dataset.tool === activeId;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', String(on));
    });
  }

  store.subscribe((state, prev) => {
    if (state.activeToolId !== prev.activeToolId) highlight(state.activeToolId);
  });
  highlight(store.getState().activeToolId);
}
