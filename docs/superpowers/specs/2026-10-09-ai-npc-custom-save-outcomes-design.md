# Advanced AI Actors: Custom Save-Ability Outcomes

**Issue:** #987 — custom save-ability outcomes (waste an action, curses, next-roll penalties, bespoke effects), deferred from #935.

**Builds on:** #935 / `docs/superpowers/specs/2026-10-08-ai-npc-save-outcome-coverage-design.md` (the per-degree outcome model, the block and inline grammars, the override table, `applyTimedCondition`/`applyTimedPenalty`, the golden-file coverage ratchet), #915 / `docs/superpowers/specs/2026-10-08-ai-npc-save-abilities-design.md` (the save executor, immunity windows), #914 / #934 (effect creation, agent tagging and combat-end cleanup), #978 (the `lastAction` turn-state record), and the module's turn machinery in `scripts/dungeon-combat.mjs` (`initAgentTurnState`, `pushTokenAway`, the combat turn hooks).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions"). This replaces an earlier unattended draft of this spec that was written without the owner's choices.

## Summary

#935 widens the automatic outcomes of save-based NPC abilities to conditions, penalties and immunity. About 139 abilities in the bestiary data still have at least one save outcome that none of those can express. This spec adds **seven new outcome kinds**, each implemented as a **PF2e effect item with rule elements wherever the system can express it**, and as a **module hook only for what rule elements cannot do**:

1. **Action loss / restriction** — "waste 1 action on its next turn dancing" (Do a Jig!), "the only action it can take is a Fortitude save" (Drown).
2. **Next-roll / single-use modifiers** — "–1 status penalty to the next saving throw within the next minute against a divine effect" (Mask of Fate).
3. **Curses that change damage rules** — "any damage the cursed creature would deal becomes fire damage" for 1 round, 1 hour or 1 day (All Becomes Flame).
4. **Forced movement** — push, pull or move a creature N feet.
5. **Suffocation and breath-holding** — hold breath, lose air, suffocate, with the Fortitude-save escape (Drown, Smother, Hydraulic Asphyxiation).
6. **Resistance / weakness / immunity edits** for a duration.
7. **Mind and memory effects** — losing a memory with its conditions (Extract Memory).

Plus **a reusable grammar**: the new outcomes are recognized by extending #935's outcome grammar with a handful of closed sentence patterns, so repeated wording across creatures parses automatically instead of needing per-ability entries; #935's reviewed override table remains the escape hatch. Outcomes are enforced **automatically on AI-controlled targets**; for human-driven characters the module posts a clear **reminder** at the start of their turn.

## Investigation findings

Confirmed against the repo, the installed PF2e system (v8.5.0) and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **The gap.** Of the ~369 save-based, no-damage active NPC abilities, #935's grammars handle plain conditions, penalties, "as failure" and immunity. A scan of the remainder finds about **139 abilities** with at least one outcome that is not a plain condition; the identifiable mechanics are action loss (Do a Jig!, Drown), next-roll modifiers (Mask of Fate), damage-rule curses (All Becomes Flame, Curse of Darkness), forced movement (Inexorable March-style pushes), suffocation and breath-holding (Drown, Smother, Hydraulic Asphyxiation), resistance/weakness edits (Focus Gaze-style), and memory/mind effects (Extract Memory, Focus Beauty).
- **Representative texts** (from the data).
  - *Do a Jig!* (Gnome Bard): Will DC 19; "Failure: the target must waste 1 action on its next turn dancing. Critical Failure: waste 2 actions."
  - *Drown* (Sarglagon, 2 actions): Fortitude DC 26; "Success: Sickened 1. Failure: the target is holding its breath. The only action it can take is to attempt a Fortitude save against Drown to expel the water, which is a single action. Critical Failure: falls Unconscious and begins suffocating. If the target succeeds at its Fortitude save while suffocating, it coughs up the water and can breathe again."
  - *Mask of Fate* (Divine Warden of Pharasma): "–1 status penalty to the next saving throw it attempts within the next minute against a divine effect."
  - *All Becomes Flame* (Cinder Dragon): Will DC 39, immune for a day regardless; "Success: cursed for 1 round — any damage the cursed creature would deal by any means becomes fire damage. The cursed creature can temporarily suppress the curse for 1 round as an action. Failure: as success, but 1 hour. Critical Failure: 1 day."
  - *Smother* (Omox): Fortitude DC 32 vs a grabbed or restrained creature; Blinded and must hold its breath or begin suffocating for as long as it stays grabbed/restrained. *Hydraulic Asphyxiation* (Merfolk Wavecaller): Fortitude DC 18; Immobilized for 1 round and lose `1d4` rounds of air (twice on a critical failure).
  - *Extract Memory* (Nymolus): Will DC 27; "Success: the creature loses the target memory. Failure: loses it and is Confused for 1 minute."
