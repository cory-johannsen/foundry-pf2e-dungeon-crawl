/**
 * #1212: some third-party modules (pf2e-auto-action-tracker v0.19.1's
 * `DBManager.updateLogs`) write a combatant with
 * `update(data, { diff: false, recursive: false })`. A non-recursive update
 * REPLACES the whole top-level `flags` object instead of merging into it, so
 * every other namespace on the combatant -- including this module's
 * `agentControlled` -- is wiped. `preserveCombatantFlagNamespaces` runs from
 * a `preUpdateCombatant` hook and copies every existing flag namespace the
 * update doesn't mention back into it, so the replace keeps them.
 */

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Mutates `changes` (a preUpdate hook's update data) so a non-recursive
 * update to `flags` keeps the combatant's other flag namespaces. A no-op for
 * ordinary (recursive) updates and for updates that don't touch `flags`.
 * Handles both the expanded form (`changes.flags = { ns: ... }`) and
 * un-expanded dotted keys (`"flags.ns.key": ...`). A namespace the update
 * explicitly removes (`"-=ns"`) is not restored.
 *
 * @param {object} existingFlags the combatant's current `flags` (source)
 * @param {object} changes       the update data from the hook
 * @param {object} options       the update options from the hook
 * @returns {string[]} the namespaces that were copied back (for logging)
 */
export function preserveCombatantFlagNamespaces(existingFlags, changes, options) {
  if (options?.recursive !== false) return [];
  if (!isPlainObject(existingFlags) || !isPlainObject(changes)) return [];

  const keys = Object.keys(changes);
  const dotted = keys.filter((k) => k.startsWith("flags."));
  const hasNested = isPlainObject(changes.flags);
  if (!hasNested && !dotted.length) return [];

  const mentioned = new Set();
  const removed = new Set();
  if (hasNested) {
    for (const k of Object.keys(changes.flags)) {
      if (k.startsWith("-=")) removed.add(k.slice(2));
      else mentioned.add(k);
    }
  }
  for (const k of dotted) {
    const ns = k.slice("flags.".length).split(".")[0];
    if (ns.startsWith("-=")) removed.add(ns.slice(2));
    else mentioned.add(ns);
  }

  const restored = [];
  for (const [ns, value] of Object.entries(existingFlags)) {
    if (mentioned.has(ns) || removed.has(ns)) continue;
    const copy = typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
    if (hasNested) changes.flags[ns] = copy;
    else changes[`flags.${ns}`] = copy;
    restored.push(ns);
  }
  return restored;
}
