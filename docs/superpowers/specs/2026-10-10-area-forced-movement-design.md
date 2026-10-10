# Advanced AI Actors: Area Forced Movement and Mixed Zone-Plus-Save Abilities

**Issue:** #1104 — abilities that move every creature in an aura (Hurricane Blast) and abilities that combine a terrain effect with a single-target save (Solidify Mist), deferred from #988.

**Builds on:** #988 / `docs/superpowers/specs/2026-10-09-ai-npc-remaining-save-abilities-design.md` (the remainder inventory and reviewed-table pattern), #987 / `docs/superpowers/specs/2026-10-09-ai-npc-custom-save-outcomes-design.md` (`forcedMove` outcome, `pushTokenAway`, wall/occupancy-aware movement), #984 / `docs/superpowers/specs/2026-10-09-ai-npc-prose-abilities-design.md` (`createZone`, zones at runtime, `followsSource`, the Terrain behavior), #915 (save executor, area membership), #935 (outcome model), #1102 (sustained effects), #753 (trap footprints).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

Two shapes remain after #987 and #984: abilities that **move every creature in the source's aura** a set distance with a save to avoid it, and abilities that **create terrain in the aura and also force a save on one creature in it**. This spec adds an **aura-affected-set helper**, an **`orbit` forced-move operation** (clockwise / counterclockwise around the source), an **AI direction chooser**, and the **mixed zone-plus-save** pattern with its "until it Escapes or leaves the cloud" ending.

## Investigation findings

Real texts from `tests/fixtures/npc-save-ability-slice.json`.

- **Hurricane Blast** — *Jaathoom* (air, arcane; 1 action; once per round): "moves all creatures without the air trait in their turbulent skies aura 20 feet directly away, clockwise, or counterclockwise. A creature avoids being moved if it succeeds at a Fortitude DC 21 save." *Djinni*: "pushes back 20 feet, or forces all creatures in the aura to move 20 feet clockwise or counterclockwise. Each creature must attempt a Fortitude DC 21 save. On a success, it avoids being moved, and on a critical failure it falls Prone in addition to being moved. Creatures with the air trait are immune." Both `expected: None`.
- **Solidify Mist** — *Mist Stalker* (primal, water; 1 action): "The aura becomes difficult terrain until the start of the mist stalker's next turn. In addition, the mist stalker can make the mist even thicker around a single Medium or smaller creature within the cloud. The creature must succeed at a Reflex DC 20 save or become Immobilized until it Escapes or is no longer in the mist cloud's emanation." `expected: None`. No Escape DC is stated.
- **Rules as written:** the effect moves *all* matching creatures, allies of the source included; the AI must account for that.
- **Machinery that exists:** #987's `pushTokenAway(combat, attacker, target, distanceSquares)` and its wall/occupancy-aware stop-at-last-legal-cell behavior; #984's `createZone` with `followsSource`, difficult terrain with `appliesToModes`/`excludeSource`, and lifetime by game clock; #915's area membership; #753's trap footprints.

## Resolved decisions

1. **Direction choice:** the AI scores the three options (away, clockwise, counterclockwise) by enemy vs. ally displacement and picks the best; it skips the ability when every option scores negative.
2. **Clockwise/counterclockwise** is a new **`orbit` forced-move operation** along the aura ring, wall/occupancy-aware.
3. **Solidify Mist's Immobilized ends** when the creature leaves the mist zone or succeeds at an Escape, using the ability's save DC (20) as the Escape DC since the text gives none.
4. **All four extras are in scope** (no follow-up tickets): trait/size targeting fields, once-per-round frequency, hazard and fall resolution for forced movement, and the critical-failure rider.

## Design

### Aura-affected-set helper

`affectedSetInAura(source, { radiusFeet, excludeTraits, maxSize, includeAllies: true })` returns the tokens within the source's emanation (the same area-membership helper as #915), excluding the source, applying reviewed `targeting` fields (`excludeTraits: ["air"]`, `maxSize: "medium"`). Allies are included; the set is the single input to both shapes.

### Outcome kinds and table entries

