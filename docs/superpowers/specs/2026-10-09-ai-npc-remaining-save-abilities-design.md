# Advanced AI Actors: Remaining Bespoke Save Abilities (Random-Effect Abilities and the Reviewed Remainder)

**Issue:** #988 — remaining bespoke save abilities (multi-effect and random-effect abilities), deferred from #935.

**Builds on:** #935 / `docs/superpowers/specs/2026-10-08-ai-npc-save-outcome-coverage-design.md` (the outcome model, grammars, override table, golden-file ratchet), #987 / `docs/superpowers/specs/2026-10-09-ai-npc-custom-save-outcomes-design.md` (the new outcome kinds: action loss, curses, forced movement, suffocation, trait edits, memory loss), #984 / `docs/superpowers/specs/2026-10-09-ai-npc-prose-abilities-design.md` (the reviewed declarative-table pattern and zone primitives), #915 (save executor, immunity), #986 (Trample).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

After #915, #935, #987, #986 and #984, the save-based NPC abilities that still do not run automatically are a mixed remainder. The owner chose a narrow first slice: **random-effect abilities** ("Roll 1d4 to determine the effect"), plus the **audit-ranked, owner-approved override entries** that carry the long tail. This spec defines a **random-table shape** for the first, an **inventory of the whole remainder** for the second, and the policy for outcomes that say "the target takes the effects of the <spell> spell": apply the spell's effect item when the compendium has one, otherwise the ability is not offered. Sustained effects, afflictions, area forced movement with mixed zone-plus-save abilities, and spell-casting outcomes are filed as follow-ups (#1102–#1105).

## Investigation findings

