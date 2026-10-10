# Advanced AI NPCs: Round- and Initiative-Timing Reactions

**Issue:** #1026 — round- and initiative-timing NPC reactions (Warning Howl, All This Has Happened Before, Spring upon Prey, Rise Up), deferred from #961.

**Builds on:** #961 / `docs/superpowers/specs/2026-10-09-ai-npc-other-triggered-reactions-design.md` (other-triggered reactions, trigger grammar), #931 (`REACTION_DEFS`, `resolveReactions`, `markReactionUsed`), #616 (`rollStealthInitiativeAndDetect`, the detection matrix), #935/#915 (conditions, timed effects, area saves), #910 (daily frequency state), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Four reactions fire on timing events rather than on another creature's action: an NPC **rolls initiative** (with Stealth, or is about to roll), or a creature **touches a web / walks over a buried creature before initiative has been rolled**. This spec models all four — **All This Has Happened Before**, **Warning Howl**, **Spring upon Prey**, **Rise Up** — by adding two hooks around the module's own initiative flow and a small **ambush tag** on NPC tokens. Hidden, buried and on-a-web states come from tags set at encounter setup, never inferred.

## Investigation findings

- **The four reactions** (compendium):
  - *All This Has Happened Before* (samsaran anchorite, occult, once per day): trigger "about to roll initiative"; +4 circumstance bonus to the triggering roll; if that makes the anchorite the first creature to act, it is also Quickened for 1 round, usable only to Recall Knowledge or Step.
  - *Warning Howl* (hound topiary, fear/emotion/mental/visual): trigger "rolls for initiative using Stealth"; creatures within 30 ft attempt a DC 17 Will save or become Frightened 1; they are then immune to all hound topiaries' Warning Howls for 1 hour.
  - *Spring upon Prey* (web lurker): trigger "a creature touches the web lurker's web while it is on it"; requirement: initiative has not yet been rolled; the lurker automatically notices the creature and Strides or Climbs before rolling initiative.
  - *Rise Up* (bog mummy): trigger "a creature walks on top of a buried bog mummy"; requirement: initiative not yet rolled; the mummy automatically notices the creature and Burrows before rolling initiative.
