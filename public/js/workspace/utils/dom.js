/**
 * Tiny DOM helpers. Kept dependency-free so the workspace stays lightweight.
 */

/**
 * Create an element with attributes/props and children.
 * @param {string} tag
 * @param {object} [attrs]
 * @param {(Node|string)[]|Node|string} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list') {
      try {
        node[key] = value;
      } catch {
        node.setAttribute(key, value);
      }
    } else {
      node.setAttribute(key, value);
    }
  }

  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** Query a single element (optionally scoped). */
export function qs(selector, scope = document) {
  return scope.querySelector(selector);
}

/** Query all elements as an array (optionally scoped). */
export function qsa(selector, scope = document) {
  return Array.from(scope.querySelectorAll(selector));
}
