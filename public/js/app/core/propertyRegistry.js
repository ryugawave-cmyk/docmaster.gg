/**
 * Property registry — maps a selection `kind` to the panel it should show.
 *
 * A "provider" describes one contextual panel:
 *   {
 *     kind,                       // selection kind it handles ('text', 'page', …)
 *     title, subtitle, icon,      // panel header
 *     schema(descriptor) -> [ ...control descriptors ],   // declarative controls
 *     onChange(descriptor, key, value, ctx)               // optional handler
 *   }
 *
 * Providers are workspace-agnostic by design: a typography provider works the
 * same whether the selected text lives in a PDF or a Document. Workspaces (or
 * shared modules) register providers; the shell renders whatever matches the
 * current selection. Unknown kinds fall back to the `none` provider.
 */
export function createPropertyRegistry() {
  const byKind = new Map();

  function register(provider) {
    if (!provider || !provider.kind) throw new Error('Property provider needs a `kind`');
    byKind.set(provider.kind, provider);
    return provider;
  }

  function registerAll(providers) {
    providers.forEach(register);
  }

  /** Resolve the provider for a descriptor, falling back to `none`. */
  function resolve(descriptor) {
    const kind = descriptor?.kind || 'none';
    return byKind.get(kind) || byKind.get('none') || null;
  }

  function has(kind) {
    return byKind.has(kind);
  }

  return { register, registerAll, resolve, has };
}
