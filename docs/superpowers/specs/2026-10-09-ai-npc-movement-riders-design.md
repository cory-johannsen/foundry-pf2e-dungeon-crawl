# Advanced AI Actors: Movement Abilities With Modeled Riders

**Issue:** #972 — movement abilities with modeled riders (charge bonuses, Pounce hiding, push, MAP rules, post-move effects), deferred from #932.

**Builds on:** #932 / `docs/superpowers/specs/2026-10-08-ai-npc-movement-abilities-design.md` (the movement-plan parser, the `npcMove` vocabulary entry, the generalized stride executor, the rider table that currently holds only "doesn't trigger reactions"), #933 / `docs/superpowers/specs/2026-10-08-ai-npc-strike-plus-abilities-design.md` (MAP rules for multi-Strike abilities, rider executors), #915 / `docs/superpowers/specs/2026-10-08-ai-npc-save-abilities-design.md` with #935 (the save descriptor, outcome grammars and timed-condition helper), and the module's stealth and push code (`scripts/stealth-detection.mjs`, `handleStealthBreakMessage`, `pushTokenAway` in `scripts/dungeon-combat.mjs`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#932 offers a movement ability only when its whole text parses as a movement phrase, an optional Strike clause, a Speed-bonus clause, and a single recognized rider ("doesn't trigger reactions"). Most bestiary movement abilities carry some other trailing effect and so are not offered. This spec extends #932's rider table with five riders, each a small parser plus an executor step:

1. **Charge clauses** — a bonus that applies only if the actor moved far enough (Boar Charge, Rhinoceros Charge, Powerful Charge).
2. **MAP rules** — how a move's Strikes count toward the multiple attack penalty (Flying Fists, Mauling Rush).
3. **Push on hit** — a hit pushes the target (Shield Push, Massive Rush).
4. **Pounce hiding** — "if it began this action hidden, it remains hidden until after the attack."
5. **Post-move save effects** — a save with outcomes triggered by where the move ends (Intimidating Display).

An ability is still offered only when **every** sentence is consumed (all-or-nothing). Path-damage riders (Flaming Strafe, Spine Rake) are #1037; the remaining bespoke effects are #1038.

## Investigation findings

