# Advanced AI NPCs: Strike Plus Spell Riders (Dispelling Strike, Dimensional Ambush, Drain Magic)

**Issue:** #1047 — Strike plus spell riders, deferred from #978.

**Builds on:** #978 / `docs/superpowers/specs/2026-10-09-ai-npc-strike-plus-shapes-design.md` (more Strike-plus shapes, the last-action record, restricted extra actions), #933 (Strike-plus shapes, MAP mechanics), #1021 / `docs/superpowers/specs/2026-10-09-ai-npc-spell-counteract-reactions-design.md` (`rollCounteract`, `counteractRank`), #915/#935 (save and outcome helpers), #932 (movement/teleport executors), #925 (result descriptor), the spell executors in `scripts/dungeon-combat.mjs` (`castSpellAndApplySave`, `castAreaSpellAndApplySaves`, ...).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Three NPC abilities pair a Strike with an innate spell: **Dispelling Strike** (balor, leydroth, treerazer), **Dimensional Ambush** (katpaskir) and **Drain Magic** (vanyver). This spec adds a **generic `castInnateSpell` helper** that resolves a fixed innate spell from the creature's own spellcasting data and applies it through the module's spell executors, with **Dispel Magic** resolved through #1021's counteract helper, and wires the three abilities to it with the sequencing and gating each text requires.

## Investigation findings

From the compendium (Bestiary, Bestiary 2, Monster Core).

- **Dispelling Strike** (balor, leydroth, treerazer; free action, once per round): trigger "hits a creature, object, or spell effect with a weapon Strike"; the creature casts an innate **Dispel Magic** on the target of the triggering Strike (the leydroth variant targets one effect on the struck creature).
- **Dimensional Ambush** (katpaskir, 2 actions, divine/teleportation): casts **Translocate**, then makes a melee Strike that deals **three extra dice** of damage; the Strike counts as **two attacks** for the multiple attack penalty.
- **Drain Magic** (vanyver, 1 action): requirement — the creature's last action was a successful jaws Strike against a creature, object or spell effect; casts an innate Dispel Magic on the same target (or, if the target was a creature, on a spell affecting it); if a spell effect or item is successfully counteracted, the vanyver gains temp HP equal to **double the counteract rank** of the counteracted effect.
- **What exists.** #978 adds the last-action record (what the previous action was and whether it hit) and restricted extra actions; #933 defines MAP-control mechanics (counts as N attacks); #1021 provides `counteractRank`/`rollCounteract`; the module's spell executors resolve targeted, area, attack, debuff and chain spells with slots, DCs and effects. NPC spells come from the creature's own `spellcastingEntry` items; innate spells carry their own DC/attack modifiers.
- **What is missing.** A general way to cast one fixed innate spell *from inside an ability executor* (resolve the spell item, pick the target, DC, apply effects), plus the sequencing/gating rules, and a way to remove a spell *effect* from a target by counteracting it.

## Resolved decisions

1. **All three abilities in scope.**
2. **A generic `castInnateSpell` helper**, shared by all three, resolving the spell from the creature's own innate entry by slug and using the module's spell executors; Dispel Magic goes through #1021's counteract helper. A spell the creature does not actually have, or one the executors cannot run, means the ability is not offered.
3. **Dispel target selection is deterministic:** the highest-counteract-rank beneficial effect on the target (spell effects and spell-created conditions), else an object's effect; ties by remaining duration. If nothing is dispellable the Dispel is skipped (the Strike still happens).

## Design

### `castInnateSpell` (`scripts/npc-innate-cast.mjs`)

```js
castInnateSpell({ combatant, spellSlug, target, mode }) → { cast: boolean, spell, dc, attackMod, result }
```

1. Resolve the spell: find an `spellcastingEntry` of kind `innate` on the actor whose spell slug equals `spellSlug` (Dispel Magic, Translocate); read its rank, DC and spell attack modifier. No such spell → `{ cast: false }` and the ability is not offered at vocabulary time (checked up front, not at execution).
2. Dispatch to the matching existing executor by spell shape (`castSpellAndApplySave`, `castAttackSpellAndApplyRoll`, a utility path for spells with no save or attack) so slot/use accounting (innate frequency per day) and chat output are handled in one place. Innate spells with a use limit decrement it.
3. Return a result descriptor for #925.

### Dispel Magic (`dispelEffect`, `scripts/npc-dispel.mjs`)