- **PF2e rules for the mechanics.** *Drowning and Suffocating* (Player Core): "You can hold your breath for a number of rounds equal to 5 + your Constitution modifier. Reduce your remaining air by 1 round at the end of each of your turns, or by 2 if you attacked or cast any spells that turn. … When you run out of air, you fall Unconscious and start suffocating … attempt a DC 20 Fortitude save at the end of each of your turns. On a failure, you take 1d10 untyped damage, and on a critical failure, you die. On each check after the first, the DC increases by 5 and the damage by 1d10." The compendium already ships `Effect: Remaining Air` (`pf2e.other-effects`) for tracking remaining air.
- **The system supports most of these natively.** `FlatModifier` rule elements accept `removeAfterRoll` (true or "if-enabled"), which consumes a modifier on the first roll it applies to — exactly Mask of Fate. A `DamageAlteration` rule element (`property: "damage-type"`, `mode: "override"`) changes damage types — exactly the curse. `Resistance`, `Weakness` and `Immunity` rule elements express resistance edits. Conditions (Confused, Immobilized, Unconscious, Blinded, Sickened) are already handled by #935's helper.
- **What rule elements cannot do:** waste or restrict a creature's actions (the system has Slowed/Stunned, which differ from "waste 1 action dancing"), move a token, run end-of-turn suffocation saves, or remove a memory. Those need module hooks.
- **Module hooks that exist:** the combat turn hooks (`combatTurnChange`, `pf2e.startTurn`, `pf2e.endTurn`), `initAgentTurnState` (`actionsRemaining`), `pushTokenAway(combat, attacker, target, distanceSquares)`, and #978's `lastAction` record. AI-controlled targets are known by `flags.pf2e-dungeon-crawl.agentControlled`.
- **Human-driven turns are outside the module's control.** The module cannot decide how a player spends actions, which is why enforcement on humans is limited to a reminder (real enforcement is #1094).

## Resolved decisions

