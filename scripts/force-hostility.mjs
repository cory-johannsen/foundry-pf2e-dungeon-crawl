/**
 * #1083: the central "who is hostile to whom" relation for encounters with
 * several opposing forces. Pure except recordAttack's flag write.
 * Combatants carry a forceId token flag; the combat carries a `forces` table
 * { [forceId]: { hostility: "players" | "all", hostileTo: [forceId] } }.
 * No table (every legacy / dungeon-room combat) = the old disposition rule.
 */
const MODULE_ID = "pf2e-dungeon-crawl";
export const PARTY_FORCE = "party";
export const DEFAULT_FORCE = "default";

export function forceIdOf(combatant) {
  const token = combatant?.token;
  const flagged =
    token?.getFlag?.(MODULE_ID, "forceId") ?? token?.flags?.[MODULE_ID]?.forceId;
  if (flagged) return flagged;
  return token?.disposition === -1 ? DEFAULT_FORCE : PARTY_FORCE;
}

export function readForces(combat) {
  const table = combat?.getFlag?.(MODULE_ID, "forces");
  return table && typeof table === "object" ? table : null;
}

export function areHostileForces(forces, fa, fb) {
  if (fa === fb) return false;
  if (fa === PARTY_FORCE || fb === PARTY_FORCE) return true; // the other is a non-party force
  if (!forces) return false; // legacy: two non-party sides never fight each other
  const a = forces[fa] ?? { hostility: "players", hostileTo: [] };
  const b = forces[fb] ?? { hostility: "players", hostileTo: [] };
  return (
    a.hostility === "all" ||
    b.hostility === "all" ||
    (a.hostileTo ?? []).includes(fb) ||
    (b.hostileTo ?? []).includes(fa)
  );
}

export function areHostile(combat, a, b) {
  if (!a || !b || a.id === b.id) return false;
  return areHostileForces(readForces(combat), forceIdOf(a), forceIdOf(b));
}

export function withRetaliation(forces, attackerForce, victimForce) {
  if (!forces || attackerForce === victimForce) return forces;
  if (attackerForce === PARTY_FORCE || victimForce === PARTY_FORCE) return forces;
  if (!forces[victimForce]) return forces;
  const next = structuredClone(forces);
  const add = (id, other) => {
    const list = next[id].hostileTo ?? (next[id].hostileTo = []);
    if (!list.includes(other)) list.push(other);
  };
  add(victimForce, attackerForce);
  if (next[attackerForce]?.hostility === "players") add(attackerForce, victimForce);
  return next;
}

export async function recordAttack(combat, attacker, victim) {
  try {
    const forces = readForces(combat);
    const next = withRetaliation(forces, forceIdOf(attacker), forceIdOf(victim));
    if (next === forces || JSON.stringify(next) === JSON.stringify(forces)) return;
    await combat.setFlag(MODULE_ID, "forces", next);
  } catch (err) {
    console.error(`${MODULE_ID} | #1083: recording retaliation failed:`, err?.message ?? err);
  }
}
