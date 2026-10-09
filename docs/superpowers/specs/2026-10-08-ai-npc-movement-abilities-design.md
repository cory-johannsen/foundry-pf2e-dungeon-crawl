# Advanced AI Actors: NPC Movement Abilities

**Issue:** #932 — NPC movement abilities (Swift Leap, Pounce-style moves, and similar).

**Builds on:** the existing movement code in `scripts/dungeon-combat.mjs` (`strideByPosture`, `posturePath`, `walkPath`, the stride candidates in `scripts/agent-candidates.mjs`), #909's `/v1/combat-candidates` pipeline and vocabulary/validation shape, #915's parser conventions (pure, all-or-nothing, data-driven coverage audit), #925's result-descriptor convention for the action card, and #931's reaction machinery (movement events).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-08 (see "Resolved decisions").

## Summary

An AI-controlled monster can only move with the generic `stride` candidate: a posture (approach, retreat, reposition) for one action at its **land** Speed. Abilities that are movement with a twist — Gallop and Speed Surge (Stride twice, with a Speed bonus), Swift Leap (jump up to half Speed without triggering reactions), Fly/Swim/Burrow moves (Breach, Eagle Dive), move-plus-Strike compounds (Swoop, Pounce, Charge), and teleports (Phase Jump) — are never offered.

This spec adds those as a new `npcMove` vocabulary entry. A pure parser turns an ability's description into a **movement plan** using a small closed grammar plus a short table of recognized rider phrases; anything outside the grammar is not offered (all-or-nothing, as in #915). The #909 reasoning endpoint picks among the offered entries, and execution generalizes the existing stride executor to take a mode, a distance budget and an optional Strike, rather than adding a second movement system.

## Investigation findings

Confirmed against the repo and the local PF2e source data (Monster Core 1–2, Bestiary 1–3: 1,433 NPCs).