Confirmed against the repo and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **Starting point.** #932's parser accepts a movement sentence, an optional Strike clause and `It has a +N-foot circumstance bonus to its Speed(s)`, plus the single rider `This movement doesn't trigger reactions`. Of about 66 movement abilities whose first sentence matches that grammar, only about 17 have nothing after it.
- **What the other trailing sentences are** (measured over the 59 core-grammar movement abilities that have at least one extra sentence beyond the Speed bonus): about **42 bespoke** ("other"), **12 charge clauses**, **7 path/area damage**, **5 "doesn't trigger reactions"** (already modeled), **3 MAP rules**, **2 Pounce hiding** (more under the Pounce name once the Stride-then-Strike phrasing is covered), **1 push on hit**, **1 grab interaction**.
- **Representative texts.**
  - *Charge, attack bonus* (Boar Charge, Strides twice then a tusk Strike): "As long as it moved at least 20 feet, it gains a +2 circumstance bonus to its attack roll."
  - *Charge, damage increase* (Woolly Rhinoceros Charge): "As long as the woolly rhinoceros moved at least 20 feet, the Strike's damage increases to <formula> damage." (Powerful Charge: "If it moved at least 20 feet away from its starting position, the Strike's damage is increased to 3d10+20.")
  - *MAP rule* (Flying Fists: Flies and makes up to four fist Strikes against different targets at any points during the movement): "The attacks count toward its multiple attack penalty normally, but the penalty does not increase until after <all> the attacks." (Mauling Rush: "These attacks count toward the kokogiak's multiple attack penalty, but it doesn't increase until after …".)
  - *Push on hit* (Shield Push, Stride then a shield-bash Strike): "If the attack hits, the target is pushed 10 feet." (Skeletal Hulk's Massive Rush: automatically pushes the target.)
  - *Pounce* (Strides and makes a Strike at the end of that movement): "If the griffon began this action hidden, it remains hidden until after the attack."
  - *Post-move save* (Giant Frilled Lizard, Intimidating Display): "If it ends that Stride adjacent to at least one other creature, it suddenly displays its colorful neck frills. Each adjacent creature must succeed at a save or become Frightened 2 (or Frightened 3 on a critical failure). The creature is then temporarily immune to Intimidating Display for 1 minute."
- **Code that already exists for these.** `pushTokenAway(combat, attacker, target, distanceSquares)` (`dungeon-combat.mjs` ~3473) pushes a token along a line, used by the Improved Push rider. The stealth system keeps a per-combat detection matrix (`flags.pf2e-dungeon-crawl.detection`, states `unnoticed`/`undetected`/`hidden`/`observed`) and `handleStealthBreakMessage` reveals a sneaker after an attack message via `afterAttack(matrix, sneakerId)`, then refreshes the display condition. The save descriptor, degree-outcome parser, timed-condition helper and immunity timestamps come from #915/#935; the variant-index/MAP mechanics for multi-Strike come from #933.
- **The Strike inside a move** is rolled by `rollAndApplyStrikeAtVariant(combat, combatant, target, actionSlug, variantIndex)` with explicit roll modifiers (as #940/#933 do) and applies damage afterwards; there is no existing way to substitute the *base damage formula* of a Strike, which the damage-increase charge clause needs.
- **Distances.** The generalized stride executor knows the actual path it walked; "moved at least N feet" can be read from that path's length and "away from its starting position" from the straight-line distance between the start and end cells, using the grid distance (default 5 ft per cell).

## Resolved decisions

1. **First slice riders:** charge clauses, MAP rules and push on hit, plus **Pounce hiding** and **post-move save effects**.
2. **Path-damage riders (a save and damage along the path) are #1037**, and the remaining bespoke effects are #1038.
3. **All-or-nothing remains the rule:** an ability with any trailing sentence outside the rider table is not offered.

## Design

### Rider table (extends #932's parser, `scripts/npc-move-parse.mjs`)

#932's plan descriptor gains a `riders` list. After the movement sentence, optional Strike clause and Speed-bonus sentence, each remaining sentence must match exactly one rider pattern, and a multi-sentence rider (the post-move save) consumes its whole group:

| Rider | Recognized sentences | Parameters |
|---|---|---|
| `noReactions` (existing) | "This movement doesn't trigger reactions." | — |
| `charge` | "As long as <it|name> moved at least N feet, [it gains a +B circumstance bonus to its attack roll | the Strike's damage increases to <formula>]." and "If it moved at least N feet away from its starting position, the Strike's damage is increased to <formula>." | `minFeet`, `measure: "pathLength" \| "straightLine"`, `attackBonus?`, `damageOverride?: { formula, type }` |
| `mapRule` | "The attacks count toward its multiple attack penalty normally, but the penalty does not increase until after <the|all> attacks." / "These attacks count toward <owner>'s multiple attack penalty, but it doesn't increase until after …" | `rule: "deferredIncrease"` |
| `pushOnHit` | "If the attack hits, the target is pushed N feet." / "… automatically pushes the target N feet." | `feet`, `automatic: boolean` |
| `pounceHidden` | "If <it|name> began this action hidden (or undetected), it remains hidden until after the attack." | — |
| `postMoveSave` | "If it ends that <Stride|move> adjacent to at least one other creature, <flavor>. Each adjacent creature must succeed at a <save> save [DC] or <outcomes> … temporarily immune … for <duration>." | `condition: "endsAdjacent"`, plus a #915 save descriptor (`save`, `dc`, degree outcomes, immunity) |

A trailing sentence matching none of these makes the whole ability `null` (not offered). The Strike clause may name more than one Strike ("up to four fist Strikes against different targets"): `strike.count` (from #932) can exceed 1, each Strike taking a distinct target at a cell in reach along the path.

### Execution (extends #932's `case "npcMove"`)

After the generalized stride resolves (or at the right point inside it), the executor applies each rider in order:

- **Charge:** compute the distance moved: `pathLength` = number of cells walked × grid distance, `straightLine` = start-to-end distance. If it meets `minFeet`, the Strike gets `attackBonus` as an explicit circumstance roll modifier, and/or a **damage override**: roll `damageOverride.formula` in place of the weapon's base damage (with the weapon's critical doubling and the same damage-type handling) and apply it through `applyDamage`. (Substituting a Strike's base damage has no existing precedent in the module; planning confirms the cleanest mechanism — a `damageOverride` rolled in `rollAndApplyStrikeAtVariant`, or a PF2e damage-alteration on the roll — before coding. If neither is reliable, charge clauses with a damage override are not offered, while attack-bonus charges are.)
- **MAP rule (`deferredIncrease`):** all of the move's Strikes are rolled at the same variant index (the turn's current `mapIncrement`), and `mapIncrement` advances by the number of Strikes only after the last one (the #933 pattern). Without the rider, successive Strikes in a move escalate the penalty as ordinary Strikes do.
- **Push on hit:** after a hit (or automatically when `automatic`), call `pushTokenAway(combat, actor, target, feet / gridDistance)`; a push that would end in an occupied or blocked cell stops at the last legal cell (the helper's existing behavior), reported to the GM.
- **Pounce hiding:** read the actor's detection state at the start of the action (via the combat's detection matrix, `hidden` or `undetected`/`unnoticed`). If hidden, set a one-shot flag on the combat (`flags.pf2e-dungeon-crawl.stealthBreakDeferred = { combatantId }`) that makes `handleStealthBreakMessage` skip the break for the *next* attack message from that actor, roll the Strike (the target is off-guard to a hidden attacker, which the display condition already reflects), then clear the flag and run the normal `afterAttack` reveal immediately after the Strike resolves. If the actor was not hidden at the start, the rider does nothing.
- **Post-move save:** after the move, evaluate `condition` (here: at least one creature adjacent to the final position). If it holds, roll the save for each adjacent eligible creature (excluding those inside an active immunity window) through #915's save executor, apply the degree outcomes (conditions with durations, penalties) with #915/#935's helpers and write the immunity timestamp (`abilityImmunity[itemId][targetId] = worldTime + immuneSeconds`) on the game clock. The save descriptor is parsed by #915/#935's existing grammars; a post-move sentence group those grammars do not fully consume makes the ability `null`.

### Reporting

Each applied rider adds a clause to the movement ability's result descriptor (#925): "charged 30 ft (+2 to hit)", "pushed Fighter 10 ft", "stayed hidden for the attack", "Frightened 2: Goblin, Fighter saved". Skipped riders (charge not met, no adjacent creature) report that they did not apply.

### Vocabulary

#932's `npcMove` entries are unchanged in shape. The `summary` string gains the rider hints so the model can weigh them ("Boar Charge: Stride twice then tusk Strike, +2 to hit if it moves 20+ ft"). Eligibility is as in #932 plus rider-specific checks: a charge rider is only advertised when a path of at least `minFeet` to the chosen target exists within the budget; a post-move save rider is only advertised when the plan's destination is adjacent to a creature; Pounce hiding is advertised only when the actor is currently hidden.

## Error handling

- Parsing never throws; an unmatched trailing sentence is `null` (not offered).
- A rider step that fails (a push blocked, a save roll error, a damage override failure) is logged and reported to the GM; the movement and the Strike that already happened stand.
- The Pounce flag is always cleared after the Strike, including on error, so a stale flag can never suppress a later stealth break.
- A missing detection matrix or combatant detection state means "not hidden"; the rider is skipped.
- The post-move save ignores creatures with unreadable save statistics (skipped with a GM note).

## Testing

- **Rider parsers (pure), real-text fixtures:** each charge phrasing (attack bonus; damage increase; "away from starting position"), both MAP wordings, push on hit and automatic push, Pounce hiding, the Intimidating Display multi-sentence group; texts that must return `null` (path damage, difficult terrain, grab interactions, a charge clause with a formula the parser cannot read).
- **Coverage audit with ratchet (#935's pattern):** a golden file of every movement ability instance with `{ creature, ability, offered | notOffered, riders[], reason }` and a monotonic count, so rider additions and compendium changes show in diffs; the audit also reports unparsed trailing sentences for #1037/#1038 triage.
- **Executors (mocked Foundry):** charge distance computed from the walked path and from the straight line, bonus/override applied only when the gate is met, MAP index and `mapIncrement` movement for the deferred-increase rule, push distance in cells and a blocked push, Pounce flag set/cleared and the stealth break suppressed exactly once with the reveal run after, the post-move save gated on adjacency, immunity windows and outcome application.
- **Vocabulary builder:** rider-specific advertisement conditions (reachable charge distance, adjacency at destination, hidden actor).
- **Regression:** #932's parser and executor tests, the stealth-break and push tests, and #933/#915 tests keep passing; abilities that were offered before remain offered with identical behavior.
- **Live verification:** a boar (Charge with and without the 20-foot gate), a griffon or sphinx (Pounce from hiding), a shield-bearer (Shield Push), a lizard with Intimidating Display, and a flying monster with Flying Fists.

## Explicitly out of scope

- Path-damage riders (a save and damage along the path) — #1037.
- Remaining bespoke effects (difficult terrain along the move, grab interactions, per-Stride Strike limits, transformations) — #1038.
- Terrain/elevation-aware movement (#973) and the base movement abilities themselves (#932).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the mechanism for substituting a Strike's base damage for the damage-increase charge clauses (and the fallback of not offering those abilities), how "began this action hidden" is read from the detection matrix at the exact start of the action, and the final sentence grammars finalized against the fixture.
