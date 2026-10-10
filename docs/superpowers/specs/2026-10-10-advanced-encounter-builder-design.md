# Advanced Stand-Alone Encounter Builder: Multiple Opposing Forces

**Issue:** #1083 — multiple opposing forces with separate filters and hostility in the stand-alone Generate Encounter flow.

**Builds on:** #831 (difficulty selector, `depthBiasForDifficultyTier`), #93 (always-accepted rosters), the generator interface (`getGenerator().generateEncounterRoster`), `scripts/encounter-generator.mjs`, `scripts/encounter-roster.mjs` (`xpBudget`, `xpFor`), `scripts/foundry-api.mjs` (`spawnCreatures`, creature listing with `minRarity`), `scripts/dungeon-combat.mjs` (`combatantOpponents`, `combatantAllies`, `detectableOpponents`, `combatSideStatus`, `autoResolveIfDecided`), `scripts/combat-rewards.mjs` (`totalCombatXp`), #616 (stealth detection matrix).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

The stand-alone "Generate Encounter" flow builds one opposing force. This spec lets the GM compose an encounter from **several independent forces**: each with its own creature filters, its own **hostility mode** (hostile to players, or hostile to all), and a share of one overall PF2e XP budget. It replaces the module's two-bucket "disposition" notion of sides with a **central hostility relation** that AI targeting, ally logic, combat end and stealth detection all use, and adds **force-level retaliation** for forces that are only hostile to players.

## Investigation findings

Confirmed against the repo.

- **One roster, one disposition.** `generateEncounter` builds a single roster (`foes`, optional `friend`, `twins`, `lurker`) through the swappable generator, then `spawnEncounterTokens` spawns the foes with `disposition: -1` (the friend with `+1`). The stand-alone dialog (`chooseThemeAndSize`) takes a difficulty tier plus theme traits and excluded traits and starts combat immediately via `startCombatForEncounterId`.
- **Sides are dispositions.** `combatantOpponents` is "token disposition differs from mine"; `combatantAllies` is "same disposition"; `combatSideStatus` splits combatants into `hostile` (`disposition === -1`) and `party`; `autoResolveIfDecided` ends the combat when all hostiles or the whole party are down; stealth detection (`detectableOpponents`) and the sneaker logic also read dispositions. Foundry and PF2e only know friendly / neutral / hostile / secret, and PF2e derives a spawned token's disposition from the actor's alliance (`party` / `opposition`), which is why `spawnCreatures` sets the alliance first.
- **The budget is already PF2e's.** `xpBudget(tier, partySize)` implements the GM Core table (Trivial 40 … Extreme 160, adjusted per PC from the 4-PC baseline); `xpFor(levelOffset)` is a creature's XP; `resolveEncounterRoster` caps a roster at that budget; `totalCombatXp` awards XP for defeated hostiles.
- **Filters that exist:** theme traits, excluded traits, and (inside the creature listing) `minRarity`. Level range relative to the party, family and a rarity filter per request are new.
- **Known PF2e consequence:** two forces both spawned as `opposition` look like allies to PF2e's own alliance-based features (for example flanking), even though the module treats them as enemies of each other. This is accepted and documented rather than patched (see "Limitations").

## Resolved decisions