- **What the module can do today.** The stride candidates are `stride:approach:<id>`, `stride:retreat:<id>` and `stride:reposition`, all cost 1, built by `buildMovementCandidates`. `strideByPosture(combat, combatant, posture, target)` reads only the **land** Speed (`actor.system.movement.speeds.land.value`), snaps the token to the grid, computes a 2-D `posturePath` with wall edges (`movementBlockedEdges`) and other creatures' footprints, truncates it with `walkPath` to the Speed budget, and moves the token (movement in this module is `teleport: true`-style updates, #141). There is no elevation, no alternate movement mode, no "Stride twice", no Speed bonus, no Strike inside the move, and no reaction suppression.
- **Population.** About 268 active NPC actions look movement-related. Excluding Change Shape (68, a polymorph, not movement), roughly 320 distinct ability instances remain and fall into: Stride variants and "move" trait abilities, Fly/Swim/Burrow/Climb-based moves (39), move-plus-Strike compounds (Swoop, Flying Strafe, Impaling Charge, Leap Attack, Powerful Charge, Pounce), jumps/leaps, and teleports (18). Most common names: Gallop 6, Impaling Charge 6, Treasure Dive 6, Phase Jump 6, Inexorable March 5, Speed Surge 5, Illusory Retreat 5, Breach 4, Swift Leap 4.
- **The text is prose with a regular core.** Core phrases repeat: "<creature> Strides / Flies / Swims / Burrows / jumps / Leaps (up to) (half / double / twice) (its) (<mode>) Speed", "Strides twice", "Strides or Flies twice", "<…> and makes a <limb> Strike at the end of that movement / at any point during its movement", and "It has a +N-foot circumstance bonus to its Speeds". A strict first-sentence grammar matches about 66 of the movement abilities; **only about 17 of those have nothing but the core** (Gallop, Speed Surge, Sprint, Fast Swoop, ...). The rest carry a trailing rider sentence: "This movement doesn't trigger reactions" (Swift Leap), charge clauses ("as long as it moved at least 20 feet, +2 circumstance bonus to its attack roll" / "the Strike's damage increases"), Pounce's "remains hidden until after the attack", push-on-hit, area damage along the path (Flaming Strafe, Spine Rake), multiple-attack-penalty rules (Flying Fists).
- **Alternate speeds exist as data.** NPCs expose `system.movement.speeds.{land,fly,swim,burrow,climb}.value`; an ability using a mode the actor has no Speed for is simply not available.
- **Strike inside a move has a ready primitive.** `rollAndApplyStrikeAtVariant(combat, combatant, target, actionSlug, variantIndex)` rolls and applies a Strike (variant index = MAP step), and `matchMultiStrikeActionSlug` resolves a named limb ("tail", "wing", "jaws") to a ready strike action.
- **Teleport precedent.** The module already moves tokens with `{ teleport: true }` (#141) and finds free squares with the occupancy helpers (`freeSpot`, #606).
- **Reactions interplay.** #931 emits movement events (`moveInReach`, `leaveReach`) for every mover; Swift Leap-style "doesn't trigger reactions" needs a way to suppress them for one movement.

## Resolved decisions

1. **All four categories are in the first slice:** land Stride variants, alternate-mode moves, move-plus-Strike compounds and teleports.
2. **Recognition: a closed grammar plus `@UUID` action links** (links to the Stride / Fly / Leap / Swim / Burrow / Climb actions are normalized to their verbs before parsing), as a pure, tested parser. Anything outside the grammar is not offered.
3. **Alternate modes use the same 2-D pathing with the mode's Speed.** Elevation is not modeled; the GM report notes it. Mode-specific terrain rules are #973.
4. **Abilities with unmodeled trailing effects are not offered** (all-or-nothing); widening rider coverage is #972.

## Design

### The movement plan and parser (`scripts/npc-move-parse.mjs`, pure)

`parseMovementAbility(item)` returns `null` or a descriptor:

```js
{
  cost,                       // actions.value (0 for free)
  frequency,                  // system.frequency, as-is
  rechargeFormula,            // reused from the breath-weapon recharge regex, or null
  plan: {
    kind: "move" | "teleport",
    segments: [{ mode: "land"|"fly"|"swim"|"burrow"|"climb", speedFactor: 0.5|1|2 }],
    bonusFeet: 0,              // "+N-foot circumstance bonus to its Speed"
    teleportFeet: null,        // for kind "teleport"
    strike: null | { limb: "tail", count: 1, timing: "end" | "any" },
    suppressReactions: false,
    chargeNote: null           // reserved; unmodeled charge clauses make the ability not offered
  },
  mode: "auto"
}
```

Normalization before matching: strip HTML, resolve `@UUID[...Stride|Fly|Leap|Swim|Burrow|Climb|Step]{Text}` to their text, drop a leading `Frequency …`/`Requirements …` block (recording `frequency`/`requirements`), and split into sentences.

Grammar (all sentences must match, or the result is `null`):

1. **Movement sentence:** `<creature> (Strides|Flies|Swims|Burrows|Climbs|Leaps|jumps|Strides or Flies)( up to)?( half| double| twice)?( its| their)?( <mode>)? Speed( plus N feet)?( twice)?`; `Strides twice` and `uses 2 move actions … Stride or Fly` map to two segments; "Strides or Flies" lets the actor use whichever Speed is better for the chosen target.
2. **Optional Strike clause** on the same sentence: `(and|then) (makes|attempts) a <limb> Strike( at the end of that movement| at any point during (its|that) movement)?` → `strike`.
3. **Optional Speed-bonus sentence:** `It has a +N-foot circumstance bonus to its Speed(s)( during these Strides)?` → `bonusFeet`.
4. **Rider table (initial):** `This movement doesn't trigger reactions` → `suppressReactions: true`. Any other trailing sentence not in the table makes the ability unrecognized.
5. **Teleport sentence:** `teleports( itself)?( and any items…)? up to N feet( to a space …)?` → `kind: "teleport"`, `teleportFeet`.

`mode` is always `"auto"` for a recognized ability (there is no report-only tier here: a movement that cannot be modeled completely is not offered).

### Vocabulary (`buildNpcMoveVocabulary`, `scripts/agent-candidates.mjs`)

Called from `getPendingAgentTurn` for AI-controlled NPCs next to the other vocabulary builders. For each parsed ability:

- Skip if cost > actions remaining, `frequency.value` is 0, or the recharge store says unavailable.
- Resolve each segment's Speed: `movement.speeds[mode].value` (a "Strides or Flies" segment picks the larger available); no Speed for a required mode → skip. Budget per segment = `floor((speed × speedFactor + bonusFeet) / gridDistanceFt)` squares; abilities with several segments sum or chain per plan.
- **Move (no Strike):** entries `approach:<opponentId>` and `retreat:<opponentId>` mirroring the generic stride postures (same eligibility), but with the ability's budget and mode.
- **Move + Strike:** one entry per opponent reachable under the budget: a path exists to a cell within reach of the target (end timing: the destination; any timing: the earliest cell in reach), and the named limb resolves to a ready Strike.
- **Teleport:** one entry per candidate destination class: "next to <opponent>" (nearest free cell within `teleportFeet` and line of sight, chosen deterministically) or "away from <opponent>"; skipped when no free cell qualifies.
- Entry: `{ type: "npcMove", itemId, slug, name, kind, posture, targetId?, destCell?, cost, summary }`, with `summary` deterministic ("Gallop: Stride twice (+10 ft) toward Goblin", "Phase Jump: teleport up to 30 ft next to Fighter").
- The shared per-turn cap on non-strike vocabulary entries applies (proposed: 8).

### Reasoning call and validation

As in #909/#915: the vocabulary gains `type: "npcMove"` with `itemId`/`targetId`/`posture` as free strings; picks are validated by literal membership on `(type, itemId, posture, targetId)`; survivors become candidates `{ id: "npcMove:<itemId>:<posture>:<targetId>", ... }` appended before the existing `/v1/combat-decision` call.

### Execution (`applyAgentDecision`, new `case "npcMove"`)

1. Spend the cost through `turnState`; decrement `system.frequency.value` and record recharge as other abilities do; post the usage message (`item.toMessage()`).
2. **Move kind:** call a generalized `strideByPosture(combat, combatant, posture, target, { speedFt, segments, mode, suppressReactions, strike })`. The added options change only: the Speed budget (mode Speed × factor + bonus, per segment), an optional Strike, and a `suppressReactions` flag passed to #931's movement events so no reaction fires for this movement. Everything else (grid snap, wall edges, occupancy, `walkPath`, free-spot fallback) is unchanged.
3. **Strike clause:** for `timing: "end"`, after the final move, if the target is within reach, call `rollAndApplyStrikeAtVariant(combat, combatant, target, limbSlug, mapIncrement)` and increment `mapIncrement`; for `timing: "any"`, split the move at the earliest cell in reach, Strike there, then spend any remaining budget continuing along the same posture path. The Strike resolves like any Strike (including strike riders).
4. **Teleport kind:** move the token to the chosen destination with `{ teleport: true }` through the existing free-spot helper; no path, no reactions (a teleport is not a move that provokes).
5. Report through #925's result descriptor (`{ text, tone }`), including a GM-only note for alternate modes ("Fly Speed, 2-D pathing, elevation not modeled") and for blocked or partial moves (`"blocked"`, `"no-route"`, as for strides).

### Reactions

`suppressReactions` is carried on the movement event to #931's `resolveReactions` entry point, which skips reaction collection when it is set. Movement abilities without the rider behave like a normal move and can provoke reactions (the `move` trait).

## Error handling

- A parse failure is `null` (not offered); parsing never throws into the turn.
- No path, no free destination, or no ready limb Strike when executing → the action is reported as blocked/no-route and not spent beyond what #925's card reports; a half-executed compound (moved but the Strike target vanished) reports the partial result.
- A missing mode Speed at execution time (state changed) aborts before moving.
- Failure of the generalized stride falls back to leaving the token where it is and reporting to the GM.

## Testing

- **Parser (pure), fixtures from real data:** Gallop (Stride twice + bonus), Speed Surge (Strides or Flies twice, frequency), Swift Leap (half Speed + reactions rider), Swoop/Fast Swoop (Fly + Strike any point), Pounce-like (Stride + Strike at end, with an unmodeled "remains hidden" sentence → `null`), Breach/Eagle Dive (swim/fly modes), a teleport, a charge with an unmodeled clause (`null`), Change Shape (`null`), prose outside the grammar (`null`).
- **Coverage audit:** a snapshot test over the movement-ability fixture asserting counts of recognized vs. not offered, so grammar or compendium changes are visible and #972's progress is measurable (initial recognized set is expected to be small relative to the ~320 instances).
- **Vocabulary builder:** mode Speed present/absent, budget arithmetic (factor + bonus + segments), cost vs actions, frequency 0, recharge, postures, strike clause eligibility, teleport destination selection, cap.
- **Executor (mocked Foundry):** the generalized stride receives the right budget/mode/flags; Strike at end vs any point; `mapIncrement` bump; reactions suppressed only for the rider; teleport uses `{ teleport: true }`; frequency/recharge recorded; blocked paths reported.
- **Regression:** the existing `strideByPosture` tests pass unchanged for the plain-stride call shape.
- **Live verification:** a monster with Gallop and one with Swift Leap in a real fight; a flying monster using a Fly move + Strike; a teleporting monster.

## Explicitly out of scope

- Movement abilities with unmodeled riders (charge bonuses, Pounce's hiding, pushes, area damage along the path, multi-target strikes with MAP rules) — #972.
- Terrain- and elevation-aware Fly/Swim/Burrow/Climb rules — #973.
- Change Shape and other polymorph/transform abilities (not movement).
- Reactions triggered by movement beyond what #931 provides.
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-08. Implementation details left to planning: the exact sentence grammar (finalized against the fixture), how "Strides or Flies" chooses between Speeds, how `suppressReactions` is threaded to #931's event, and the per-turn entry cap.