Confirmed against the repo and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **The remainder, classified.** A loose scan of active (1–3 action or free) NPC actions that carry an inline save and no damage enricher, excluding Strikes, movement, summons and corpses, finds about **302 candidates across ~200 names**. By shape: **88 with no outcome text** (45 of them Trample, now #986; the rest are inline-wording variants and abilities whose outcome lives elsewhere), **68 block-form abilities with an unparsed outcome** (many now covered by #987's outcome kinds), **67 single inline outcomes** that #935's inline patterns did not cover (for example Poltergeist's Frighten, Mirage Dragon's Captivating Display), **53 matched by a dice/roll heuristic** (most are false positives — a recharge roll or a damage roll — and **only two have a real random table**), **23 that bundle movement, grabs or Strides**, and **3 terrain/zone side effects**. The classification is an input to the audit below, not a promise of coverage.
- **The genuine random-effect abilities are two.** *Draxie Dust* (Draxie) is the canonical form: "The draxie breathes magical dust in a `@Template[cone|distance:15]`. **Roll `[[/r 1d4]]` to determine the effect.** Each creature in the area must succeed at a `@Check[will|dc:17]` save or be affected. The draxie can't use Draxie Dust again for `[[/gmr 1d4 #Recharge Draxie Dust]]`." followed by an ordered list: (1) "takes the effects of the Charm spell", (2) "loses its last 5 minutes of memory", (3) "takes the effects of a Sleep spell", (4) "for 1 minute … Stupefied 2 and Slowed 1". *Hallucinogenic Cloud* (Basidirond) mentions dice but is an area aura with per-round saves, not a random table.
- **The structure is regular.** A random-effect ability has: a roll sentence naming the die (`[[/r 1dN]]`), a save sentence, an optional recharge, and an **ordered list of N outcomes** whose indices match the die faces. The roll happens **once per use**, before the saves.
- **Spell outcomes have no effect items here.** The compendium's `spell-effects` pack (517 entries) contains **no Charm and no Sleep effect item** (only an unrelated "Charming Push"). PF2e also has no "Charmed" condition (Charm changes attitude and restricts hostile actions through the spell text). Under the owner's policy those two outcomes cannot be applied, so **Draxie Dust, as written, would not be offered**; the other two outcomes are already expressible with #987's `memoryLoss` and #935's conditions.
- **Existing building blocks.** #987's outcome kinds (`memoryLoss`, forced movement, trait edits, action loss), #935's `applyTimedCondition`/`applyTimedEffect`, #915's save executor and recharge store, #984's reviewed declarative table with a fixture hash that disables an entry when the compendium text changes, and #915's area membership helper.
- **Rolling dice publicly is routine.** The module already creates PF2e damage and check rolls with chat messages; a plain `Roll` with a flavor line posts like any other table roll.

## Resolved decisions

1. **First slice: random-effect abilities** (the ordered-list random table), plus the audit-ranked override entries for the long tail.
2. **Outcomes of the form "takes the effects of the <spell> spell":** apply the spell's effect item from the PF2e spell-effects pack when one exists; otherwise the ability is **not offered** (stays roll-and-report). Casting the spell for real is #1105.
3. **Method: shapes for the chosen family plus override entries ranked by creature count and approved by the owner at plan time** (the #935/#984 pattern).
4. **Unselected families are filed:** sustained effects (#1102), afflictions (#1103), area forced movement and mixed zone-plus-save abilities (#1104), and spell-casting random outcomes (#1105). "Never offer spell outcomes" and "overrides only / shapes only" were rejected as implementation alternatives and get no tickets.

## Design

### The `randomTable` shape (extends #915/#935's save descriptor)

`parseSaveAbility(item)` gains an optional `random` field when the description contains **exactly one** roll sentence `Roll [[/r 1dN]] to determine the effect` **and** an ordered list (`<ol>`) of exactly `N` items:

```js
random: {
  die: 4,
  entries: [
    { index: 1, text: "The target takes the effects of the Charm spell.", outcome: { kind: "spellEffect", spellUuid: "Compendium.pf2e.spells-srd.Item.Charm" } },
    { index: 2, text: "...loses its last 5 minutes of memory.", outcome: { kind: "memoryLoss", scope: "lastMinutes:5" } },
    { index: 3, text: "...effects of a Sleep spell.", outcome: { kind: "spellEffect", spellUuid: "Compendium.pf2e.spells-srd.Item.Sleep" } },
    { index: 4, text: "...Stupefied 2 and Slowed 1 for 1 minute.", outcome: { conditions: [{ slug: "stupefied", value: 2 }, { slug: "slowed", value: 1 }], durationSeconds: 60 } }
  ]
}
```

- Each entry's text must parse with #935's/#987's outcome grammars into a known outcome, or into `spellEffect` (a linked spell UUID). Any entry that does not parse makes the whole ability `reportOnly` (all-or-nothing).
- A `spellEffect` entry is **resolvable** only if the spell-effects pack has an effect item for that spell (an index lookup by the spell's name). An unresolvable `spellEffect` makes the ability **not offered**, per the owner's policy (so Draxie Dust, today, is not offered). The audit reports exactly which spell outcomes block which abilities, feeding #1105.
- The save outcome for random abilities is binary as the text says ("must succeed … or be affected"): success is no effect, failure applies the rolled entry (a critical failure behaves as a failure unless the ability states otherwise).

### Execution (extends #915's executor)

1. Spend the cost, decrement frequency, record the recharge roll as the ability states (`[[/gmr 1d4 #Recharge …]]`), post the usage message.
2. **Roll the die once**, publicly (a `Roll("1dN")` chat message with the ability name as flavor), then announce which entry was rolled and its text.
3. For each affected creature (the template's affected set, enemies of the actor): roll the save through the system; on a failure apply the rolled entry's outcome through the existing helpers (`applyTimedCondition`, `applyOutcomeEffects` for #987 kinds, the spell effect item created on the target with the ability as origin). Immunity windows apply as for any save ability.
4. Report through #925's result descriptor: the die result, each target's save result and what was applied.

The vocabulary entry is an ordinary save-ability entry with a deterministic `summary` that lists the possible effects ("Draxie Dust: cone 15 ft, Will DC 17, random effect (d4): charm / forget 5 min / sleep / stupefied 2 + slowed 1").

### The reviewed remainder (override entries and the inventory)

- **Override table:** #935's reviewed `NPC_ABILITY_OVERRIDES` (and #984's declarative entries for non-save prose) remain the way a long-tail ability becomes offered when no shape fits: a hand-written descriptor with a reviewer comment and a fixture hash.
- **Inventory:** the #935 audit is extended with a **remainder inventory** — every save ability that is still `reportOnly` or not offered, with `{ ability, creature count, shape: noOutcomeText | blockUnparsed | inlineUnparsed | randomTable | movementBundled | zoneBundled, blockedBy: <missing capability or issue> }`, ranked by creature count. At planning time the planner proposes the highest-count entries that can be authored with the existing primitives and the owner approves the list; abilities that need a missing capability are recorded against the follow-up that provides it (#1102–#1105, #987's follow-ups).
- **Ratchet:** the golden file and monotonic auto-count from #935 cover the new shape and every approved override entry.

## Error handling

- Parsing never throws; a malformed roll sentence or list (die size and item count disagree, an unparseable entry) is `reportOnly`.
- An unresolvable spell effect makes the ability not offered and is reported by the audit, never guessed at.
- The die roll cannot fail silently: if the `Roll` throws, the action is not spent and the GM is told.
- A failure applying one entry to one target is logged and reported; the other targets still resolve.
- An override entry whose fixture hash no longer matches is disabled until re-reviewed (the #984 rule).

## Testing

- **Parser (pure), real-text fixtures:** Draxie Dust (a d4 with a four-item list, including the two spell entries), a list whose count does not match the die (rejected), a list with an unparseable entry (rejected), Hallucinogenic Cloud (not a random table), a recharge roll that must not be mistaken for the effect die.
- **Spell-effect resolution:** a spell with an effect item resolves, Charm and Sleep (today) do not, and the resulting "not offered" status is reported with the blocking spell.
- **Executor (mocked Foundry):** the die rolled exactly once per use and posted, each entry applied through the right helper (condition pair, memory loss, a stubbed spell effect), saves per target, immunity windows, recharge recorded, partial failures.
- **Inventory and ratchet:** the remainder inventory classifies the fixture, counts per shape and blocking capability, and fails on a hash mismatch or a count drop.
- **Regression:** #915/#935/#987 parser, executor and audit tests keep passing.
- **Live verification:** a draxie (once an equivalent spell outcome is available) or a stand-in random-table fixture creature rolling the die in chat and applying the rolled effect to creatures that fail.

## Explicitly out of scope

- Sustained save-ability effects (Haunting Melody) — #1102; afflictions (Spit Venom) — #1103; area forced movement and mixed zone-plus-save abilities (Hurricane Blast, Solidify Mist) — #1104; random outcomes that cast spells (Draxie Dust's Charm and Sleep) — #1105.
- Trample (#986), custom outcome kinds (#987) and zones/state toggles (#984).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: the approved override-entry list from the inventory, how the spell-effect index lookup is cached, and the exact random-table grammar finalized against the fixture.