- `forcedMove` (from #987) gains `op: "orbit"` with `direction: "clockwise" | "counterclockwise"` and `feet`. A table entry (extending #988's reviewed table) for **Hurricane Blast** defines `choice: ["push", "orbit-cw", "orbit-ccw"]` and, per degree, `{ movement, rider }`: success = none (avoids being moved), failure = move, critical failure = move plus `rider: { condition: "prone" }` for the djinni's wording. The Jaathoom wording (no Prone) is a separate table entry.
- **Solidify Mist** is a table entry with two steps run in one action: `createZone` (emanation, difficult terrain until the source's next turn, `followsSource: true`) and `singleTargetSave` (Reflex 20; target picked by the executor within the zone filtered by `maxSize: "medium"`) whose failure applies `Immobilized` with `endsWhen: ["leavesZone", "escape"]` and `escapeDC: "saveDC"`.
- **Frequency.** `frequency: { per: "round", uses: 1 }` is honored by the existing frequency store (#915), reset at the source's turn start.

### `orbit` operation

`orbitToken(combat, source, target, feet, direction)` computes the target's polar position around the source, rotates it by the arc length corresponding to `feet` at its current radius, discretizes the path to grid cells (the cells along the ring in order), and moves cell by cell using the same wall/occupancy check as `pushTokenAway`; it stops at the last legal cell and returns `{ moved, requested, stoppedBy }`. The radius is clamped to at least 1 cell so an adjacent target orbits the source's own ring; a target that shares the source's cell (which cannot happen on the grid) does not move.

### AI choice

`chooseAreaMove(source, options)` simulates each option for every member of the affected set using the forced-move planner (no tokens move), and scores: `+value` for each *enemy* moved out of melee reach of allies or into a hazard or out of the source's aura; `−value` for each *ally* moved the same way; a small bonus for moving enemies away when the source is a ranged attacker. The best option's score must be positive; otherwise the ability is not offered this turn. The candidate's `summary` names the chosen direction ("Hurricane Blast: orbit clockwise, moves 3 enemies, 1 ally").

### Solidify Mist ending

- A `leavesZone` hook on token movement checks effects flagged `endsWhen: leavesZone`; moving out of the mist emanation (the zone's region) removes Immobilized. The effect also ends when the zone expires.
- The **Escape** candidate is offered to the AI target (cost 1): it rolls Acrobatics or Athletics against the Escape DC (the ability's save DC) through the system; success removes Immobilized. Players use the system's Escape action; #1094/#1096-style detection is not required — the system's own condition removal ends the effect.

### Hazard and fall resolution

After any forced move (orbit or push), the executor inspects the final cell and the path: a trap footprint (#753) triggers via the existing trap trigger path; a hazardous terrain region applies its behavior; a drop-off (a cell the scene marks as a descent, when the scene defines one) applies falling damage per the rules (bludgeoning damage equal to half the distance fallen) and Prone. Where the scene has none of these, the move resolves as plain movement.

### Critical-failure rider

A per-degree `rider` condition is applied through #935's `applyTimedCondition` after the move (Prone for the djinni's critical failure).

## Error handling

- A blocked or zero-distance move reports "moved 0 of 20 feet (wall)" and is not an error; remaining members of the set still move.
- A failure on one token never stops the others; each result is reported.
- A missing zone (region creation failed) leaves the action unspent and reports to the GM.
- Unreadable creature size/traits skip the target with a note rather than guessing.
- Hooks never throw into the combat turn.

## Testing

- **Aura set:** radius membership, exclusion of the source, `excludeTraits` (air), `maxSize`, allies included.
- **`orbitToken`:** clockwise vs counterclockwise cell sequences around a source for known radii, a wall stop, an occupied-cell stop, a zero-radius case.
- **Direction scoring:** a layout where "away" wins, one where orbit wins, one where every option is negative (not offered); allies penalized.
- **Hurricane Blast (mocked saves):** success no move, failure move, critical failure move plus Prone (djinni) / no Prone (jaathoom); frequency once per round and reset at turn start.
- **Solidify Mist:** zone created with `followsSource`, single target filtered by size, failure applies Immobilized, leaving the zone removes it, a successful Escape (AI) removes it, expiry at the source's next turn.
- **Hazards:** a push into a trap footprint triggers it; a hazardous terrain region applies; a drop-off applies fall damage and Prone; plain cells do nothing.
- **Regression:** #987 `pushTokenAway` behavior unchanged; #984 zone tests; #915/#935/#988 audits and ratchet keep passing.
- **Live verification:** a jaathoom/djinni Hurricane Blast moving AI and player tokens around the aura without crossing walls, a mist stalker's cloud immobilizing a creature that then escapes or walks out, a push into a trap triggering it.

## Explicitly out of scope

- Sustained effects (#1102), afflictions (#1103), random spell outcomes (#1105).
- Enforcing difficult terrain on player-controlled movement (as in #984).
- Prose interpretation by the reasoning model.

## Open questions

None blocking. Left to planning: the exact scoring weights, how the scene identifies drop-offs (if at all) for fall resolution, the fall-damage helper to call, and the hook point for the zone-exit check.
