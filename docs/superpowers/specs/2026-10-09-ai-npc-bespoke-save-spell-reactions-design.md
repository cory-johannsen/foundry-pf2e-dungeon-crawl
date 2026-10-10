# Advanced AI NPCs: Bespoke Save- and Spell-Triggered Reactions

**Issue:** #1022 — remaining bespoke save- and spell-triggered NPC reactions (Dual Mind, Spell Break, Drowning Drone, Savor Anguish, Electric Reflexes, Reflective Scales), deferred from #960.

**Builds on:** #960 / `docs/superpowers/specs/2026-10-09-ai-npc-save-spell-reactions-design.md` (deterministic save-outcome adjustments, `improveOneDegree`/`degreeFor`), #963 / `docs/superpowers/specs/2026-10-09-ai-reaction-interception-design.md` (interception hooks, `commitId`, kill switch), #931 (`REACTION_DEFS`, `resolveReactions`, `markReactionUsed`), #959 (damage-seam triggers), #935/#915 (conditions, timed penalties, area saves), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Six reactions fall outside #960's table because each carries its own state or mechanic. All six are added as exact-match registry definitions, each with its own small state: **Dual Mind**, **Spell Break**, **Savor Anguish** (save-triggered, adjust outcome or grant temp HP), and **Drowning Drone**, **Electric Reflexes**, **Reflective Scales** (a check substitution, a damage-triggered grapple, and an area save).

## Investigation findings

From the Monster Core / Bestiary data.

- **Dual Mind** (hārakasura): trigger "fails a saving throw against a mental effect". The creature changes the result to a success; its body hangs limp until the end of its next turn: Clumsy 2, −10 ft circumstance Speed penalty, and it can't use Dual Mind, Dance of Destruction or Reactive Strike during that time.
- **Spell Break** (atrixyl): trigger "critically succeeds on a saving throw"; temp HP equal to **twice the triggering spell's rank** and a +4 status bonus to damage rolls for 1 round.
- **Savor Anguish** (divoynik, concentrate/mental): trigger "a creature within 30 feet fails a saving throw against an emotion effect"; 5 temp HP for up to 1 minute; the same creature can be fed on only once per 24 hours.
- **Drowning Drone** (boggard swampseer, auditory/mental): trigger "the swampseer or an ally within 60 feet attempts a saving throw against an auditory or sonic effect"; the swampseer rolls Performance and the swampseer and boggard allies in the area use the higher of that result and their save.
- **Electric Reflexes** (flesh golem): trigger "takes electricity damage and a creature is adjacent"; Athletics check to Grapple an adjacent creature; the creature takes 3d6 electricity on a success, 6d6 on a critical success.
- **Reflective Scales** (quai dau to): trigger "a creature within 30 feet casts a spell with the light trait or uses an ability with the light trait"; every creature in a 30-ft emanation must succeed at a DC 33 Fortitude save or be Blinded for 1 round.
- **Mechanisms available.** #960/#963 provide the save-card interception and degree adjustment; #959 provides the damage seam and `updateActor` fallback; #915 provides the area save executor; #935 provides timed conditions and penalties; the module already applies temp HP and timed bonuses through its effect helpers. Spell rank, traits and save type are on the origin data of save cards and spell cast messages.

## Resolved decisions

1. **All six reactions are modeled**, in two batches of three.
2. **Each is an exact-match reviewed definition** with its own state; all-or-nothing parsing and fixture checks (changed text disables the definition).
3. **Deterministic and automatic** (no model call), public announcements, as #960/#959. Where a reaction is optional in spirit (Dual Mind), the deterministic policy fires it when it converts a failure to a success.

## Design

### Dual Mind (`convertToSuccess`)