`chooseDispelTarget(target)` returns the effect to counteract: the target's active spell effects and conditions that originate from spells, ranked by counteract rank (`counteractRank`) descending, then by remaining duration; it never dispels effects the NPC's side applied. Executes `rollCounteract({ modifier: spell attack/counteract modifier, dc: effect source DC, counteractorRank: spell rank, targetRank })`; on `counteracted` the effect item is deleted. An object target uses the object's magical effect/rune if present; if the item has none, nothing happens. Returns `{ counteractedRank }` so Drain Magic can compute temp HP.

### Dispelling Strike (`onHitCast`)

A free action with trigger "hits a creature, object, or spell effect with a Strike" and frequency once per round. It is a **post-hit rider on any Strike the creature makes**, run inside the Strike executor right after a hit: if the creature has the ability, it is available (the once-per-round counter via #931's frequency store), and a dispellable effect exists on the target, run `castInnateSpell("dispel-magic")` with `chooseDispelTarget`. Deterministic and automatic (always worth it when something is dispellable). The leydroth variant's "one effect on the creature struck" and the balor/treerazer variant's "the target of the triggering Strike" are the same rule here. Announced publicly; recorded in the result.

### Dimensional Ambush (`castThenStrike`)

A 2-action `npcStrike`-style entry: 

1. `castInnateSpell("translocate")` — the creature teleports using the spell's rules (within the spell's distance, to a space the creature can see) to a legal space adjacent to the chosen target (the planner picks the destination: a free space within reach of the target, within the teleport range; if none, the ability is not offered). Uses the movement executor with `{ teleport: true }`.
2. A melee Strike on the target with **three extra damage dice** of the weapon's base die (added to the damage roll, doubled on a critical like the rest) and the **counts-as-two-attacks** MAP rule (#933: the Strike is rolled at the current variant; `mapIncrement` advances by 2).
If the cast fails or no destination exists the ability is not offered or aborts before the Strike.

### Drain Magic (`lastActionDispel`)

A 1-action follow-up gated by #978's last-action record: previous action was a successful jaws Strike against a creature, object or spell effect (the record's `weaponSlug` and `hit`). Execution: `castInnateSpell("dispel-magic")` on the same target; for a creature target, `chooseDispelTarget` selects a spell effect; on a successful counteract, grant temp HP equal to `2 × counteractedRank` through the module's temp-HP helper (no stacking beyond the higher of the two, per PF2e).

### Vocabulary

Entries are `npcStrike` with a `riders` list (`dispel`, `translocateThenStrike`, `drain`), each with a deterministic summary ("Strike, then Dispel Magic on the target" / "Teleports next to the target and Strikes with +3 dice (counts as 2 attacks)" / "After a jaws Strike: Dispel, gain temp HP"). Entries are offered only if the creature's spell data is resolvable and the executors support the spell.

### Reviewed recognition

The three families are exact-match reviewed definitions (item names and texts fixture-checked); every sentence must be consumed (all-or-nothing) so variants with other text are not offered.

## Error handling

- Spell data missing or unsupported: not offered; a debug line records why.
- No dispellable effect: the Strike proceeds; the cast is skipped without spending the use.
- Teleport destination blocked at execution: the ability aborts before the Strike and refunds the action (no partial state).
- Counteract check results always reported; effects removed through GM-safe document deletion (relay for players' effects).

## Testing

- **castInnateSpell:** resolves innate entries; missing spell → not offered; use limits decrement.
- **Dispel:** target ranking, rank/degree table via the counteract helper, effect deleted only on success, objects, none.
- **Dispelling Strike:** fires after a hit once per round; not after a miss; leydroth/balor/treerazer fixtures.
- **Dimensional Ambush:** destination choice, +3 dice and crit doubling, MAP advances by 2.
- **Drain Magic:** gated on the last-action record; temp HP = 2× counteracted rank, no stacking.
- **Fixtures:** each item's text matches; changes disable it.
- **Live verification:** a balor's Strike dispels a party buff; a katpaskir teleports next to a caster and Strikes.

## Explicitly out of scope

- Other spell-casting riders and spells needing target selection beyond the two listed.
- Casting from spell slots (prepared/spontaneous), covered by the AI caster pipeline.
- Counterspell-style reactions (#1021).

## Open questions

None. Planning-time details: the exact Translocate range/restrictions and the executor path for spells with neither attack nor save.
