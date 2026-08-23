/**
 * Monotonic id generation.
 *
 * Object and layer ids only need to be unique within a running session, so a
 * cheap counter beats a UUID: it is smaller in memory, sorts naturally and
 * keeps serialized documents diff-friendly. Each factory owns its own sequence
 * so ids read meaningfully (`obj-42`, `layer-3`) during debugging.
 */
export function createIdFactory(prefix = 'id') {
  let seq = 0;
  return function nextId() {
    seq += 1;
    return `${prefix}-${seq}`;
  };
}

/** Shared object-id sequence used by the object model. */
export const nextObjectId = createIdFactory('obj');
