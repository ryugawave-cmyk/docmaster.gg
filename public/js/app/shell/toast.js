/**
 * Toast center. Listens for `toast` on the bus and shows transient messages.
 */
export function initToasts({ bus }) {
  let host = null;

  bus.on('toast', (message) => {
    if (!message) return;
    if (!host) {
      host = document.createElement('div');
      host.className = 'ws-toasts';
      document.body.appendChild(host);
    }
    const toast = document.createElement('div');
    toast.className = 'ws-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    host.appendChild(toast);
    setTimeout(() => toast.remove(), 2600);
  });
}
