# Combat surprise round via PF2e Avoid Notice — design

**Tracks:** [#616](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/616)

## Problem

`handleDungeonDoorOpened()` (`scripts/dungeon-scene.mjs`, ~line 1828) goes straight from door-open to `startCombatForRoom`, which rolls initiative and starts combat for every combatant with no stealth/surprise concept at all. PF2e's real rule for this (confirmed via web research, not assumption) is **not** a single party-vs-room check: each avoiding character rolls their own Stealth as initiative, compared individually against every hostile's Perception DC, producing a per-character detection status (unnoticed/undetected/hidden/observed) — the issue's own framing ("a group Stealth check... on success, a free round") is already a simplification of the real rule, which this spec deliberately keeps (see "Decision: aggregation rule" below) rather than build the full per-character-vs-per-enemy matrix.

## Key decision: adopt PF2e Avoid Notice (a real third-party module), don't hand-roll detection

A purpose-built, actively-maintained Foundry module, **PF2e Avoid Notice** (`pf2e-avoid-notice`, GitHub `Eligarf/avoid-notice`, verified compatible with Foundry v14), already implements the real per-character-vs-per-enemy detection logic RAW calls for. Confirmed by cloning and reading its actual source this session (not just its docs, which don't document an API):

- It hooks the **core** `combatStart` Hook (fired by `Combat#startCombat()`, which this module's own `startCombat()` already calls — no new trigger needed).
- It only processes a combatant whose `Combatant.flags.pf2e.initiativeStatistic === "stealth"` — confirmed in the real PF2e system source (`pf2e.mjs`) that this flag is **written** by `Combatant#setMultipleInitiatives` based on whichever statistic `rollInitiative` actually used, and that `rollInitiative` itself reads each actor's own `system.initiative.statistic` field (plain string, defaults to `"perception"`) to decide which statistic to roll. There is nothing to "pre-set" on the Combatant directly — the actor's own field must be temporarily changed before rolling.
- With its own `requireActivity` setting at its default (`true`), it additionally requires the rolling PC to actually have the real "Avoid Notice" action item (confirmed live: exists in the `pf2e.actionspf2e` compendium, slug `avoid-notice`) present in `actor.system.exploration` (the array of this-phase-selected exploration-activity item ids).
- In its default ("vanilla", no extra visibility-handler module) mode, it applies a single, plain PF2e condition (`unnoticed`/`undetected`/`hidden`/`observed`, confirmed via its real `actor.toggleCondition(slug, {active: true})` call — the same documented, stable PF2e API, not a proprietary mechanism) onto the **avoiding party member's own actor**, aggregated across every hostile observer. It does **not** touch the hostile side, and has **no surprise-round or skip-turn concept anywhere in its source** (confirmed: zero matches for "surprise"/"unaware"/"skip" across its own codebase). Translating "these are the party's detection results" into "these hostiles get no action in round 1" is genuinely new logic this module must still write.

This avoids re-deriving PF2e's real Stealth-vs-Perception detection math (the one genuinely rules-accurate, failure-prone part) while keeping the "what does a surprise round actually do mechanically" part — a question PF2e itself leaves to GM judgment — as new, explicit, documented logic in this module.

## Key decision: how to get a Stealth-based initiative roll, fully self-contained

Rather than requiring the GM to change `pf2e-avoid-notice`'s own `requireActivity` setting (a drift-prone, easy-to-forget manual step), this module temporarily grants and selects the real "Avoid Notice" item on each party actor itself — satisfying `requireActivity: true` (the module's real default) with zero GM configuration. Confirmed live the real item has **no rule elements** (`rules: []`), so granting it alone does not force a Stealth roll — `system.initiative.statistic` must still be set directly alongside it. Sequence, per party actor, run at door-open time for a combat room (before `startCombatForRoom`):

1. Save `originalExploration = actor.system.exploration` (confirmed live: a real, already-populated array — e.g. `["kU0zHcoyNK5UVqKT"]` for a real party member today, never safe to assume empty) and `originalInitiativeStatistic = actor.system.initiative.statistic`.
2. Check whether the actor already owns a real item with slug `avoid-notice` (`actor.itemTypes.action.find(i => i.system.slug === "avoid-notice")`). If not, create a temporary embedded copy from the `pf2e.actionspf2e` compendium entry and remember that this module created it (so cleanup only ever removes what it added).
3. `await actor.update({"system.exploration": [avoidNoticeItemId], "system.initiative.statistic": "stealth"})`.
4. (Combat-start proceeds — see below.)
5. After reading the surprise result, `await actor.update({"system.exploration": originalExploration, "system.initiative.statistic": originalInitiativeStatistic})`, and delete the temporarily-created item if this module created one in step 2.

## Key decision: hook-timing synchronization is a real, unresolved risk

Core Foundry's `Hooks.callAll` (what `Combat#startCombat()` uses to fire `combatStart`) does **not** await async listeners — `avoid-notice`'s own handler is `async` but nothing makes `await combat.startCombat()` wait for it to finish applying conditions. This module needs a short delay between starting combat and reading the resulting conditions. Matching this codebase's own existing tunable-delay convention (`movementStepDelayMs`/`actionPaceDelayMs`, both real `game.settings.register` world settings read in `dungeon-combat.mjs`), add a new `surpriseCheckDelayMs` world setting (suggested default: 1000ms) rather than a hardcoded constant. **This exact value, and whether a fixed delay is reliable at all, is not fully verifiable by reading source alone — the implementation plan's own verification task must confirm live** that `avoid-notice`'s conditions have actually landed by the time this module reads them, and tune the default accordingly; this is flagged as a real open risk, not a settled fact.

## Decision: aggregation rule (my recommendation, not yet separately asked)

`avoid-notice` applies a per-party-member condition, not a single party-wide result. This module needs its own rule to decide "did the party, as a whole, achieve surprise" from those individual results, since PF2e has no single answer for this either. **Recommendation:** the party achieves surprise only if **no** party member ends up `observed` by any hostile (i.e. every avoiding member's own applied condition is `unnoticed`, `undetected`, or `hidden` — any one of those three counts as achieving at least partial surprise; `observed` on even one member means the alarm is raised and nobody gets a free round). This is a real, named simplification — PF2e's actual RAW would let individually-undetected party members act with surprise even if one ally was spotted, but resolving *that* would require per-hostile-vs-per-party-member turn skipping rather than one all-or-nothing flag on the hostile side, which is far more complexity than this issue's own "the party gets a free round" framing asks for.

## Scheme

**`scripts/dungeon-combat.mjs`** — `startCombat(scene, flagKey, flagValue)` (the shared function behind both `startCombatForRoom`/`startCombatForEncounterId`) gains, between its existing `combat.createEmbeddedDocuments("Combatant", ...)` call and its existing `combat.rollInitiative(...)` call:

1. Grant/select Avoid Notice + force Stealth initiative on every party actor in `combatants` (per the sequence above).
2. `await combat.rollInitiative(combatants.map(c => c.id), {skipDialog: true})` (unchanged call, now Stealth-aware for party members because of step 1).
3. `await combat.startCombat()` (unchanged call — this is what fires `avoid-notice`'s own hook as a side effect).
4. `await new Promise(r => setTimeout(r, game.settings.get(MODULE_ID, "surpriseCheckDelayMs")))`.
5. New function `resolveSurpriseRound(combat, combatants)`: reads each party combatant's actor's own condition items for `unnoticed`/`undetected`/`hidden`/`observed`; applies the aggregation rule above; on success, sets `flags["pf2e-dungeon-crawl"].surprised = true` on every **hostile** combatant (never party combatants).
6. Revert every party actor's `system.exploration`/`system.initiative.statistic` (and delete any temporarily-created Avoid Notice item), regardless of whether surprise succeeded.

**`scripts/dungeon-combat.mjs`**'s `autoPlayCombatantTurnIfDue` (the function that already exclusively drives non-party/hostile turns, confirmed via its own existing `isExcludedFromAutoPlay` guard) gains, directly after its existing `if (combatant.isDefeated) { await combat.nextTurn(); return; }`:

```js
if (combat.round === 1 && combatant.getFlag(MODULE_ID, "surprised")) {
  await combat.nextTurn();
  return;
}
```

No change needed to clear the flag afterward — gating on `combat.round === 1` already stops it mattering once round 2 begins.

**`scripts/module.mjs`** — new `game.settings.register(MODULE_ID, "surpriseCheckDelayMs", {...})`, mirroring `movementStepDelayMs`'s own registration shape exactly.

**`module.json`** — new entry in `relationships.requires`: `{id: "pf2e-avoid-notice", type: "module", compatibility: {minimum: "14.0.0"}}` (exact version floor to be confirmed against whatever `pf2e-avoid-notice` release is actually installed during implementation — this session confirmed it exists and is compatible with Foundry v14, not a specific pinned module version).

## What does NOT need changes

- `pf2e-avoid-notice` itself — used entirely through its own existing, unmodified `combatStart` hook and the standard PF2e condition API it already uses internally. No fork, no patch.
- Party-member turn-taking — surprise only ever gates the hostile side; a party member's own turn during round 1 is completely unaffected (they were never the thing being "snuck past").
- `trap-combat.mjs`'s own skill-check pattern — referenced as prior art in the issue, but not reused directly here: this feature's actual check (Stealth-via-initiative) is a fundamentally different PF2e mechanic (initiative substitution, not a standalone `actor.skill.roll({dc})` call), and the real detection math is delegated to `avoid-notice` rather than hand-rolled.

## Deliberately out of scope

- The full per-character-vs-per-enemy detection matrix (every individual party member keeping their own independent surprise status against every individual hostile) — the aggregation-rule decision above explicitly simplifies this to one all-or-nothing flag on the hostile side.
- Any UI for the GM to override/force a surprise result — not requested by the issue; a GM can already manually clear a hostile combatant's `surprised` flag via existing Foundry document-editing tools if needed.
- Ranged/area-effect nuances of what an "unaware" creature can still perceive (e.g. a loud trap going off elsewhere) — out of this issue's scope, which is specifically about the moment a combat room's door opens.
