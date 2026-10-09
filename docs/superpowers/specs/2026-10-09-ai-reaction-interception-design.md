# Advanced AI Actors: Intercepting Player Attack, Save and Damage Flows for Reactions

**Issue:** #963 — intercept player attack and damage flows so defensive reactions apply automatically (deferred from #931).

**Builds on:** #931 / `docs/superpowers/specs/2026-10-08-ai-npc-reactions-design.md` (the reaction registry, `resolveReactions`, the reaction-used economy, the "after the roll, retroactively" approach this spec improves on, and the GM-confirm card), #960 / `docs/superpowers/specs/2026-10-09-ai-npc-save-spell-reactions-design.md` (save-outcome adjustments and condition negation, the pure adjustment functions), #961 / `docs/superpowers/specs/2026-10-09-ai-npc-other-triggered-reactions-design.md` (the `enemyDamagesAlly` trigger and ally resistance), #962 (Shield Block for characters) and the module's relay (`scripts/dungeon-remote.mjs`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#931 and #960 can only react to a **player's** attack, save or damage **after** the system has produced it: the module sees the finished chat message, edits it retroactively, and — when a human GM is present — asks the GM to confirm with a card. That cannot make a defensive reaction *prevent* anything, and it leaves a confirmation step in every case. This spec adds an **interception layer** built from **public Foundry hooks plus one guarded method wrapper**, so reactions run **synchronously, before** the result appears or is applied:

- **`preCreateChatMessage`** corrects the outcome of an attack or save **before the card is created** (AC-bonus reactions; deterministic save-outcome adjustments).
- **`preCreateItem`** cancels a condition **before it exists** (condition negation such as Slough Skin).
- A guarded wrapper on **`actor.applyDamage`** applies damage-step reactions (Shield Block, ally resistance) **before damage is applied**, for any damage source: Strike cards, spell cards or a manual Apply click.

The layer needs no patching of the system's roll code. It is feature-detected and has a GM kill-switch setting; when it is unavailable, the #931/#960 retroactive and GM-confirm paths remain as the fallback. Reaction decisions in intercepted flows are **deterministic only** (no agent-service call), so nothing waits on a model.

## Investigation findings

Confirmed against the repo, the installed PF2e system (v8.5.0, `pf2e.mjs`) and Foundry v14.

