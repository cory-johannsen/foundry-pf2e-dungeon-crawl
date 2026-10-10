# Fix: Players' Damage and Attack Clicks Trigger "User Lacks Permission to Update Combatant"

**Issue:** #1254 — a player clicking **Damage** on a to-hit (Strike) card gets a fleeting "User Fighter lacks permission to update Combatant …" error toast.

**Builds on:** #1212 / `scripts/combatant-flag-guard.mjs` and the `preUpdateCombatant` hook in `scripts/module.mjs` (the module's existing guard on the tracker's combatant writes), #1094 / `docs/superpowers/specs/2026-10-09-human-turn-action-enforcement-design.md` (the module's integration with `pf2e-auto-action-tracker`), #1252 / `docs/superpowers/specs/2026-10-10-turn-card-tracker-unknown-action-design.md` (another tracker interaction), and the module's socket patterns in `scripts/player-choice.mjs` and `scripts/dungeon-remote.mjs` (`module.pf2e-dungeon-crawl`, `socket: true` in `module.json`).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

The PF2E Automated Action Tracker (v0.19.1) writes two bookkeeping flags — `pendingDamageQueue` and `pendingAttackQueue` — on the acting combatant **directly from the player's client** when a player clicks a Strike/attack or Damage button. Foundry's server rejects a player's direct Combatant update, so the player sees an error toast and the flag never persists. The fix is a **module-side relay**: on non-GM clients a `preUpdateCombatant` hook catches updates that touch only those two tracker flags, applies the value to the local combatant at once, cancels the doomed server write, and sends the write to the active GM over the module socket, which validates and persists it.

## Investigation findings

