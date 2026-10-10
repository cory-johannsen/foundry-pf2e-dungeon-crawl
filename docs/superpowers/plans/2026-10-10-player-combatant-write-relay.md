# Player Combatant Write Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the "User X lacks permission to update Combatant" toast when a player clicks Strike/Damage, by relaying the Action Tracker's two queue-flag writes through the active GM (#1254).

**Architecture:** A pure classifier (`classifyCombatantUpdate`) decides whether a player-client combatant update touches only `pf2e-auto-action-tracker` `pendingDamageQueue` / `pendingAttackQueue`. A `preUpdateCombatant` hook (registered before #1212's guard) applies the value locally with `updateSource`, emits `combatantFlagRelay` on the module socket, and cancels the doomed write. A GM-side socket handler validates (closed key list, array of ≤50 strings, sender owns the combatant's actor) and persists with `setFlag`. Task 1 is an instrumented repro that can change the approach.

**Tech Stack:** Foundry VTT v13/14 module, ES modules, Vitest, module socket `module.pf2e-dungeon-crawl`.

**Spec:** `docs/superpowers/specs/2026-10-10-player-combatant-write-relay-design.md`

## Global Constraints

- Every merge to `main` bumps `module.json` `version` (currently `0.94.23`; patch bump, re-read `origin/main` at merge time, never reuse a number).
- Relay list is closed: flags `pendingDamageQueue`, `pendingAttackQueue` in namespace `pf2e-auto-action-tracker`; value = array of strings, at most 50 entries.
- The relay never touches GM clients' writes; a hook error must let the original update proceed (never worse than today).
- No GM online: keep the optimistic local value, no persisted write, `console.debug`, no toast.
- No `update-architecture-docs` shortcut: the new file `scripts/combatant-write-relay.mjs` and its `module.mjs` import change the import graph, so run the `update-architecture-docs` skill in the same PR.
- Out of scope: upstream issue text (#1255), other tracker/third-party writes, the tracker's action-log counting (#1252).
- Worktree off `origin/main`; `npm ci`; copy `.env` before live testing.

## Review Focus

- A player update with the tracker queue flag **plus** any other key/namespace/flag must NOT be relayed (otherwise a legitimate write is swallowed).
- Both expanded (`flags: {ns: {k: v}}`) and dotted (`"flags.ns.k": v`) change shapes, and a `-=k` deletion key, are handled (deletion is not relayed).
- Non-array, non-string-entry, or >50-entry values are not relayed (and not applied locally).
- GM handler: sender who does not own the combatant's actor, unknown combat/combatant, unlisted key, or a malformed value writes nothing; replaying the same message is idempotent.
- Hook error / `updateSource` throw → the original update proceeds (toast returns, but no regression).
- Strike (`pendingAttackQueue`), Damage (`pendingDamageQueue`) and the spell-attack button all hit the relay; with no GM client online there is no toast.

---

### Task 1: Instrumented repro (gates the approach)

**Files:** none committed (scratch notes go in an issue comment).

- [ ] **Step 1:** In the live world (copy `.env`; compare the world's module version to `module.json`), as the Fighter player client open the console and install a capture: `Hooks.on("preUpdateCombatant",(c,ch,o,uid)=>console.log("PRE",c.id,JSON.stringify(ch),JSON.stringify(o),uid))` and wrap `ui.notifications.error` to log. Click Strike, then Damage, then a spell-attack button. Record: the exact `changes`/`options` the tracker sends; whether any write other than `pendingAttackQueue`/`pendingDamageQueue` is rejected (also `tail` the server log for `lacks permission`).
- [ ] **Step 2:** Check ownership resolution as the player: `canvas.tokens.controlled`-free check `game.combat.combatants.get("<fighter combatant id>").testUserPermission(game.user,"OWNER")` and `.actor.testUserPermission(game.user,"OWNER")`. Expected finding (per spec): the combatant-level test is false although the actor-level test is true.
- [ ] **Step 3: Decision gate.** Post the captured payloads and results as a comment on #1254. If the rejection turns out to come from something configurable (a world permission setting, this module's own hook mutating the payload) or other writes are also rejected, STOP and report to the owner before building — the relay is the fix only if the server genuinely refuses an owner's flag write. Otherwise continue; if the payload shape differs from the cases in Task 2's tests, add that shape as a test case there.

### Task 2: Pure classifier + GM-side validator (`combatant-write-relay.mjs`)

**Files:**
- Create: `scripts/combatant-write-relay.mjs`
- Test: `tests/combatant-write-relay.test.mjs`

**Interfaces:**
- Produces:
  - `RELAY_NAMESPACE = "pf2e-auto-action-tracker"`, `RELAY_FLAG_KEYS = ["pendingDamageQueue","pendingAttackQueue"]`, `MAX_QUEUE = 50`.
  - `isValidQueueValue(v) → boolean` (array of ≤50 strings).
  - `classifyCombatantUpdate(changes, userIsGM) → { relay: true, flagKey, value } | { relay: false }`.
  - `validateRelayMessage(msg, { combat, senderUser }) → { ok: true, combatant, flagKey, value } | { ok: false, reason }` where `combat` is the resolved Combat (or undefined) and `senderUser` the resolved User (or undefined); checks: key in closed list, `isValidQueueValue`, combat + combatant exist, `combat.active !== false`-style check is NOT used (a tracker queue can be written between rounds), sender exists and `combatant.actor?.testUserPermission(senderUser, "OWNER")`.

- [x] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from "vitest";
import {
  classifyCombatantUpdate, isValidQueueValue, validateRelayMessage,
} from "../scripts/combatant-write-relay.mjs";

const NS = "pf2e-auto-action-tracker";
describe("classifyCombatantUpdate", () => {
  it("relays an expanded damage-queue write from a player", () => {
    expect(classifyCombatantUpdate({ _id: "c", flags: { [NS]: { pendingDamageQueue: ["m1"] } } }, false))
      .toEqual({ relay: true, flagKey: "pendingDamageQueue", value: ["m1"] });
  });
  it("relays a dotted-key attack-queue write", () => {
    expect(classifyCombatantUpdate({ [`flags.${NS}.pendingAttackQueue`]: [] }, false))
      .toEqual({ relay: true, flagKey: "pendingAttackQueue", value: [] });
  });
  it("never relays for a GM", () => {
    expect(classifyCombatantUpdate({ flags: { [NS]: { pendingDamageQueue: ["m1"] } } }, true)).toEqual({ relay: false });
  });
  it("does not relay when anything else is in the update", () => {
    const f = (ch) => classifyCombatantUpdate(ch, false);
    expect(f({ flags: { [NS]: { pendingDamageQueue: [], pendingAttackQueue: [] } } })).toEqual({ relay: false }); // two keys
    expect(f({ flags: { [NS]: { pendingDamageQueue: [], log: [] } } })).toEqual({ relay: false });
    expect(f({ flags: { [NS]: { log: [] } } })).toEqual({ relay: false });
    expect(f({ flags: { other: { x: 1 }, [NS]: { pendingDamageQueue: [] } } })).toEqual({ relay: false });
    expect(f({ initiative: 5, flags: { [NS]: { pendingDamageQueue: [] } } })).toEqual({ relay: false });
    expect(f({ flags: { [NS]: { "-=pendingDamageQueue": null } } })).toEqual({ relay: false });
    expect(f({})).toEqual({ relay: false });
    expect(f(null)).toEqual({ relay: false });
  });
  it("allows _id alongside the flag", () => {
    expect(classifyCombatantUpdate({ _id: "c", flags: { [NS]: { pendingAttackQueue: ["a"] } } }, false).relay).toBe(true);
  });
  it("rejects malformed values", () => {
    expect(classifyCombatantUpdate({ flags: { [NS]: { pendingDamageQueue: "m1" } } }, false)).toEqual({ relay: false });
    expect(classifyCombatantUpdate({ flags: { [NS]: { pendingDamageQueue: [1] } } }, false)).toEqual({ relay: false });
    expect(classifyCombatantUpdate({ flags: { [NS]: { pendingDamageQueue: Array(51).fill("x") } } }, false)).toEqual({ relay: false });
  });
});

describe("isValidQueueValue", () => {
  it("accepts ≤50 strings only", () => {
    expect(isValidQueueValue([])).toBe(true);
    expect(isValidQueueValue(Array(50).fill("x"))).toBe(true);
    expect(isValidQueueValue(Array(51).fill("x"))).toBe(false);
    expect(isValidQueueValue(null)).toBe(false);
  });
});

describe("validateRelayMessage", () => {
  const owner = { id: "u1" };
  const combatant = { id: "cb", actor: { testUserPermission: (u, lvl) => u.id === "u1" && lvl === "OWNER" } };
  const combat = { combatants: { get: (id) => (id === "cb" ? combatant : undefined) } };
  const msg = { combatId: "x", combatantId: "cb", flagKey: "pendingDamageQueue", value: ["m1"], userId: "u1" };
  it("accepts a valid owner message", () => {
    expect(validateRelayMessage(msg, { combat, senderUser: owner })).toMatchObject({ ok: true, flagKey: "pendingDamageQueue", value: ["m1"] });
  });
  it.each([
    ["unlisted key", { ...msg, flagKey: "log" }, { combat, senderUser: owner }],
    ["bad value", { ...msg, value: "m1" }, { combat, senderUser: owner }],
    ["unknown combat", msg, { combat: undefined, senderUser: owner }],
    ["unknown combatant", { ...msg, combatantId: "zz" }, { combat, senderUser: owner }],
    ["unknown sender", msg, { combat, senderUser: undefined }],
    ["non-owner sender", msg, { combat, senderUser: { id: "u2" } }],
  ])("rejects %s", (_n, m, ctx) => {
    expect(validateRelayMessage(m, ctx).ok).toBe(false);
  });
});
```

- [x] **Step 2: Run to verify it fails** — `npx vitest run tests/combatant-write-relay.test.mjs` → FAIL (module missing).
- [x] **Step 3: Implement**

```js
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
  const expanded = globalThis.foundry?.utils?.expandObject ? globalThis.foundry.utils.expandObject(changes) : expand(changes);
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

// Minimal dotted-key expansion for environments without foundry.utils (tests).
function expand(obj) {
  const out = {};
  for (const [path, value] of Object.entries(obj)) {
    const parts = path.split(".");
    let cur = out;
    parts.slice(0, -1).forEach((p) => { cur = cur[p] = isObj(cur[p]) ? cur[p] : {}; });
    const last = parts.at(-1);
    cur[last] = isObj(value) && isObj(cur[last]) ? { ...cur[last], ...value } : value;
  }
  return out;
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
```

- [x] **Step 4: Run to verify it passes** — PASS.
- [x] **Step 5: Commit** — `git add scripts/combatant-write-relay.mjs tests/combatant-write-relay.test.mjs && git commit -m "#1254: combatant write relay classifier and validator"`

### Task 3: Hook + socket wiring

**Files:**
- Modify: `scripts/combatant-write-relay.mjs` (add `applyRelayLocally`, `sendCombatantFlagRelay`, `handleCombatantFlagRelay`, `onPreUpdateCombatantRelay`, `registerCombatantWriteRelay`)
- Modify: `scripts/module.mjs` (import; register the `preUpdateCombatant` hook **above** the #1212 hook at ~line 733 and call `registerCombatantWriteRelay()` in a `ready` hook beside `registerDungeonActionSocket`, ~374)
- Test: `tests/combatant-write-relay-hook.test.mjs`

**Interfaces:**
- Consumes: Task 2 exports. `SOCKET = "module.pf2e-dungeon-crawl"` (same constant value as `scripts/player-choice.mjs` / `scripts/dungeon-remote.mjs`; define it locally in this file rather than importing).
- Produces:
  - `onPreUpdateCombatantRelay(combatant, changes, options, userId, deps = {}) → false | undefined` — `deps` = `{ game, log }` defaulting to globals, so it is testable. Returns `undefined` (let it proceed) if `userId !== game.user.id`, not relayable, or any error is thrown (logged with `console.error`); otherwise: `combatant.updateSource({ flags: { [NS]: { [flagKey]: value } } })`, then if `game.users.activeGM` exists `game.socket.emit(SOCKET, { type:"combatantFlagRelay", combatId: combatant.parent?.id, combatantId: combatant.id, flagKey, value, userId: game.user.id })` else `console.debug("... #1254: no GM online, queue not persisted")`; returns `false`.
  - `handleCombatantFlagRelay(msg, deps = {}) → Promise<boolean>` — only when `game.users.activeGM?.isSelf`; resolves `combat = game.combats.get(msg.combatId)`, `senderUser = game.users.get(msg.userId)`, runs `validateRelayMessage`, on `ok` `await combatant.setFlag(NS, flagKey, value)` and returns `true`; otherwise `console.debug` the reason and return `false`.
  - `registerCombatantWriteRelay()` — `game.socket.on(SOCKET, (msg) => { if (msg?.type === "combatantFlagRelay") handleCombatantFlagRelay(msg); })`.

- [ ] **Step 1: Write the failing tests** with fakes: `game = { user: { id: "u1", isGM: false }, users: { activeGM: {} , get }, socket: { emit: vi.fn() } }`, combatant `{ id, parent: { id: "k" }, updateSource: vi.fn(), setFlag: vi.fn() }`. Cases: player queue write → `updateSource` called with the exact flag object, `emit` called once with the exact message, returns `false`; `userId` of another user → `undefined`, nothing called; GM client → `undefined`; unrelated player write (e.g. `{ initiative: 3 }`) → `undefined`; no active GM → `updateSource` called, `emit` not called, returns `false`; `updateSource` throws → returns `undefined` and logs; handler: active-GM client with valid owner message → `setFlag(NS,"pendingDamageQueue",["m1"])` called and resolves `true`; non-GM client / `activeGM` not self → no `setFlag`, `false`; non-owner → no `setFlag`; same message twice → `setFlag` twice with identical args (idempotent).
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement** as specified. In `module.mjs` add `Hooks.on("preUpdateCombatant", (c, ch, o, uid) => onPreUpdateCombatantRelay(c, ch, o, uid));` immediately **before** the existing #1212 `preUpdateCombatant` registration (Foundry runs hooks in registration order and cancels the update when a handler returns `false`, so the guard never sees a relayed update), and `Hooks.once("ready", registerCombatantWriteRelay);` beside line 374.
- [ ] **Step 4: Ordering/regression test** in the same file: import `preserveCombatantFlagNamespaces` and assert a non-relayed non-recursive update is still restored (unchanged #1212 behavior), and that for a relayed payload the hook returns `false` (so a runner that stops at `false` never calls the guard).
- [ ] **Step 5: Run** `npx vitest run tests/combatant-write-relay-hook.test.mjs tests/combatant-flag-guard.test.mjs` then `npm test` → PASS.
- [ ] **Step 6: Commit** — `git commit -am "#1254: relay tracker queue writes through the GM"`

### Task 4: Audit of the module's own player-client combatant writes

**Files:** read-only audit; fixes only if findings.

- [ ] **Step 1:** `grep -nE "combatant[s]?\b.*\.(setFlag|update|unsetFlag)\(|combat\.(setFlag|update|nextTurn|updateEmbeddedDocuments)|updateEmbeddedDocuments\(\"Combatant\"" scripts/*.mjs scripts/ui/*.mjs` and for each hit decide whether it can run on a non-GM client (click handlers, `createChatMessage`/`updateCombatant` hooks without an `isGM`/`activeGM` gate, socket handlers on all clients). Record a table (file:line, gated?, verdict) as an issue comment on #1254.
- [ ] **Step 2:** For each ungated player-reachable write: gate it with `game.users?.activeGM?.isSelf` (when it is GM-side bookkeeping) or add a relay message type of the same closed-list shape, with a test. If none found, say so in the comment — no code change.
- [ ] **Step 3:** `npm test`; commit any fixes as `#1254: gate player-client combatant writes`.

### Task 5: Docs, version, live verification

**Files:** `module.json`, `docs/architecture.md` (via skill)

- [ ] **Step 1:** Run the `update-architecture-docs` skill (new file + `module.mjs` import); commit its output.
- [ ] **Step 2:** Bump `module.json` patch version from the current `origin/main` value; `npm test` → PASS; commit `#1254: bump version`.
- [ ] **Step 3: Live verification** (as in Task 1 setup). As the Fighter player: click Strike, then Damage, then a spell-attack: no error toast, the damage dialog and roll complete, then read as GM `combatant.getFlag("pf2e-auto-action-tracker","pendingDamageQueue")` / `pendingAttackQueue` — values persisted during the sequence and cleared after use. Close the GM client and repeat: no toast, no console error. GM-run Strike/Damage unchanged; #1212 behavior unchanged (AI `agentControlled` flag survives tracker writes).
- [ ] **Step 4:** Open the PR; after merge label `verification`, remove `claimed`/`in progress`, merge with explicit `--subject/--body`.

## Self-Review

Spec coverage: instrumented repro + decision gate (T1), classifier incl. closed list/dotted+expanded/value limits (T2), hook before #1212, optimistic local value, GM relay with ownership validation, no-GM path, error fallthrough (T3), audit (T4), Strike/attack/spell coverage + live verification + architecture docs (T5), tests per the spec's Testing section (T2/T3). Open items from the spec resolved: hook order = registered earlier in `module.mjs`; `updateSource` (no re-render suppression needed since `updateSource` does not trigger render — confirm in live check). Names consistent: `classifyCombatantUpdate`, `validateRelayMessage`, `onPreUpdateCombatantRelay`, `handleCombatantFlagRelay`, message type `combatantFlagRelay`.