- **The system exposes almost no hooks for this.** The only module-visible system hooks are `pf2e.damageRoll` (fired after the damage roll), `pf2e.preReroll` / `pf2e.reroll`, `pf2e.startTurn`, `pf2e.endTurn`, `pf2e.restForTheNight` and `pf2e.systemReady`. None lets a module change an attack roll before it resolves.
- **Core Foundry hooks are enough for outcome and creation edits.** `preCreateChatMessage(message, data, options, userId)` and `preCreateItem(item, data, options, userId)` are synchronous core hooks that fire **on the client that initiates the creation**, before the document is written; a handler may mutate the pending document with `updateSource` and a `preCreateItem` handler may cancel creation by returning `false`. They cannot await anything, so a handler must decide synchronously.
- **Whose client runs them.** A player's attack roll message is created on the **player's** client; a monster's save is rolled by the GM (or the owner), on that client; a condition created by a spell is created on the client applying it. The hooks therefore run on **any** client with the module active, and cannot rely on GM-only privileges.
- **What a roll message carries.** `flags.pf2e.context` holds the type (`attack-roll`, `saving-throw`), the roll `outcome`, `dc.value`, the target and origin actors and the roll `options` including effect traits; the roll total is in the message's roll data. These are enough to re-evaluate a degree of success and to match trait-conditioned triggers.
- **How the message renders its result.** The pending message's `content`/`flavor` is built before `preCreateChatMessage`; whether the result styling is derived from `flags.pf2e.context.outcome` at render time or baked into the HTML is confirmed at planning, and the layer corrects both (flag and visible markup) either way.
- **Every damage application funnels through `actor.applyDamage`.** The system's own Apply buttons call it (including the shield-block toggle via `shieldBlockRequest`), and so do the module's AI executors (`rollAndApplyStrikeAtVariant`, `handleManualStrikeDamage`, trap and card damage). It takes `{ damage, token, item, rollOptions, shieldBlockRequest, … }`, so a wrapper can see the target, an origin item (hence the attacker via `item.actor` for Strikes) and the roll options.
- **Rerolls cannot be done synchronously.** A reroll must roll dice and create messages asynchronously, which a `preCreate` hook cannot await. Reroll and two-roll reactions (Cat's Luck, Shift Fate, Distracting Frolic) therefore stay on #960's after-the-fact path (#1035).
- **Authority and replication.** A reaction's side effects need GM authority (writing the combat's reaction-used flag, creating effects on the reactor, public announcements). The decision inputs (the reactor's items, the combat flags, tokens and positions) are replicated to clients; the module's relay (`dungeon-remote.mjs`) already carries player-originated requests to the GM client (the relay's GM account in a run with no human GM).
- **GM-less constraint.** In GM-less runs there is no human to click a confirm card, so interception must be automatic there; with a human GM present it replaces the confirm card for the covered cases.

## Resolved decisions

1. **Mechanism: public hooks plus one guarded method wrapper** (`preCreateChatMessage`, `preCreateItem`, an `applyDamage` wrapper). A wrapper on the system's `Check.roll` is #1034.
2. **Coverage:** AC-bonus reactions against player attacks, damage reduction at application (Shield Block and ally resistance), deterministic save-outcome adjustment before the card, and condition negation at creation.
3. **Deterministic decisions only in intercepted flows.** No agent-service call; reroll-type reactions stay on #960's path (#1035).
4. **Safe by construction:** feature-detected at startup, guarded against re-entrancy, a GM kill-switch setting, and automatic fallback to #931/#960's behavior.

## Design

### Components

- `scripts/reaction-intercept.mjs`: installs the hooks and the wrapper; owns feature detection, the kill switch and the shared guard.
- `scripts/reaction-intercept-core.mjs` (pure): the synchronous decision functions that the hooks call (no Foundry access), reusing #960's adjustment helpers (`improveOneDegree`, `degreeFor`, `better`/`worse`).
- The existing registry (#931) supplies the definitions, with each definition declaring which intercepted phases it supports (`phases: ["preAttackCard", "preSaveCard", "preApplyDamage", "preCreateCondition"]`).

### Decision and commit

An intercepted flow has two steps because the hooks are synchronous but side effects need the GM:

1. **Decide (synchronous, on the calling client).** From replicated data, the pure functions determine whether a reaction applies and what the adjustment is: eligibility gates (the reactor is an agent-controlled combatant in this combat, has the reaction item, the reaction is **unused** in the replicated `reactionUsed` flag, it observed the triggering creature), then the definition's deterministic policy (for AC bonuses: the bonus must change the degree of success; for damage reduction: the policy from #931/#962). When several definitions are eligible for the same trigger, the highest priority wins (no model call). The decision returns the adjustment (a corrected outcome, a reduced damage amount plus `shieldBlockRequest`, or "cancel creation") and a `commitId`.
2. **Apply (immediately).** The hook applies the adjustment to the pending document or the call arguments, so the change is visible from the start.
3. **Commit (asynchronous, on the GM client).** A request carrying the `commitId`, the reactor, the reaction and the trigger is relayed to the GM (executed directly when the caller is the GM). The GM handler re-checks the authoritative state, then performs the side effects: `markReactionUsed`, decrementing frequency or recharge, creating any linked effect, and the public announcement. The handler is idempotent on `commitId`. If the authoritative check fails (a race: the reaction was already spent a moment earlier), the commit is rejected, a GM note is posted, and the adjustment already applied stands (the reaction is not retracted); this is accepted because the window is a few milliseconds and the cost is one extra, harmless defensive effect.

### `preCreateChatMessage`: attack and save cards

- **Attack rolls (AC-bonus reactions).** For a message with `flags.pf2e.context.type === "attack-roll"` whose target actor is an agent-controlled NPC combatant with an eligible `acBonus` reaction (#931's Wing Deflection, Ghost Dodge, Swat Projectile and similar): compute the degree against `dc + bonus` from the roll total with the PF2e rules (`degreeFor`); if the degree changes in the defender's favor and the reaction's own conditions hold (a ranged strike or spell attack, no fire trait for Icy Deflection, and so on), `updateSource` the context outcome, set `flags.pf2e-dungeon-crawl.reactionAdjustedOutcome`, and patch the visible result markup and add a one-line public note ("<reactor> uses <reaction>: +2 AC — hit becomes miss") to the card. The module's own damage application for the paired damage roll reads the adjusted outcome (a hit that became a miss applies no damage), as in #931.
- **Saves (deterministic adjustments).** For `saving-throw` messages (the saver is the reactor, or an ally/other creature in range): apply #960's deterministic adjustments (Golden Luck, Reality Twist, Abrogation of Consequences, Free Mind's +4 recompute) the same way. Reroll and two-roll reactions are not handled here (#1035).

### `preCreateItem`: condition negation

For a `condition` item whose parent actor is an agent-controlled NPC combatant with an eligible negation reaction (Slough Skin) and a harmful condition: return `false` to cancel the creation, then commit (announce, spend frequency). No retroactive deletion is needed. Persistent damage and conditions from the module's own helpers are unaffected (they already pass the module-owned seam of #960).

### `applyDamage` wrapper

At `ready`, if `typeof CONFIG.Actor.documentClass.prototype.applyDamage === "function"` and the kill switch is off, wrap it once:

```js
async function wrappedApplyDamage(args) {
  if (inIntercept) return original.call(this, args);   // re-entrancy guard
  let adjusted = args;
  try { adjusted = interceptDamage(this, args) ?? args; } catch (err) { console.error(err); }
  return original.call(this, adjusted);
}
```

`interceptDamage` is synchronous and pure: for the damaged actor (and for reactors that protect it) it evaluates damage-step definitions — **Shield Block** (the target is a reactor with a raised, unbroken shield; the damage is physical from an attack) sets `shieldBlockRequest: true`; **ally resistance** (#961's `enemyDamagesAlly` with Archon's Protection / Retributive Strike, #962's Flash of Grandeur) reduces `damage` by `resistance` for this application when a protecting reactor is in range of the damaged ally and the attacker is identified (from `args.item?.actor`; if the source cannot be identified, the reaction is not used). The commit step (reaction-used flag, announcement, the Strike half of Retributive Strike) is relayed to the GM. The wrapper never throws: any failure falls through to the original call with the original arguments.

### Fallback and kill switch

- **Feature detection.** If `applyDamage` is missing, if wrapping fails, or if the installed system version is not in the verified range (a `module.json`-driven allowlist of system versions), the wrapper is not installed and the registry marks the affected phases unavailable; the flows fall back to #931/#960 (retroactive adjustment, GM-confirm card with a human GM, automatic in GM-less runs as before).
- **Kill switch.** A GM world setting `reactionInterception` (default on) disables all three hooks and the wrapper at runtime (checked on every call), so a misbehaving environment can be fixed from settings without a code change.
- **Telemetry.** Each interception outcome (applied, skipped, errored, commit rejected) is counted and logged at debug level; a repeated error disables that phase for the session and tells the GM once.

### Reporting

Public announcement lines and #925's result descriptor, as in #931. The card note on an adjusted attack or save shows the reaction and the before/after degree.

## Error handling

- Every hook and the wrapper are wrapped in try/catch; a failure leaves the original message, item or damage untouched.
- A failed commit (relay unavailable, GM offline) leaves the adjustment applied and posts a GM note; the reaction-used flag is set when the GM next processes the queued request, or the reaction is simply unrecorded for that round (an acceptable, logged inconsistency).
- A handler that returns `false` from `preCreateItem` only for conditions it has decided to negate; any exception returns the default (do not cancel).
- If the replicated data needed for a decision is missing on the calling client (an actor not delivered), the decision is "no reaction".
- Re-entrancy: the wrapper and the commit path set a guard so the reaction's own `applyDamage`/effect creation is never intercepted again.

## Testing

- **Pure decision functions:** AC-bonus degree re-evaluation at every boundary and natural 20/1, only-when-the-degree-changes, trait conditions (ranged, no fire), deterministic save adjustments, damage-step policies, ally resistance math, no-reaction cases (reaction used, not observed, unidentified attacker).
- **Hooks (mocked Foundry):** `preCreateChatMessage` mutates outcome flag, visible result and note for a qualifying attack and leaves other messages alone; save messages likewise; `preCreateItem` returns `false` for a negated condition and not otherwise; handlers survive malformed data.
- **Wrapper:** `applyDamage` receives `shieldBlockRequest` or the reduced damage when a reaction applies and the original arguments otherwise; the re-entrancy guard; exceptions fall through; installed once; not installed when detection fails; the kill switch bypasses it at runtime.
- **Commit:** idempotent on `commitId`; rejects when the authoritative flag shows the reaction used; posts the GM note; executes on the GM client from a player-originated request, including in a GM-less run via the relay.
- **Fallback:** with the layer disabled or undetected, #931/#960 behavior (retroactive edit, confirm card) is unchanged; their existing tests keep passing.
- **Regression:** damage application, `handleManualStrikeDamage`, #202 and #931/#959/#960/#961/#962 tests keep passing.
- **Live verification:** a player attacks a monster with Wing Deflection, Icy Deflection or Swat Projectile (the card appears already corrected); a player's Strike and a spell damage card against a Shield Block monster and an Archon's Protection pair; a condition applied to a Slough Skin worm; in a human-GM run and a GM-less run; then flip the kill switch and confirm the fallback.

## Explicitly out of scope

- Wrapping the system's `Check.roll` for true pre-roll DC adjustment — #1034.
- Asynchronous interception for reroll-type reactions (Cat's Luck, Shift Fate, Distracting Frolic) — #1035.
- Spell-counteracting reactions that cancel a spell's effects (#1021), which can build on this layer afterward.
- Reactions for human-controlled characters; model-chosen decisions in intercepted flows.
- Changing how the system rolls or renders checks.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: how the installed system derives a card's result styling (flag vs baked HTML) and the cleanest way to patch it, the exact `applyDamage` argument shape on this system version and how reliably the damage source is identifiable, the system-version allowlist mechanism, and the relay message shape for commits.