1. **Representation:** a central `areHostile(combat, a, b)` relation over **force ids**. Each token carries a `forceId`; a per-combat force table holds each force's hostility mode and its retaliation edges; the disposition comparisons in the opponent/ally/detection/combat-end logic are replaced by the relation. Tokens keep a native hostile disposition so the Foundry UI and PF2e behave sensibly.
2. **Retaliation is force-level:** once any creature of force B attacks a creature of force A, all of A treats B as hostile for the rest of the encounter. (Other granularities are filed as #1225.)
3. **Budget:** one overall difficulty budget versus the party; the GM sets each force's percentage share (default equal). (Independent per-force tiers are filed as #1226.)
4. **UI:** the existing Generate Encounter dialog is extended in place with a repeatable force section.
5. **Per-force filters:** theme traits and excluded traits (existing), level range relative to party level, creature family and rarity. (Specific named creatures are filed as #1222.)
6. **Combat ends** when no two living combatants are hostile to each other (the generalization of the current "one side left" check).
7. **XP** is awarded for every creature in the encounter's budget that the party overcame, per PF2e, regardless of who landed the killing blows.
8. **Extras in scope:** per-force spawn placement and force labels with token tints. **Filed:** presets (#1223) and GM changing a force's hostility mid-combat (#1224).

## Design

### Force model

```
Force = {
  id,                       // "f1", "f2", ... assigned by the builder
  name,                     // optional label shown on tokens/cards
  hostility: "players" | "all",
  share,                    // percent of the overall budget (sums to 100)
  filters: { traits, excludeTraits, levelOffsetMin, levelOffsetMax, family, rarity },
  placement: { mode: "nearParty" | "area", areaId? },
  tint?                     // token tint
}
```

A one-force encounter (the default dialog state) is identical to today's behavior: one force, hostile to players, 100% share, no filters beyond theme traits.

### Dialog (extends `chooseThemeAndSize`)

The dialog keeps the difficulty selector and the single theme/exclude-trait fields for force 1 and gains an **"Add force"** button. Each added force shows: a label, the trait pickers, level-range offsets, a family field, a rarity select, a hostility dropdown (Hostile to players / Hostile to all), a share field, and a placement select. A read-only line under the list shows the budget (`xpBudget(tier, partySize)`), each force's XP allotment, and a warning if shares don't sum to 100. The dialog returns `{ difficulty, forces: Force[] }`; the dungeon-room path (`skipThemeDialog`) is untouched and keeps a single implicit force.

### Generation (extends `generateEncounter`)

1. Compute the total budget `xpBudget(tier, partySize)` and each force's cap = `floor(total × share / 100)`.
2. For each force, call `getGenerator().generateEncounterRoster({ ..., traits, excludeTraits, levelOffsetMin, levelOffsetMax, family, rarity, xpCapOverride: forceCap })`; the generator interface gains the three new filter params and an optional budget override that replaces the cap `resolveEncounterRoster` derives from the depth bias. A generator that does not understand the new params ignores them and the builder reports the filter was unsupported.
3. A force whose filters leave no creature that fits its cap yields an empty roster; the builder tells the GM which force and why, and the encounter proceeds with the others (if all are empty, generation aborts with a message).
4. Post one chat card per force (or one card with a section per force) listing the roster and XP.

### Spawning and placement

`spawnEncounterTokens` loops over forces. Each spawned token carries `flags.pf2e-dungeon-crawl.forceId`; all tokens still spawn with `disposition: -1` and the `opposition` alliance. A force's placement is `nearParty` (today's behavior) or `area` (a region/area the GM selects; the builder offers the scene's drawings/regions); with several forces on `nearParty`, spawn origins are offset around the party so forces don't stack on one spot. Friend/twin/lurker roster extras belong to force 1 as today.

### Hostility relation (`scripts/force-hostility.mjs`)

```js
areHostile(combat, a, b) → boolean
forceOf(combatant) → forceId | "party" | null
recordAttack(combat, attacker, victim)   // retaliation
```

- Party-side combatants (disposition not hostile) are force `"party"`; tokens without a `forceId` and with a hostile disposition are force `"default"` (so existing single-force combats work unchanged).
- Two combatants in the same force are never hostile. `party` vs a `players` force: hostile. `party` vs an `all` force: hostile. Between two non-party forces: hostile if either has mode `all`, or if a retaliation edge exists between them (`players`-mode forces are otherwise indifferent to each other).
- The force table lives in a combat flag `flags.pf2e-dungeon-crawl.forces` (`{ [forceId]: { hostility, hostileTo: [forceIds] } }`) created when the combat starts from the builder.
- **Retaliation.** A damage-dealt / attack-hit hook calls `recordAttack(attacker, victim)`: if the victim's force differs from the attacker's, and the victim's force is not `party`, add the attacker's force to the victim force's `hostileTo` set (and, symmetrically, make the attacker's force hostile to the victim's force when the attacker's force is `players` mode). Retaliation never makes a force hostile to its own members.

### Call sites replaced

- `combatantOpponents`, `combatantAllies`, `combatantTargets`, `detectableOpponents` use `areHostile` (passing `combat`); callers keep their signatures.
- `combatSideStatus` becomes a connected-hostility check: it returns `hostilesDefeated` when no living combatant is hostile to any other living non-party combatant **and** no living non-party combatant is hostile to a living party member, and `partyDefeated` as today. `autoResolveIfDecided` is otherwise unchanged ("victory" / "defeat").
- Sneaker/observer logic that compares dispositions (`sneakerSides`) uses `areHostile` for the observer set.
- Area-spell ally-awareness (#126) uses the relation, so a force's area spells avoid its own members and catch enemies of any force.
- The AI decision context's "enemies"/"allies" lists are built from the same helpers, so all forces' agents see the right sides.

### XP and loot

`resolveCombat`'s XP total counts the levels of **every non-party combatant that was part of the encounter's budget and is defeated or otherwise overcome at victory**, not only `disposition === -1` creatures killed by the party. The total is awarded once, per `totalCombatXp`. Treasure drops are unchanged (still per defeated hostile).

### Labels and tints

A token's force name is added to its token label (or a nameplate suffix) and a per-force tint (a small palette, assigned by the builder) is applied through the token's `texture.tint` or a ring color; both are removed when the combat ends. The force names also prefix the roster chat cards.

### Limitations

- PF2e's own alliance-based features (flanking, "ally" targeting by the system's rules) treat all `opposition` tokens as allies. The module's AI and targeting use `areHostile`; PF2e's flank indicator may mark an enemy force's creatures as flankers of another force's creature. Not patched here.
- Players' manual targeting is not restricted by hostility.

## Error handling

- A missing or malformed force table falls back to the legacy disposition rule, so old combats and dungeon-room combats are unaffected.
- A filter that matches nothing yields an empty roster with a clear message; a generator that ignores a new filter param is reported.
- A share total ≠ 100 is blocked in the dialog; the generator never receives a negative or NaN cap.
- Retaliation hook failures are logged and never block damage or the turn.
- A token without a force id is treated as `"default"`; a force id missing from the table is treated as hostile to players.

## Testing

- **Budget:** per-force caps from `xpBudget` and shares (including odd partySize and rounding); a single force equals today's cap.
- **Dialog data:** the force list reads and writes; shares validation; one-force default unchanged.
- **Generation (mocked generator):** per-force params passed through, empty-force handling, unsupported-filter report, one chat card per force.
- **Spawning:** `forceId` flag on every token, placement modes (nearParty offsets, area), friend/twin/lurker kept with force 1.
- **`areHostile` (pure):** party vs each mode, same-force, `all` vs `players`, `players` vs `players` (indifferent), retaliation edges added by `recordAttack` and not self-hostile, unknown force ids.
- **Call sites:** opponents/allies/targets/detection under multi-force fixtures; area-spell ally awareness; legacy single-force combat identical to the old disposition output (regression).
- **Combat end:** victory when only mutually non-hostile combatants remain; not ended while an `all` force and a `players` force still hostile; defeat when the party is down.
- **XP:** the awarded total counts all budgeted creatures in a mixed fight regardless of who killed them.
- **Labels/tints:** applied and removed at combat end.
- **Live verification:** the issue's example — undead hostile to all plus goblins hostile to players that retaliate against anyone who attacks them, including the undead — ends with the party and goblins and undead fighting as specified, the combat ending only when no hostile pair is left, XP awarded once.

## Explicitly out of scope

- Presets (#1223), specific named creatures (#1222), mid-combat hostility changes (#1224), per-creature retaliation grudges (#1225), independent per-force budgets (#1226).
- Dungeon-run encounters (the room population path keeps its single force).
- Restricting players' manual targeting; patching PF2e's alliance-based features.
- A "friendly" or neutral force mode.

## Open questions

None blocking. Left to planning: where the attack/damage hook for retaliation hooks in (system damage-taken vs the module's attack executors), the area/region picker for `area` placement, the family field's source in the creature data, and the token-tint mechanism.
