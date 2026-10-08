# Advanced AI Actors: Feat-Modified Maneuver Variants

**Issue:** #911 — non-basic maneuver variants for AI actors (feat-modified Trip/Shove/Grapple/Disarm/Demoralize).

**Builds on:** #909 / `docs/superpowers/specs/2026-10-08-ai-actor-maneuvers-design.md` (the basic-maneuver vocabulary builder `buildManeuverVocabulary` and the `maneuver` execution branch in `applyAgentDecision`). This spec changes *that* work's eligibility checks and outcome riders; it adds no new subsystem and no new agent-service endpoint.

**Status:** Approved. Drafted from investigation of this repo, the installed PF2e system and the live compendium; the four open questions were answered by the owner on 2026-10-08 and are folded in below (see "Resolved questions").

## Summary

#909 models Trip, Shove, Grapple, Disarm and Demoralize at base RAW. Characters often carry feats that change those same five actions. This spec defines a small, curated **maneuver-modifier table** keyed by feat slug. Each entry either (a) changes an **eligibility** rule in `buildManeuverVocabulary` (Titan Wrestler's larger size cap, Sly Disarm's skill substitution) or (b) adds an **outcome rider** in the `maneuver` executor (Crushing Grab's damage, Terrified Retreat's Fleeing). Feats whose effect is a numeric bonus carried by the system's own rule elements need no code at all, because the maneuver is rolled through the actor's real statistic. Active feats that are *actions* (Combat Grab, Slam Down, Furious Grab, Knockdown) are not maneuver variants and belong to #910's composite-action table instead.

## Corrections to the issue text

The issue's examples are partly off; the spec corrects them so the scope is real:

- **Improved Grab, Improved Knockdown, Improved Push** are *monster abilities*, not player feats. They are already handled by the strike-rider code (`scripts/dungeon-strike-riders.mjs`) and are not part of this issue.
- **Double Slice** is a Fighter/Rogue Strike action, not a maneuver modifier; it is a candidate for #910's composite table, not for this issue.
- **Titan Wrestler** raises the size cap from "one size larger" to **two sizes larger, or three if legendary in Athletics** (not simply "removes" the cap) and also covers Reposition.
- **Agile Maneuvers** is a multiple-attack-penalty change, not an eligibility change (see Decision 5).

## Investigation findings

Confirmed against this repo, the installed PF2e system (`/srv/foundry/data/Data/systems/pf2e/pf2e.mjs`) and the live `pf2e.feats-srd` compendium.

