# Players: Defensive Advance Automation and Correct Action Cost

**Issue:** #1278 — a player using the **Defensive Advance** feat is charged for every follow-up action, and the Raise Shield and the closing Strike are not automated.

**Builds on:** #1094 / `docs/superpowers/specs/2026-10-09-human-turn-action-enforcement-design.md` (the module's integration with the PF2E Automated Action Tracker), #47 / `handleManualStrikeDamage` (a human's Strike damage), #931 / `handleTokenMoveForReactions` (the module's player-move hook), #1212 / #1254 (tracker flag-write quirks).

**Status:** Approved in design. Scope was decided in a foreground question session with the owner on 2026-11-09 (see "Resolved decisions").

## Summary

Defensive Advance (Champion feat, 2 actions, flourish): *"You Raise your Shield and Stride. If you end your movement within melee reach of at least one enemy, you can make a melee Strike against that enemy."* The tracker (`pf2e-auto-action-tracker` v0.19.1) already models it as one 2-action activity, but only absorbs the follow-up actions at no extra cost when they arrive in the order **Raise a Shield → Stride → (optional) Strike**. Players Stride first, which breaks the activity.

The module will, for a human player's Defensive Advance:

1. **Raise the shield automatically** as soon as the feat is used, so the tracker's chain starts in the right order.
2. **Strike the targeted actor automatically** when the player's first completed movement ends with that actor within melee reach.

The player then drags their token once; the tracker logs 2 actions in total.

## Investigation findings

Diagnosis from the live world (Herman Brightshield, the only holder of the feat) and the tracker's source (`main.js.map` `sourcesContent`).

