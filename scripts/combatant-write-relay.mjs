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
  if (!Array.isArray(v) || v.length > MAX_QUEUE) return false;
  // Index loop, not every(): every() skips sparse-array holes.
  for (let i = 0; i < v.length; i++) if (typeof v[i] !== "string") return false;
  return true;
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

const SOCKET = "module.pf2e-dungeon-crawl";
const defaultDeps = () => ({ game: globalThis.game, log: console });

/**
 * preUpdateCombatant (player client): when the update is only a tracker queue
 * flag, apply it to the local source and relay the write through the active GM,
 * then cancel the (server-rejected) original. Returns undefined — let the
 * original proceed — for anything else or on any error.
 */
export function onPreUpdateCombatantRelay(combatant, changes, options, userId, deps = {}) {
  const { game, log } = { ...defaultDeps(), ...deps };
  try {
    if (!game?.user || userId !== game.user.id) return undefined;
    const r = classifyCombatantUpdate(changes, !!game.user.isGM);
    if (!r.relay) return undefined;
    combatant.updateSource({ flags: { [RELAY_NAMESPACE]: { [r.flagKey]: r.value } } });
    if (game.users?.activeGM) {
      game.socket.emit(SOCKET, {
        type: "combatantFlagRelay",
        combatId: combatant.parent?.id,
        combatantId: combatant.id,
        flagKey: r.flagKey,
        value: r.value,
        userId: game.user.id,
      });
    } else {
      log.debug?.("pf2e-dungeon-crawl | #1254: no GM online, queue not persisted");
    }
    return false;
  } catch (err) {
    log.error?.("pf2e-dungeon-crawl | #1254: combatant write relay failed:", err?.message ?? err);
    return undefined;
  }
}

/** GM side: validate a relayed message and persist the flag. Active GM client only. */
export async function handleCombatantFlagRelay(msg, deps = {}) {
  const { game, log } = { ...defaultDeps(), ...deps };
  try {
    if (!game?.users?.activeGM?.isSelf) return false;
    const v = validateRelayMessage(msg, {
      combat: game.combats?.get?.(msg?.combatId),
      senderUser: game.users.get(msg?.userId),
    });
    if (!v.ok) {
      log.debug?.(`pf2e-dungeon-crawl | #1254: relay rejected: ${v.reason}`);
      return false;
    }
    await v.combatant.setFlag(RELAY_NAMESPACE, v.flagKey, v.value);
    return true;
  } catch (err) {
    log.error?.("pf2e-dungeon-crawl | #1254: relay apply failed:", err?.message ?? err);
    return false;
  }
}

export function registerCombatantWriteRelay() {
  // Foundry passes the authenticated sender id as the 2nd listener argument;
  // msg.userId is attacker-controlled and must never be trusted on its own.
  globalThis.game.socket.on(SOCKET, (msg, senderId) => {
    if (msg?.type !== "combatantFlagRelay") return;
    if (!senderId || (msg.userId !== undefined && msg.userId !== senderId)) {
      console.debug("pf2e-dungeon-crawl | #1254: relay dropped: unauthenticated or spoofed sender");
      return;
    }
    handleCombatantFlagRelay({ ...msg, userId: senderId });
  });
}