- **Trigger/eligibility:** a save card for the reactor with `outcome === "failure"` or `"criticalFailure"` against a save whose origin has the `mental` trait; Dual Mind not on cooldown (the "can't use" state below).
- **Adjustment:** at `preSaveCard` (#963) or retroactively in the fallback path (#960), change the outcome to `success`; record `commitId`.
- **Commit (GM):** `markReactionUsed`, then apply, until the end of the reactor's **next** turn: Clumsy 2, −10 ft circumstance Speed penalty, and set `flags.pf2e-dungeon-crawl.reactionLockout = ["dual-mind", "dance-of-destruction", "reactive-strike"]` so the registry and the Strike/feat vocabularies exclude them while it lasts. Applied as a timed effect through #935's helper and tagged for #914 cleanup.

### Spell Break (`critSuccessBoost`)

- **Trigger:** the reactor's save card with outcome `criticalSuccess`.
- **Effect:** `rank = origin.spell.rank` (heightened rank; if the origin has no rank, the reaction is not offered); grant temp HP `2 × rank` (not stacking with existing temp HP beyond the greater, per PF2e) and apply a +4 status bonus to damage rolls for 1 round via an effect tagged for #914. Announced publicly. No change to the save outcome.

### Savor Anguish (`feedOnFailure`)

- **Trigger:** any other creature within 30 ft of the reactor fails a save (outcome `failure`/`criticalFailure`) against an effect with the `emotion` trait.
- **State:** `flags.pf2e-dungeon-crawl.savored = { [creatureId]: worldTime }` on the reactor; a creature already savored within the last 24 in-game hours is excluded (the game clock, #785; if the clock is unavailable, treated as once per combat).
- **Effect:** 5 temp HP that expire after 1 minute (an effect with a 1-minute duration; the temp HP are removed when the effect expires), then record `savored[creatureId]`.

### Drowning Drone (`saveSubstitution`)

- **Trigger:** a save card for the reactor or a creature within 60 ft **of its disposition** against an effect with the `auditory` or `sonic` trait.
- **Effect:** roll Performance for the reactor (`actor.skills.performance.roll` quietly via the module's skill-roll helper, #909) once per triggering effect; for each qualifying save card (the reactor and its allies in the area) replace the saver's total with `max(save total, performance total)` and recompute the degree against the DC, with the usual nat 20/1 adjustments. Per-effect cache keyed by the triggering effect's origin id so one Performance roll serves all qualifying saves of that effect. The reaction applies at `preSaveCard` (#963); in the fallback path, outcomes are adjusted retroactively like #960.
- Once the reaction is spent, the cache covers the rest of the saves for that effect; no second reaction is consumed.

### Electric Reflexes (`damageGrapple`)

- **Trigger:** damage with the `electricity` type is applied to the reactor and a creature is adjacent (checked at the #959 damage seam and `updateActor` fallback).
- **Effect:** choose the adjacent creature by the deterministic opponent selection (highest priority), roll Athletics against the target's Fortitude DC (PF2e Grapple) via the module's maneuver executor (#911/#940) in reaction mode (no MAP, the grabbed condition applies on success per Grapple's rules). Additionally: the creature takes `3d6` electricity on a success and `6d6` on a critical success (a plain damage roll applied through `applyDamage`; resistances apply).

### Reflective Scales (`areaSaveBlind`)

- **Trigger:** a spell cast message (`flags.pf2e.origin.type === "spell"`) or an ability roll whose traits include `light`, cast by a creature within 30 ft of the reactor.
- **Effect:** run #915's area save executor for a 30-ft emanation centered on the reactor: each creature in it (including the triggering creature; allies of the reactor are included because the text says "all creatures") rolls Fortitude DC 33; failure or critical failure applies Blinded for 1 round via #935's timed condition helper (no immunity period; the text has none).

### Trigger plumbing (registry)

New trigger kinds in `REACTION_DEFS`: `saveFailedMental`, `saveCritSuccess`, `nearbySaveFailedEmotion`, `saveVsTrait` (auditory/sonic), `electricityDamageAdjacent`, `lightTraitUsed`. Each is a tiny predicate over the replicated message/damage data. The shared gates (agent-controlled, reaction item present, reaction unused this round) apply. One reaction per reactor per round.

## Error handling

- Missing origin data (spell rank, traits, DC): the reaction is not offered; no partial effects.
- Interception unavailable: falls back to #960's retroactive path for save-outcome reactions; damage/area reactions use the module seams.
- A failed effect application aborts without marking the reaction used.
- Clock unavailable: Savor Anguish uses once-per-combat per creature.

## Testing

- **Each reaction**, on fixtures: Dual Mind converts failure and applies the penalties and lockout; Spell Break uses twice the rank; Savor Anguish honors the 24-hour marker; Drowning Drone's single Performance roll serves several saves; Electric Reflexes grapples and damages by degree; Reflective Scales saves per creature in the emanation.
- **Eligibility:** wrong traits, out-of-range creatures, used reaction, locked-out reaction.
- **Fixtures:** the six items match their definitions; changed text disables each.
- **Live verification:** a hārakasura resists a mental spell and shows the clumsy penalties; a quai dau to blinds a party that casts light.

## Explicitly out of scope

- General (non-bespoke) reaction triggers, covered by #931/#960/#963.
- Reroll-type save reactions (#1035) and `Check.roll` wrapping (#1034).

## Open questions

None. Planning-time details: the exact Performance-roll helper, and which ability roll messages expose the `light` trait.