1. **All seven outcome families are in the first slice**, plus the reusable grammar: action loss/restriction, next-roll modifiers, damage-rule curses, forced movement, suffocation and breath-holding, resistance/weakness edits, and mind/memory effects.
2. **System-native effects first, module hooks only when needed.** Outcomes are built as effect items with rule elements wherever they can be; module hooks cover action loss, forced movement, suffocation saves and memory loss.
3. **AI-controlled targets are enforced automatically; human-driven characters get a clear reminder** at the start of their turn.
4. **Rejected alternatives (no ticket, because they are implementation alternatives rather than features):** "module hooks for everything" (ignores what the system already automates) and "AI targets only" (strictly weaker than the chosen reminder).
5. **Unselected and deferred features are filed:** real enforcement on human turns (#1094), the rest of the drowning rules (#1095), curse suppression and remove-curse integration (#1096), and abilities that reference creature-specific aura entries (#1097).

## Design

### Outcome model (extends #935's `degrees[degree]`)

Each degree keeps `{ none, asFailure, conditions[], penalties[], durationSeconds, immuneSeconds }` and gains **`effects: OutcomeEffect[]`**, a closed discriminated list:

| `kind` | Parameters | Realized as |
|---|---|---|
| `wasteActions` | `n`, `window: "nextTurn"` | effect item (marker) + turn-start hook |
| `restrictActions` | `onlyActions: [{ type: "save", save, dc? }]`, `endsOn: "saveSuccess"` | effect item (marker) + candidate filter + turn-start hook |
| `nextRollModifier` | `selector`, `type`, `value`, `windowSeconds`, `predicate?` (effect traits or origin) | native `FlatModifier` with `removeAfterRoll: true` and a `system.duration` |
| `damageTypeCurse` | `to`, `durationSeconds`, `suppressible: boolean` | native `DamageAlteration` (override) effect |
| `forcedMove` | `op: "push" \| "pull" \| "move"`, `feet`, `directionFrom: "source"` | module executor (`pushTokenAway` and a new `pullTokenToward`) |
| `breath` | `holdBreath: boolean`, `airLossRounds: roll \| N`, `suffocating: boolean`, `escape: { save, dc }`, `whileGrabbed: boolean` | native `Effect: Remaining Air` plus module end-of-turn hook |
| `traitEdit` | `resistances[]`, `weaknesses[]`, `immunities[]` each `{ type, value, exceptions? }`, `durationSeconds` | native `Resistance`/`Weakness`/`Immunity` rule elements in a synthesized effect |
| `memoryLoss` | `scope: "targetMemory"`, `durationSeconds?` | effect item with a descriptive name and no rules, plus a GM-only note |

`mode` stays `"auto"` only when every degree parses completely (the #935 all-or-nothing rule), otherwise `"reportOnly"`.

### Grammar extensions (closed patterns, added to #935's block and inline grammars)

- `waste N action(s) on its next turn [dancing]` → `wasteActions`.
- `The only action it can take is to attempt a <save> save [against <ability>] to <expel/escape …>` → `restrictActions`.
- `takes a –N <type> penalty to the next <saving throw|attack roll|check> it attempts within the next <duration> [against a <trait> effect …]` → `nextRollModifier`.
- `While cursed, any damage the creature would deal [by any means] becomes <type> damage` with `cursed for <duration>` → `damageTypeCurse`; `can temporarily suppress the curse for 1 round as an action` → `suppressible: true` (the suppression action itself is #1096).
- `is pushed|pulled N feet [away from|toward <source>]` → `forcedMove`.
- `is holding its breath`, `must hold its breath or begin suffocating`, `lose <roll> rounds' worth of air (or twice that on a critical failure)`, `begins suffocating`, `can breathe again` on a Fortitude success → `breath`.
- `gains resistance N to <type>`, `has weakness N to <type>`, `becomes immune to <type>` for a duration → `traitEdit`.
- `loses the target memory` → `memoryLoss`.

Anything not consumed keeps the ability `reportOnly`. The reviewed override table (#935) covers abilities the grammar misses; the golden-file audit gains one counter per new kind so progress is visible.

### Executors (extend #935's outcome application)

`applyOutcomeEffects(target, effects, origin)`:

- **Rule-element kinds** (`nextRollModifier`, `damageTypeCurse`, `traitEdit`, and the marker part of the others) create **one effect item** per ability use on the target through #935's `applyTimedEffect` helper, with the ability as origin, the parsed duration, and the agent tag so unlimited effects are removed at combat end.
- **`forcedMove`:** `push` calls `pushTokenAway` (distance in squares); `pull` and `move` call a small `pullTokenToward`/`moveTokenBy` built on the same wall/occupancy-aware pathing (a blocked move stops at the last legal cell and reports why).
- **`breath`:** apply or update `Effect: Remaining Air` on the target (creating it with `5 + Con mod` rounds if the creature is not yet holding its breath, then subtracting `airLossRounds`), apply `Unconscious` when air reaches 0 and mark the creature suffocating; `whileGrabbed` ties the effect's life to the grabbed/restrained condition.
- **`memoryLoss`:** create the descriptive effect and whisper the GM the lost memory's scope; there is no mechanical effect beyond the attached condition.

### Module hooks (`scripts/save-outcome-hooks.mjs`)

- **Turn start** (`pf2e.startTurn` / the combat turn change): for a combatant with a `wasteActions` effect, an **AI-controlled** target has `turnState.actionsRemaining` reduced by `n` (clamped at 0) before its decision loop runs, and the effect is consumed; a **human-driven** target gets a public reminder card ("<name> must waste N action(s) dancing this turn") and the effect is consumed after the turn ends. For `restrictActions`, an AI target's candidate list is filtered to the single permitted action (the escape save, offered as a cost-1 candidate that rolls the save and removes the effect on success); a human gets the reminder.
- **Turn end** (`pf2e.endTurn`): for a creature with `Remaining Air`, reduce air by 1 round (2 if the creature attacked or cast a spell this turn, read from the per-turn state); when air hits 0, apply Unconscious and begin suffocating. For a **suffocating** creature, an **AI/monster** target rolls the Fortitude save (DC 20, +5 per check) through the system, takes `1d10` untyped (+1d10 each time) on a failure, and dies on a critical failure; a human-driven character gets a reminder (full automation for player characters is #1095). A successful save from the ability's own escape (Drown's expel-water action) ends suffocation.
- **Cleanup:** all effects created here are agent-tagged; combat end removes unlimited ones; expiry is the system's own for timed ones.

### Immunity and duration

`immuneSeconds` from #915/#935 applies unchanged (All Becomes Flame's "temporarily immune for 1 day regardless of the result"); the effect durations come from the parsed text.

## Error handling

- Parsing never throws; an unrecognized outcome keeps the ability `reportOnly` with the verbatim outcome text whispered to the GM.
- A rule-element effect that fails to create is logged and reported; the other outcomes still apply.
- A forced move that cannot proceed (wall, occupied cell) stops at the last legal cell; a zero-distance result is reported, not an error.
- A hook failure at turn start or end is logged and never blocks the combat turn; the creature's turn proceeds un-modified.
- If `Remaining Air` cannot be created (compendium missing), the breath outcome falls back to `reportOnly` for that use and the GM is told.
- The AI candidate filter for `restrictActions` falls back to the normal list if the effect marker is unreadable.

## Testing

- **Parser (pure), real-text fixtures:** each pattern with the texts above (Do a Jig!, Drown, Mask of Fate, All Becomes Flame, Smother, Hydraulic Asphyxiation, Extract Memory, an Inexorable March push, a resistance edit); near-misses that must keep `reportOnly`.
- **Effect synthesis:** the `FlatModifier` with `removeAfterRoll`, the `DamageAlteration` override, resistance/weakness/immunity rules and durations produce the expected effect item data (golden fixtures); a modifier is consumed by its first matching roll in a stubbed roll flow.
- **Hooks (mocked Foundry):** AI `actionsRemaining` reduction and clamp, human reminder and consumption timing, `restrictActions` candidate filtering and the escape save, air decrement (1 vs 2), Unconscious at 0, suffocation save DC/damage progression, critical-failure death, escape on a successful save, `whileGrabbed` linkage.
- **Forced movement:** push, pull and move distances, blocked stops, occupancy.
- **Coverage audit with ratchet (#935):** counters per new outcome kind, a monotonic auto-count, and a golden file so changes are visible; `reportOnly` reasons for the unrecognized remainder.
- **Regression:** #915/#935 parser, executor and audit tests keep passing; abilities that were `auto` stay `auto` with identical results.
- **Live verification:** a gnome bard's Do a Jig! on an AI-controlled creature and a human character (reminder), a Mask of Fate penalty consumed by one save, All Becomes Flame turning a caster's damage to fire, a Drown/Smother sequence ending in suffocation or escape, and a push outcome against a wall.

## Explicitly out of scope

- Real enforcement of wasted/restricted actions on human-driven turns — #1094; the rest of the drowning rules and player-character suffocation saves — #1095; curse suppression, remove-curse integration and unmodeled curse traits (Curse of Darkness) — #1096; abilities that reference creature-specific aura entries (Focus Beauty, Focus Gaze) — #1097.
- Bundled-effect, random-effect and no-outcome-text abilities (#988) and Trample (#986).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the exact grammar patterns finalized against the fixture, the shape of `pullTokenToward`, how a creature's per-turn "attacked or cast" state is read for the air decrement, and the marker-effect names.
