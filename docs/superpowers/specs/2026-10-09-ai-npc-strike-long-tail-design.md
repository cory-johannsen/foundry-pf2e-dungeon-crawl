# Advanced AI NPCs: The Strike-Ability Long Tail

**Issue:** #1048 — remaining strike-related NPC abilities outside the #933/#978 shapes (long tail).

**Builds on:** #978 / `docs/superpowers/specs/2026-10-09-ai-npc-strike-plus-shapes-design.md` (more Strike-plus shapes, `NPC_STRIKE_OVERRIDES`, the golden-file audit and ratchet that reports unparsed reasons), #933, #935 (golden-file ratchet pattern), #979 / `docs/superpowers/specs/2026-10-09-ai-npc-equipment-damage-design.md` (equipment damage), #1047 / `docs/superpowers/specs/2026-10-09-ai-npc-strike-plus-spell-riders-design.md`, #997 (interact-to-reload), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

About 170 strike-related NPC abilities remain outside every named shape after #978. This spec turns the problem into a bounded, repeatable process: a **use-frequency-ranked audit**, **owner-approved override entries for the top N**, and **one new shape per family only when it unlocks at least five abilities**. Three families are named as first targets: **interact-then-Strike** (Load Sachet and similar), **equipment/armor-effect riders**, and **one-off riders** via override entries. Everything else stays unmodeled with a recorded reason.

## Investigation findings

- **#978's audit** already emits a golden file of `{ creature, ability, shape | override | notOffered, reason }` for every strike-related ability and a monotonic count test; it reports the unparsed reasons "to prioritize #1047/#1048". The remaining long tail is exactly the `notOffered` rows with reasons such as `interact-then-strike`, `equipment-effect`, `one-off-rider`, `unrecognized-trigger`.
- **Interact-then-Strike.** *Load Sachet* (centaur herbalist, 1 action): requirement — has at least one herbal sachet; the creature loads a sachet into its weapon and later Strikes with the loaded effect. The pattern is a setup action that records a **loaded state** and a Strike (or the next Strike) that consumes it.
- **Equipment/armor-effect riders** are Strikes whose rider depends on or damages the target's worn equipment (shield, armor, a held weapon). #979 already models equipment damage for NPC abilities (the damage-to-item executor); this family reuses it.
- **One-off riders** are singletons with unique text. Their cost-benefit is low individually; the audit's ranking decides which deserve a hand-written descriptor.
- **Loaded state precedent.** #997's reload state records `loaded` per ranged weapon; the herbal sachet is a consumable item rather than ammunition but follows the same shape: a counted item on the actor, a "loaded" flag, and a Strike that consumes it.

## Resolved decisions

1. **Process:** a ranked audit by use frequency; override entries for the owner-approved top N; a new shape only when it covers **≥ 5** abilities; the rest stay unmodeled with reasons in the golden file.
2. **Named first-target families:** interact-then-Strike, equipment/armor-effect riders, and one-off riders via override entries.
3. **All-or-nothing**, as everywhere; no ability is offered with unmodeled text.

## Design

### Ranked audit (`tools/audit-strike-long-tail.mjs`)

Reads #978's golden file and ranks `notOffered` abilities by `score = creaturesSharingAbilityName × encounterFrequency`, where `encounterFrequency` is the number of times the creature appears in the module's generated-encounter data (the encounter roster's per-creature weight); ties broken by name. It groups abilities by reason and by detected family, then emits a report and a fixture. The report is the input to the owner's approval of the top N (N is decided at planning, expected 20–40).

### Family 1: interact-then-Strike (`interactThenStrike`)

Recognition (extends `npc-strike-shapes.mjs`): a one-action ability whose effect text is "the creature loads/readies <item> ... the next Strike ..." with a `Requirements: has at least one <consumable>` clause; the shape parses `{ item, strikeLimb?, riderOnHit }` where the rider is any of #978's modeled riders. Execution:

1. **Setup action** (the load): check the actor owns the consumable (a named item with quantity ≥ 1); decrement it and record `flags.pf2e-dungeon-crawl.loadedStrike = { item, rider, weapon }`.
2. **Strike action**: when a `loadedStrike` exists, the Strike candidate for the named limb carries the rider; the executor applies the on-hit rider through the existing shape machinery (condition, damage, save) and clears `loadedStrike`.
3. A load that is never used lasts until the end of the creature's next turn (cleared by the turn hook and at combat end).
The shape is added **only if** the audit shows at least five abilities fit it; otherwise Load Sachet is an override entry.

### Family 2: equipment/armor-effect riders (`strikeEquipment`)

Reuses #979's `damageEquipment` executor: a Strike whose on-hit rider damages, breaks, disarms-style affects or adds a penalty tied to a worn/held item (shield, armor, weapon). Recognized by the grammar "if the Strike hits ..., the target's <armor|shield|weapon> ..." and routed to #979's descriptors. The rider's target selection follows #979 (the equipped item of the matching type; none → rider skipped, Strike unaffected). Again added as a shape only if ≥ 5 abilities fit; otherwise as overrides.

### Family 3: one-off riders (override entries)

`NPC_STRIKE_OVERRIDES` gains the top-N entries from the audit: a keyed descriptor (ability name + source book), a reviewer comment, and a **fixture hash of the item text** that disables the entry if the compendium changes. Descriptors use only vocabulary existing code can execute (shapes from #933/#978/#1047, conditions via #935, movement via #932); an ability that would need new executor code is deferred, not hacked in.

### Ratchet and reporting

The golden file from #978 is extended with the new `shape | override` rows; the monotonic count test ratchets up. A summary line reports how many of the ~170 are modeled, with reasons for the remainder. No ability is "partially" modeled.

### Vocabulary

New shapes and overrides flow into the existing `npcStrike` entries (#933/#978); candidate summaries are deterministic and state any loaded-item cost ("uses 1 herbal sachet").

## Error handling

- Missing consumable or loaded state at execution: the setup action aborts unspent; a Strike with a stale `loadedStrike` ignores the rider.
- Equipment rider without a matching item: the rider is skipped, the Strike resolves normally.
- A changed item text disables its override and shows up in the audit diff.

## Testing

- **Audit:** deterministic ranking from a fixture of the golden file and roster weights; families detected; report output.
- **Interact-then-Strike:** load consumes one item, sets the state, Strike applies the rider, state clears at expiry and combat end.
- **Equipment riders:** routed to #979's executor; skipped when no item.
- **Overrides:** each has a fixture assertion; the golden-file ratchet counts increase only.
- **Live verification:** a centaur herbalist loads a sachet and its next Strike applies the sachet's effect.

## Explicitly out of scope

- New shapes covering fewer than five abilities (override entries instead).
- Abilities needing new executor primitives not already in the module.
- Strike abilities already covered by #933/#978/#1047.

## Open questions

None. Planning-time details: the owner's top-N cutoff and the shape thresholds (confirmed from the audit counts).