- **Where the write originates.** In the tracker (`pf2e-auto-action-tracker`, `main.js`): `handleDamageButtonClick` pushes the clicked message id onto `combatant.flags["pf2e-auto-action-tracker"].pendingDamageQueue` with `setFlag`; the attack-button handler does the same for `pendingAttackQueue`; `handleDamageModifierDialogRender` and `maybeGetOriginMsgId` pop the queue with `setFlag` when the damage dialog renders and when the damage roll arrives. All run on whichever client the user is on. Everything else the tracker persists (the action log, `actionsSpent`) is gated to the active GM by `V()` and reached from players through socketlib relays (`addAction`, `processMovement`, …); these queue writes are the exception. The stack the issue captured (`ChatCardRenderer.ts:46` → `_updateDocuments`) is the click handler.
- **What the server enforces** (Foundry 14.368, `common/documents/combatant.mjs`): `Combatant.#canUpdate(user, doc, data)` allows a GM; a non-GM must pass `doc.testUserPermission(user, "OWNER")` and may send only the keys `_id`, `initiative`, `flags`, `defeated`, `system`. A `setFlag` sends `{ _id, flags }`, so the key list is not the reason; the ownership test is the suspect (`Combatant#getUserLevel` resolves through `this.actor`). The server log shows the rejection repeating (`User Fighter lacks permission to update Combatant [9b4Qwsc7CL0r2Qo8] in parent Combat [IVHYA7A4bkArmMFV]`). Foundry's own player-facing combatant changes (rolling initiative) go through `Combat.update({ combatants })`, a different permission path (`Combat.#canModifyCombatants`), which explains why those work. The exact reason is confirmed in planning (below).
- **Impact.** The damage roll still completes; the visible effect is the toast. The queue is a hand-off the tracker uses to link a damage roll to its originating action; without it the tracker falls back to matching the damage message's origin item, so only complex linkage (combined or sustained actions) is likely affected. Nothing in this module reads the queue flags.
- **The same code path covers Strike/attack buttons** (`pendingAttackQueue`), so the symptom is not specific to Damage.
- **Existing hook.** `Hooks.on("preUpdateCombatant", …)` in `module.mjs` already runs `preserveCombatantFlagNamespaces` (#1212) on the client making the update; the relay hook is registered before it so a cancelled update never reaches the guard.
- **Socket precedent.** `player-choice.mjs` and `dungeon-remote.mjs` already emit and listen on `module.pf2e-dungeon-crawl` and apply GM-side work from player requests.

## Resolved decisions

1. **Approach:** intercept on player clients, apply the value locally at once, and relay the persisted write to the active GM over the module socket.
2. **Scope:** a closed list — the tracker's `pendingDamageQueue` and `pendingAttackQueue` flags.
3. **No GM online:** keep the optimistic local value, drop the persisted write, log a debug line, show no toast.
4. **Extras in scope:** a required first planning step (an instrumented repro to confirm why the server rejects the write), an audit of this module's own code for player-client combatant writes, and verification that the Strike and spell-attack buttons are covered. **Filed:** drafting the upstream issue text (#1255).

## Design

### Interception (`scripts/combatant-write-relay.mjs`, pure core + thin hook)

`classifyCombatantUpdate(changes, userIsGM)` returns `{ relay: true, flagKey, value } | { relay: false }`:

- Not relayed for GM clients.
- Relayed only when the update (after expanding dotted keys) contains **exactly** the key `flags` (and `_id`), with a single namespace `pf2e-auto-action-tracker` containing **only** keys from the closed list `["pendingDamageQueue", "pendingAttackQueue"]`. Anything else (other namespaces, other keys, other tracker flags) is left to proceed unchanged, so a player's legitimate writes are never swallowed.
- `value` must be an array of strings (message ids), at most 50 entries; otherwise not relayed.

The hook:

```js
Hooks.on("preUpdateCombatant", (combatant, changes, options, userId) => {
  if (userId !== game.user.id) return;            // only the client making the update
  const verdict = classifyCombatantUpdate(changes, game.user.isGM);
  if (!verdict.relay) return;
  combatant.updateSource({ flags: { "pf2e-auto-action-tracker": { [verdict.flagKey]: verdict.value } } }); // optimistic local value
  sendCombatantFlagRelay({ combatId: combatant.parent?.id, combatantId: combatant.id, flagKey: verdict.flagKey, value: verdict.value });
  return false;                                   // cancel the doomed server write
});
```

It is registered **before** #1212's `preUpdateCombatant` handler so a relayed update returns before the guard sees it. Any error inside the hook is caught, logged, and lets the update proceed (never worse than today).

### Relay message and GM-side apply

- **Socket:** the module's existing channel `module.pf2e-dungeon-crawl` with `{ type: "combatantFlagRelay", combatId, combatantId, flagKey, value, userId }`.
- **GM-side handler** (active GM only, `game.users.activeGM?.isSelf`) validates before writing:
  1. `flagKey` is in the closed list and `value` is an array of at most 50 strings.
  2. The combat and combatant exist and the combat is active.
  3. The sender (`userId`) is a real user who **owns the combatant's actor** (`combatant.actor.testUserPermission(sender, "OWNER")`), so a player can only affect their own combatants.
  4. Then `combatant.setFlag("pf2e-auto-action-tracker", flagKey, value)` (a normal recursive write, so the #1212 guard is irrelevant).
- The resulting `updateCombatant` broadcast reaches the player, replacing the optimistic value with the identical persisted one.

### No GM online

If `game.users.activeGM` is absent when the relay is sent, the optimistic local value stays, nothing is persisted, a `console.debug` line records it, and no notification is shown. (The queue is a convenience hand-off; the tracker's origin-item fallback still links most damage.)

### Order of operations

The tracker reads the queue right after writing it (the damage dialog's render pops the queue; the damage-roll message handler reads it). Because the value is applied locally with `updateSource` before the hook returns, those reads see the player's own latest value immediately; the GM round trip only makes it durable and visible to others.

### Required first planning step: instrumented repro

Before building the relay, planning runs an instrumented repro on the live world and records the result on the issue:

1. Capture the exact update payload (`changes`, `options`) the tracker's `setFlag` sends from the Fighter's client, and the server's view of the combatant's ownership (whether `getUserLevel` resolves through the actor for that combatant).
2. Confirm that the closed-list writes are the only rejected combatant writes during a Strike → Damage sequence (watch the server log).
3. If the finding shows the rejection is caused by something configurable (a world permission setting, or this module's own hook mutating the payload), report it on the issue and amend the approach before building; the relay is the fix only if the server genuinely refuses an owner's flag write.

### Audit of this module's own writes

Planning also audits `scripts/` for Combatant/Combat document writes that can execute on a non-GM client (for example `setFlag`/`update` on combatants or the combat from click handlers, chat hooks and socket handlers not gated by `isGM`/`activeGM`) and lists any finding on the issue; any found are fixed in the same PR by routing them through the GM (or gating them), using the same relay helper where the shape fits.

### Strike and spell-attack coverage

The test plan and live verification explicitly exercise the Strike/attack button (`pendingAttackQueue`) and the spell-attack path in addition to the Damage button.

## Error handling

- A hook error lets the update proceed unchanged (the toast returns), never blocking a player's action.
- A relay for an unknown combat/combatant, a non-owner sender, an unlisted key or a malformed value is ignored on the GM side with a debug line; nothing is written.
- Duplicate relays are harmless (the write replaces the whole array with the same value).
- If the active GM changes while a relay is in flight, the message is handled by whichever GM client is active when it arrives; a dropped message leaves only the local value.
- The relay never touches GM clients' own writes.

## Testing

- **`classifyCombatantUpdate` (pure):** the two keys relayed; dotted and expanded forms; extra keys, another namespace or another tracker flag not relayed; non-array and oversized values not relayed; GM client never relayed.
- **Hook (mocked Foundry):** a player's tracker queue write is cancelled, applied via `updateSource`, and emitted; a GM write is untouched; an unrelated player write is untouched; an exception falls through to the original update; ordering before the #1212 guard.
- **GM handler:** accepts a valid owner's message and writes the flag; rejects non-owner, unknown combatant, unlisted key, bad value, inactive GM; repeated messages are idempotent.
- **No-GM path:** optimistic value kept, no emit, no toast, debug line.
- **Regression:** #1212 guard behavior unchanged for non-relayed updates; GM-run flows unchanged.
- **Audit result:** the audit is recorded; any added writes are tested.
- **Live verification:** as the Fighter player click Strike then Damage (and a spell attack): no error toast, the damage dialog and roll complete, the combatant's `pendingDamageQueue`/`pendingAttackQueue` persist (read as GM) and clear after use; with the GM client closed, no toast and no error in the console.

## Explicitly out of scope

- Drafting the upstream issue text (#1255) and changes to the tracker itself.
- Relaying other tracker writes or other modules' combatant writes (a closed list by decision).
- Reworking the tracker's action log or counting (#1252 covers the AI turn card).

## Open questions

None blocking. Left to planning: the repro result (which may refine the approach as described), the exact hook-registration order relative to #1212's handler, and whether `updateSource` needs to suppress the combatant's re-render.