- **Population.** 278 feats in `pf2e.feats-srd` mention one of the maneuver names in their description; 170 of those name a maneuver in their opening text (ancestry, class, skill, archetype). The overwhelming majority are *active* feats/actions or reactions that are out of scope here. The passive, maneuver-modifying core is small.
- **The system gives no slug-level automation for these feats.** No feat slug in the checked set (titan-wrestler, agile-maneuvers, sly-disarm, combat-grab, intimidating-prowess, battle-cry, terrified-retreat, antagonize, crushing-grab, disarming-flair) appears anywhere in `pf2e.mjs`. Whether a feat has any effect on a roll depends entirely on its own `system.rules`.
- **Two kinds of feat, split by rule elements.**
  - *Rule-element-backed* (the system applies them automatically when the maneuver is rolled through the actor's statistic): Intimidating Prowess (`FlatModifier` + `AdjustModifier` on `intimidation`), Disarming Flair (`ItemAlteration`/`RollOption`, adds the `bravado` trait). These need no module code.
  - *Prose-only* (`rules: []`, or only `Note` rule elements that display text): Titan Wrestler, Agile Maneuvers, Sly Disarm, Combat Grab, Crushing Grab, Furious Grab, Terrified Retreat, Antagonize, Battle Cry. The system will never apply these; the module must.
- **The maneuver macros already accept what Sly Disarm needs.** `game.pf2e.actions.disarm({ skill, modifiers, difficultyClass, ... })` takes `skill` (default `athletics`), so Thievery Disarm is a one-argument change, not new roll code.
- **The five macros enforce no prerequisites** (confirmed by #909's spec) — size cap and free-hand rules live only in `buildManeuverVocabulary`, so eligibility changes are made in exactly one place.
- **Reading an actor's feats is simple and reliable:** `actor.items.some((i) => i.type === "feat" && i.slug === slug)`; Athletics rank for the legendary check comes from `actor.skills.athletics.rank` (same existence guard `resolveAthleticsRider` uses).

## Decisions (Proposed)

1. **A curated modifier table, not generic feat interpretation.** One table, `MANEUVER_FEAT_MODIFIERS`, keyed by feat slug. A feat not in the table has no effect on maneuver eligibility or riders. Adding coverage is a deliberate, tested change.
2. **Two modifier kinds.** `eligibility` modifiers run inside `buildManeuverVocabulary` (they can widen, never narrow, what base RAW allows); `rider` modifiers run in the `maneuver` executor callback after the base RAW consequence is applied.
3. **Rule-element-backed feats are never re-implemented.** If the system already applies the feat's effect through rule elements, the module does nothing — double-applying would be a rules bug.
4. **Initial table (confirmed prose-only, high-impact, mechanically small):**

   | Feat | Maneuver | Kind | Effect |
   |---|---|---|---|
   | Titan Wrestler | Trip/Shove/Grapple/Disarm | eligibility | Size cap becomes 2 sizes larger (3 if Athletics rank is legendary) |
   | Sly Disarm | Disarm | eligibility + rider | May use Thievery (`skill: "thievery"`); on a Thievery success the target is Off-Guard against the actor's next attack this turn |
   | Crushing Grab | Grapple | rider | On success, deal Str-modifier bludgeoning damage to the target |
   | Terrified Retreat | Demoralize | rider | On a critical success against a target of lower level, target is Fleeing for 1 round |

5. **Agile Maneuvers and Antagonize are out of the initial table (follow-ups #919 and #920).** Agile Maneuvers changes the multiple-attack-penalty for maneuvers, which depends on how MAP is accounted for in `turnState`/the system roll (needs its own verification, see Open questions). Antagonize (Frightened floor until a hostile act against the actor) needs a persisted condition-floor and a break condition, a larger design than a one-shot rider.
6. **Sly Disarm picks the better statistic deterministically**, using the higher of Athletics and Thievery modifier for that actor; ties prefer Athletics (no Off-Guard rider).
7. **No reasoning-model change.** The model only ever chooses among vocabulary entries; feat modifiers change which entries exist (e.g. a larger target now appears) and what happens on execution, never the model contract.

## Architecture

### 1. Vocabulary builder changes (`scripts/agent-candidates.mjs`)

`buildManeuverVocabulary(combatant, opponents)` gains a small helper `maneuverEligibilityFor(actor, slug)` that returns `{ sizeCapSteps, skill }`:

- Base: `{ sizeCapSteps: 1, skill: baseSkillFor(slug) }`.
- Titan Wrestler present and slug in Trip/Shove/Grapple/Disarm: `sizeCapSteps = 2`, or `3` when `actor.skills.athletics.rank` is legendary (4).
- Sly Disarm present and slug is Disarm: `skill` = whichever of `athletics`/`thievery` the actor modifies better (Decision 6).

The existing size check compares `targetSize - attackerSize <= sizeCapSteps`; everything else in the builder is unchanged. The vocabulary entry carries the chosen `skill` (`{ type: "maneuver", slug, targetId, skill? }`) so execution does not re-derive it.

### 2. Execution changes (`applyAgentDecision`, `case "maneuver"`)

- Pass `skill` through to `game.pf2e.actions[slug]({ ..., skill })` when present.
- After the base RAW outcome callback applies its condition/effect, call `applyManeuverRiders({ actor, target, slug, outcome, skillUsed })`, a pure-ish function over the modifier table that returns the extra effects (damage, condition, off-guard) to apply. Riders are applied via the same helpers `dungeon-strike-riders.mjs` uses (`applyConditionOnSuccess`, damage via the target actor's `applyDamage`), so no new application path is introduced.
- Rider outcomes are whispered to the GM with the base outcome, naming the feat that contributed.

### 3. The modifier table

`MANEUVER_FEAT_MODIFIERS` lives in a new `scripts/maneuver-feat-modifiers.mjs` (pure data + two pure functions: `eligibilityModifiers(featSlugs, athleticsRank)` and `ridersFor(featSlugs, slug, outcome, skillUsed)`), kept out of `agent-candidates.mjs` so the builder stays readable and the table is trivially unit-testable.

## Error handling

- A feat slug present but its modifier throws or the actor data needed (`athletics.rank`) is unreadable → treat as feat absent (base RAW behavior), never as "extra permissive".
- A rider whose application fails (damage/condition error) is logged and reported to the GM; it never undoes the base maneuver outcome.
- Unknown feat slugs are ignored.

## Testing

- `maneuverEligibilityFor`/`eligibilityModifiers`: no feat (cap 1), Titan Wrestler (cap 2), Titan Wrestler + legendary Athletics (cap 3), Sly Disarm with each skill better, unreadable rank.
- `ridersFor`: each table row across all four outcomes (Crushing Grab only on success; Terrified Retreat only on crit success and only when target level < actor level; Sly Disarm only when Thievery was used and succeeded).
- Vocabulary tests: a target two sizes larger is absent without Titan Wrestler and present with it; Sly Disarm sets `skill`.
- Execution tests with a mocked `game.pf2e.actions`: `skill` forwarded; riders applied after the base outcome; rider failure does not break the base outcome.
- Live verification on an AI actor with each feat.

## Explicitly out of scope

- Monster Improved Grab/Knockdown/Push (already handled by strike riders).
- Active feat actions combining Strike + maneuver (Combat Grab, Slam Down, Furious Grab, Knockdown, Double Slice) — #910's composite-action table.
- Rule-element-backed modifiers (Intimidating Prowess, Disarming Flair) — handled by the system.
- Reposition and Escape variants (not among #909's five maneuvers).
- Agile Maneuvers (MAP) and Antagonize (persistent Frightened floor) — deferred, see Open questions.
- Reactions that trigger maneuvers (Shoving Sweep, Topple Foe, Opportunistic Grapple).

## Resolved questions

1. **Initial table:** Titan Wrestler, Sly Disarm, Crushing Grab, Terrified Retreat, as proposed.
2. **Agile Maneuvers:** deferred; the system has no handling for it, so the module must adjust MAP itself. Filed as #919.
3. **Antagonize:** deferred to a follow-up ticket, #920.
4. **Sequencing:** plan now against #909's spec; execution waits for #909's pipeline to be implemented.

## Follow-ups

- #919: Agile Maneuvers (lower MAP on maneuvers).
- #920: Antagonize (persistent Frightened floor after Demoralize).