- **The tracker defines the activity already.** `src/complexActions/library.ts`: `defensive-advance` = `raise-a-shield` THEN `stride` THEN `strike` (min 0, max 1). `ActionManager.addAction` opens it when the feat card is created (parent cost 2), then `ComplexActionEngine.evaluate` offers every later action to the open activity. A matching action is absorbed at cost 0. A non-matching action that costs actions marks the activity "Sequence Broken" (whisper) and is charged normally.
- **What happened in play.** Three tracker-era uses (2026-10-13, 2026-10-27 twice) show the activity open as "Waiting for: Raise A Shield then Stride then (Optional) Strike", followed by a separate `Stride: 25ft` entry, then a separate `Raise a Shield` entry, then a separate `Melee Strike`. The Stride-first order is the only cause needed to explain the double charging. The module's relay, flag guard and movement handling did not contribute.
- **Nothing automates it.** No code in `scripts/` or `tools/` handles Defensive Advance for a player. The only mentions are the AI-actor feat audit fixture (`tests/fixtures/targeted-feat-action-audit.json`, `notOffered`) and its spec.
- **The system API exists.** `game.pf2e.actions.raiseAShield({ actors })` is present (verified live), and `actor.heldShield?.isRaised` reads the state.
- **A player's Strike has an existing pipeline.** A human's rolled Strike damage message is applied, Shield-Blocked and critical-decked by `handleManualStrikeDamage` (GM client). The AI pipeline `rollAndApplyStrike` applies damage itself, so it must **not** be reused for a human or damage would apply twice.
- **MAP is tracker-owned.** PF2e does not carry the Multiple Attack Penalty in actor data; the tracker derives it from its log (`getCurrentMapStateFromLog`: count of `isMapRelevant` entries, including an activity's children).

## Resolved decisions

1. **Approach A: fix the order, do not touch the tracker.** Automate the shield raise so the chain begins in the order the tracker expects. Rejected: writing our own Defensive Advance executor and the tracker's action log (duplicates and couples to tracker internals).
2. **Auto-raise the shield at feat use** (owner: yes).
3. **Strike the targeted actor only, no fallback to another adjacent enemy** (owner: yes). RAW says "that enemy" — the enemy you end next to — and the owner's rule is the actor you targeted.
4. **The target is read when the movement completes**, not when the feat is used, so a player may target before or after clicking the feat.
5. **Human players only.** AI-controlled combatants keep their own pipeline (#910 / #947).

## Design

New file `scripts/defensive-advance.mjs`, wired from `module.mjs`. Pure decision logic is separated from the Foundry I/O so it unit-tests without a world.

### 1. Detect the feat use (`createChatMessage`)

On the **author's own client** only (`message.author?.isSelf`; a player's client performs the player's actions, as with a manual click). Acts when all hold:

- `message.item?.slug === "defensive-advance"` (the system's chat-message item getter; the card's `flags.pf2e.origin` carries the item UUID);
- the speaker resolves to a combatant in a started module combat (`isModuleCombat`) and that combatant is the current turn's combatant, not `agentControlled`;
- the actor is not defeated.

### 2. Raise the shield

Call `game.pf2e.actions.raiseAShield({ actors: [actor] })` only when the actor holds a shield that is not already raised. **The system action is a toggle**: if the Raise a Shield effect already exists it deletes the effect (lowers the shield) and posts nothing, so it must never be called on a raised shield. If the shield is already raised, or the actor has no shield (`actor.heldShield` is null), skip the raise and show the player a local notice; the Strike automation still arms. (If the shield was raised earlier this turn the tracker will not see a fresh `raise-a-shield` child, and the player pays for that action as they already did; this module does not paper over it.)

**Ordering race.** The tracker records the feat card through an async socket call to the GM, so a shield message posted immediately may be evaluated before the activity exists. Before raising, wait (poll, short interval, ~2 s cap) until the combatant's tracker log (`flags["pf2e-auto-action-tracker"].log`) contains an entry whose `msgId` is the feat card; on timeout, raise anyway and log a console warning.

### 3. Arm the pending Strike

Client-local state, keyed by token id: `{ combatId, combatantId, round, turn, armedAt }`. At most one per token; a new feat use replaces it. Cleared on: the Strike attempt (whether or not it fires), the combatant's turn ending (`updateCombat` turn/round change), `deleteCombat`, or the combat no longer being the token's current turn.

### 4. Trigger on movement completion (`moveToken`)

On the originating client (`movement.user` / hook user is `game.user`; the exact signature is confirmed in the plan's first task). Ignore movements whose waypoints include `displace` or `blink` (the module's own pushes, resnaps, AI walks), mirroring #931. The **first** completed movement of the armed token consumes the pending state; a later drag does not re-arm it. Then:

1. **Resolve the target.** `game.user.targets` must hold exactly one token. If it holds none or several, post a local notice ("Defensive Advance: target exactly one enemy to Strike automatically") and stop.
2. **Validate the target.** It must be a combatant in the same combat, not defeated, not the mover, not a party member, and hostile where forces are configured (`areHostile` from `force-hostility.mjs`).
3. **Reach.** The target must be within reach of a ready melee Strike (`actionReachSquares` + `REACH_EPSILON`, distance per `pf2eDistanceFeet`), choosing the ready melee Strike with the highest `totalModifier` among those in reach (the same selection `targetedStrikeActionFor` uses; its non-feat-specific core is extracted and exported for reuse). If none is in reach, stop silently: out of reach is the normal case for a short Stride, and the Strike is optional.
4. **Strike.** Roll exactly as the player would, through the system:
   - attack: `strike.variants[i].roll({ target: { document: targetToken }, createMessage: true })`, where `i = min(priorMapRelevantAttacks, 2)` read from the tracker log the way `getCurrentMapStateFromLog` counts it (flat-map each activity's `orderedActivityChildActions`, count `isMapRelevant`). If the log is unreadable, use `i = 0` and whisper the player that MAP could not be determined;
   - damage: on `success` / `criticalSuccess`, `strike.damage({ target, outcome, createMessage: true })`, the pair the module's AI path already uses.

   The attack and damage messages are authored by the player, so the existing hooks do the rest unchanged: the tracker absorbs the attack as the activity's third child, and `handleManualStrikeDamage` applies the damage, Shield Block and the critical-hit deck. Roll dialogs are skipped (the same effect as the Shift-click in PF2e).

### 5. Failure behaviour

No step may throw into the hook. Each failure posts one console error with the `MODULE_ID` prefix (the convention in `dungeon-combat.mjs`) and leaves the player able to finish the sequence by hand. A player who ignores the automation and clicks Strike manually still gets the correct cost, because the chain is intact.

## Testing

- **Unit (`tests/`)**, pure functions: the feat-card predicate, pending-state lifecycle (arm, replace, consume, clear on turn/combat change), target validation (none, several, self, party, defeated, non-hostile, hostile), reach selection (in reach, out of reach, longest reach, ranged-only weapon), and variant-index computation from a tracker log including a complex activity's children.
- **Contract guard:** a test that fails if the tracker library entry shape the module relies on (`defensive-advance` ordering) changes, using a pinned fixture copied from the tracker source.
- **Live check, required before closing:** Herman uses Defensive Advance in a real combat with a target in and out of reach, with and without a prior attack that turn. Pass criteria: tracker shows 2 actions for the activity, no "Sequence Broken" whisper, Strike rolled at the right MAP, damage applied once. The issue moves to `verification` after merge, per the repo rules, and closes only after this check.

## Verified at the start of the plan

These were not all provable from source alone; the first is confirmed in the final live check, with a stated fallback:

1. `moveToken` fires on the mover's own client. The handler is written not to depend on the answer: pending state is client-local, so only the arming client ever acts, and an acting user that is present in the hook arguments and is not the local user is ignored. If the hook does not fire on the player's client, the fallback is `updateToken` plus a position comparison.
2. ~~`raiseAShield` on an already-raised shield~~ — resolved from the system source: it is a toggle (see "Raise the shield"), so the module never calls it on a raised shield.
3. ~~Roll dialogs~~ — resolved from the system source: check rolls accept `skipDialog`; damage dialogs are suppressed with the same per-user `showDamageDialogs` flag toggle `rollAndApplyStrike` already uses.

**Stride ordering race (added with the plan).** The tracker records a Stride through the same async GM socket path as the feat card, so a Strike posted the instant the movement ends could be evaluated before the Stride is logged. Before rolling, wait (same bounded poll as the shield wait) until the Defensive Advance activity in the tracker log shows a claimed move child; on timeout, roll anyway.

## Out of scope

- Changing or patching the tracker module.
- AI actors using Defensive Advance (#910 / #947).
- Other Champion or complex-activity feats that share the Stride-first problem (e.g. Sudden Charge), a follow-up once this pattern is proven live.
- Choosing a different enemy than the one targeted.