- **The module owns the initiative flow.** `rollStealthInitiativeAndDetect(combat, combatants, deps)` (`scripts/dungeon-combat.mjs`) rolls initiative for a new combat: sneakers roll Stealth and set initiative with `setMultipleInitiatives`, everyone else uses `combat.rollInitiative(ids, { skipDialog: true })`. Hostile NPCs currently always roll Perception initiative; there is no hook before or after. This is the natural seam for both initiative reactions and for ambush resolution.
- **Pre-initiative actions.** Spring upon Prey and Rise Up act *before* initiative is rolled. In the module's flow that is the window between creating the combat and calling `rollInitiative`, when the tokens are placed and the party has just moved into the room.
- **State.** The module has no concept of "hidden NPC", "buried" or "on a web"; room feature tokens (#611/#623) exist but do not mark NPC starting states.

## Resolved decisions

1. **All four reactions are in scope** (initiative bonus, Stealth-initiative howl, and the two pre-initiative ambushes).
2. **State comes from ambush tags set at encounter setup**: `flags.pf2e-dungeon-crawl.ambush = { kind: "web" | "buried" | "stealthInitiative", webTokenId? }` on the NPC token. Reactions fire only for tagged tokens; nothing is inferred from conditions or templates.
3. **Deterministic and automatic**, announced publicly, no model call (as #931/#959/#961).

## Design

### Ambush tags (`scripts/npc-ambush.mjs`)

- `ambushTagFor(npcActor, roomContext)` returns a tag for an NPC whose reviewed definition has an initiative-timing reaction: a web lurker placed in a room with web terrain gets `{ kind: "web", webTokenId }` (the web feature token's id); a bog mummy placed in a mud/peat room gets `{ kind: "buried" }`; a hound topiary gets `{ kind: "stealthInitiative" }`. The encounter generator applies the tag when it places the token (the existing placement code already knows the room context); an NPC without a tag never triggers these reactions.
- Tags are cleared when the reaction resolves or when the combat ends.

### Initiative hooks (`rollStealthInitiativeAndDetect` and a new pre-roll step)

Two new internal steps in the module's combat-start flow, in order:

1. **`resolveAmbushReactions(combat, party)`** runs after the combat is created and **before** any initiative is rolled. For each tagged `web`/`buried` NPC, if a party token is on the web feature token's squares (`web`) or on the buried NPC's square (`buried`) at this moment, the reaction fires: the NPC automatically notices the creature (the detection matrix, #616, marks it as having noticed), then Strides or Climbs (`web`) / Burrows (`buried`) using the existing movement executor toward the triggering creature, and then rolls initiative normally. Because the move happens before initiative, its position is simply the new starting position. `markReactionUsed` is not needed (initiative has not started); the tag is cleared and the event announced publicly ("The web lurker lunges from its web!").
2. **`applyInitiativeReactions(combat, combatants)`** wraps the initiative roll:
   - *All This Has Happened Before:* before `rollInitiative` for an eligible anchorite (reaction unused, daily frequency available per #910, a reviewed definition match), apply the `+4` circumstance bonus as a one-roll effect on the initiative statistic (or roll Perception manually with the bonus and call `setMultipleInitiatives`, as the sneak path does). After initiative is set, if the anchorite is first in `combat.turns`, create the Quickened effect (1 round, tagged for #914), with the "only to Recall Knowledge or Step" restriction recorded in `flags…quickenedRestriction` so the vocabulary offers only those actions with the extra action. Decrement the daily frequency and announce.
   - *Warning Howl:* an NPC tagged `stealthInitiative` rolls Stealth initiative (the existing sneaker path generalized to NPCs); on that roll the reaction fires: run #915's area-save executor for a 30-ft emanation, Will DC 17, failure → Frightened 1 via #935's helper, then apply the 1-hour immunity marker (`howlImmunity` on each affected creature, game clock #785) against all hound topiaries; creatures already immune are skipped.
   The wrapper falls back to the existing unchanged `rollInitiative` call whenever no eligible reactor exists.

### Registry integration

The four definitions are exact-match reviewed entries (`REACTION_DEFS`, trigger kinds `aboutToRollInitiative`, `rolledInitiativeWithStealth`, `touchedWebBeforeInitiative`, `walkedOverBuriedBeforeInitiative`). Trigger text and effect text are fixture-checked, and every sentence of the effect must be consumed (all-or-nothing). The shared gates (reaction item present, reaction unused) apply, except that "unused this round" is vacuous before the first round.

### Policy

Always automatic: the reactions have no downside (the anchorite's bonus, the hound's howl, the ambushers' pre-initiative move). Order: ambushes first, then the initiative bonus, then Stealth rolls.

## Error handling

- Missing or stale tag: reaction not offered.
- Web feature token gone or no creature on it: ambush does not fire; the NPC rolls initiative normally.
- Immunity marker unreadable (clock missing): treated as once per combat.
- Any effect failure aborts that reaction without blocking the combat from starting.

## Testing

- **Tagging:** tags assigned by room context; no tag for others.
- **Ambush:** a party token on the web/buried square triggers the pre-initiative move; none when not; tag cleared.
- **Initiative:** +4 applied only for an eligible anchorite; Quickened only when first; frequency decremented; Stealth initiative path for tagged NPCs; Warning Howl save, Frightened 1 and immunity.
- **Fixtures:** the four items match; changed text disables each.
- **Live verification:** walk a party onto a web lurker's web at encounter start and see it Stride before initiative; a hound topiary howls on a Stealth initiative roll.

## Explicitly out of scope

- Inferring hidden/buried/on-web states from conditions or templates (rejected).
- Player-character initiative reactions (#962).
- Other initiative-modifying abilities not in the four.

## Open questions

None. Planning-time details: where the generator places tagged NPCs, and how party tokens' positions are compared with the web feature token at combat creation.
