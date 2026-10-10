/**
 * #1254: the PF2E Automated Action Tracker writes two bookkeeping flags on the
 * acting combatant from the PLAYER's client; Foundry rejects a non-GM
 * Combatant update, so the player got an error toast. These pure helpers
 * decide which player-client updates to relay through the GM and validate the
 * GM-side apply. Closed list on purpose: nothing else is ever relayed.
 */
export const RELAY_NAMESPACE = "pf2e-auto-action-tracker";
export const RELAY_FLAG_KEYS = ["pendingDamageQueue", "pendingAttackQueue"];
export const MAX_QUEUE = 50;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export function isValidQueueValue(v) {
  return Array.isArray(v) && v.length <= MAX_QUEUE && v.every((s) => typeof s === "string");
}

export function classifyCombatantUpdate(changes, userIsGM) {
  const NO = { relay: false };
  if (userIsGM || !isObj(changes)) return NO;
  let expanded;
  try {
    expanded = expand(changes);
  } catch {
    return NO;
  }
  const keys = Object.keys(expanded).filter((k) => k !== "_id");
  if (keys.length !== 1 || keys[0] !== "flags" || !isObj(expanded.flags)) return NO;
  const namespaces = Object.keys(expanded.flags);
  if (namespaces.length !== 1 || namespaces[0] !== RELAY_NAMESPACE) return NO;
  const ns = expanded.flags[RELAY_NAMESPACE];
  if (!isObj(ns)) return NO;
  const flagKeys = Object.keys(ns);
  if (flagKeys.length !== 1 || !RELAY_FLAG_KEYS.includes(flagKeys[0])) return NO;
  const value = ns[flagKeys[0]];
  if (!isValidQueueValue(value)) return NO;
  return { relay: true, flagKey: flagKeys[0], value };
}

// Dotted-key expansion with deep merge (own implementation so mixed
// expanded/dotted shapes are all seen, and so tests need no foundry.utils).
// Throws on prototype-pollution path segments; the caller treats that as "do not relay".
const BAD_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
function merge(target, key, value) {
  if (isObj(value) && isObj(target[key])) {
    for (const [k, v] of Object.entries(value)) merge(target[key], k, v);
  } else {
    target[key] = value;
  }
}
function expand(obj) {
  const out = {};
  for (const [path, value] of Object.entries(obj)) {
    const parts = path.split(".");
    if (parts.some((p) => BAD_SEGMENTS.has(p))) throw new Error("unsafe key");
    let cur = out;
    for (const p of parts.slice(0, -1)) {
      if (!isObj(cur[p])) cur[p] = {};
      cur = cur[p];
    }
    merge(cur, parts.at(-1), isObj(value) ? structuredCloneSafe(value) : value);
  }
  return out;
}
function structuredCloneSafe(v) {
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    if (BAD_SEGMENTS.has(k)) throw new Error("unsafe key");
    o[k] = isObj(x) ? structuredCloneSafe(x) : x;
  }
  return o;
}

export function validateRelayMessage(msg, { combat, senderUser }) {
  if (!RELAY_FLAG_KEYS.includes(msg?.flagKey)) return { ok: false, reason: "flag not relayable" };
  if (!isValidQueueValue(msg.value)) return { ok: false, reason: "bad value" };
  if (!combat) return { ok: false, reason: "unknown combat" };
  const combatant = combat.combatants?.get?.(msg.combatantId);
  if (!combatant) return { ok: false, reason: "unknown combatant" };
  if (!senderUser) return { ok: false, reason: "unknown sender" };
  if (!combatant.actor?.testUserPermission?.(senderUser, "OWNER")) return { ok: false, reason: "sender does not own the actor" };
  return { ok: true, combatant, flagKey: msg.flagKey, value: msg.value };
}
