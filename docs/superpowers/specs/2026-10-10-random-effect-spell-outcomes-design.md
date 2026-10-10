# Advanced AI Actors: Random-Effect Outcomes That Take the Effects of a Spell (Draxie Dust)

**Issue:** #1105 — random outcomes of the form "the target takes the effects of the <spell> spell", deferred from #988.

**Builds on:** #988 / `docs/superpowers/specs/2026-10-09-ai-npc-remaining-save-abilities-design.md` (the `random` table shape, `spellEffect` outcomes, the "not offered" policy this spec relaxes), #1047 / `docs/superpowers/specs/2026-10-09-ai-npc-strike-plus-spell-riders-design.md` (`castInnateSpell`, `dispelEffect`, spell-data resolution), #987 / `docs/superpowers/specs/2026-10-09-ai-npc-custom-save-outcomes-design.md` (`memoryLoss`, outcome kinds), #935 (`applyTimedCondition`, immunity), #915 (save executor), #1094 (human-turn enforcement), #925 (result descriptor).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

#988 defines a random-effect table (roll a die, apply the matching entry) but, because the PF2e spell-effects pack ships no Charm or Sleep effect item, it declines to offer abilities whose entries say "takes the effects of the <spell> spell". This spec closes that gap: such an entry resolves the **real spell from the PF2e spell compendium**, skips the spell's own save (the ability's save already failed), and applies the spell's **failure-degree outcome** with the ability's DC and a stated rank, with **reviewed equivalent effects** as a fallback. It also enforces Charm's hostile-action restriction and Sleep's wake-on-damage behavior.

## Investigation findings

- **The canonical ability:** *Draxie Dust* (Draxie, 15-ft cone): "Roll 1d4 to determine the effect. Each creature in the area must succeed at a Will DC 17 save or be affected. The draxie can't use Draxie Dust again for 1d4 rounds." Entries: (1) "takes the effects of the Charm spell", (2) "loses its last 5 minutes of memory", (3) "takes the effects of a Sleep spell", (4) "for 1 minute … Stupefied 2 and Slowed 1" (from #988's investigation). Today it is not offered.
- **No spell-effect items for Charm and Sleep.** The `spell-effects` pack (517 entries) has none (#988), and the PF2e system has no "Charmed" condition; Charm and Sleep are expressed in the spells' own text and conditions (Charm: changes attitude and restricts hostile actions against the charmer; Sleep: an Unconscious effect that wakes on damage or a nudge per its degrees). The spell items exist in `spells-srd` with their per-degree descriptions.
- **The ability's own save is the save.** The text says the creature "must succeed at a Will DC 17 save or be affected"; the "takes the effects of" outcome applies the spell's effect, not a second save.
- **#1047's `castInnateSpell` resolves spells from the creature's own innate entries.** A draxie does not carry Charm or Sleep as innate spells, so that path does not apply here; the module needs a variant that resolves from the compendium.
- **Existing building blocks:** #988's `random` descriptor and executor (die rolled once, public Roll chat message), #987's `memoryLoss` and #935's condition helpers for entries 2 and 4, and #1047's `dispelEffect`/counteract helper for any dispelling interplay.

## Resolved decisions

1. **Spell outcomes use the real spell's failure-degree outcome from the compendium**, with a reviewed equivalent effect as the fallback when a spell cannot be applied that way.
2. **Charm is enforced** by filtering hostile-action candidates against the charmer for AI-controlled targets, with a reminder (and #1094 enforcement where available) for player characters; the attitude change is a descriptive note.
3. **Sleep's wake-on-damage** is a damage-taken hook that ends the Sleep-origin effect when the sleeper takes damage, honoring the applied degree's "doesn't wake" wording.
4. **All four extras are in scope** (no follow-up tickets): an audit for other "takes the effects of the <spell>" abilities, spell-rank source and heightening, the euphoria condition-pair entry, and a public result card for the random roll.

## Design

### `applySpellEffects` (`scripts/npc-spell-outcome.mjs`)

```js
applySpellEffects({ source, target, spellSlug, abilityDC, rank, degree = "failure" }) → { applied: boolean, via: "spell"|"reviewed"|"none", items: Item[] }
```

1. **Resolve the spell** from the PF2e `spells-srd` pack by slug (`charm`, `sleep`); read its rank, duration and per-degree description.
2. **Apply the degree.** Run the module's spell-outcome grammar over the failure-degree sentences (the same closed grammar as #935/#987: conditions, durations, penalties, `restrictActions`/`hostileActionBlock`, `memoryLoss`), producing an outcome block, and apply it with `applyOutcomeEffects`, with the ability as origin, the spell's duration scaled by `rank`, and the agent tag.
3. **Fallback.** If the grammar cannot consume every failure-degree sentence, use the reviewed equivalent from `data/npc-spell-equivalents.json` for the slug: Charm → attitude note + `hostileActionBlock` against the source for the spell's duration; Sleep → timed `Unconscious` with `wakesOnDamage: true`. A slug with neither path returns `{ applied: false, via: "none" }` and the ability is not offered (the #988 policy, now the last resort).
4. The save is **not** re-rolled; the target already failed the ability's save.

### Rank, DC and heightening

- `abilityDC` is the ability's own DC (Will 17). The spell's rank comes from the table entry (`rank: n`, reviewed), defaulting to the lowest rank the ability's source creature level can plausibly support (the creature's level divided by 2, rounded up, clamped to the spell's minimum rank). The spell's heightened entries scale the duration or effect per the spell's `heightened` data where the grammar understands them; anything the grammar doesn't understand falls back to the base effect with a GM note.

### `random` table integration (extends #988)

`outcome.kind: "spellEffect"` gains `resolve: "compendium"` and `slug`. At vocabulary time `isOfferable(ability)` checks every `spellEffect` entry resolves through `applySpellEffects`' resolve/fallback step (without applying); only then is the ability offered. The audit reports unresolved slugs and the blocking spells, feeding any remaining gap. Entries 2 and 4 of Draxie Dust use `memoryLoss` and the euphoria condition pair (Stupefied 2, Slowed 1 for 1 minute) as already defined by #988/#987/#935.

### Charm enforcement

A `hostileActionBlock` marker effect (origin = the charmer) on an AI-controlled target removes from its candidate list any hostile action (Strikes, harmful spells, offensive abilities) whose target is the charmer, and the AI will not choose the charmer as a target of an area effect where avoidable; the effect ends on duration, when the charmer or its allies take hostile actions against the target (per the spell's text, read from the compendium and encoded in the reviewed table), or by counteract (#1096's detector). Player characters receive a turn-start reminder and, through #1094's integration when available, blocked disallowed rolls with GM override.

### Sleep wake-on-damage

A damage-taken hook (`pf2e` damage application) ends a Sleep-origin Unconscious effect when its target takes damage, unless the effect carries `wakesOnDamage: false` (set when the applied degree's text says the target doesn't wake from damage). A nudge ("wakes if shaken") remains a GM action on the effect.

### Audit for similar abilities

The #988 inventory scan gains a pattern for "takes the effects of (an? |the )?<Spell> spell" and "as if affected by <Spell>" outside random tables; hits are reported with the spell slug and resolution status; each found ability follows the same path (table entry with a `spellEffect` outcome) or is recorded as blocked.

### Result card

The #925 result descriptor for a random-effect ability shows the rolled die and entry, each target's save result, and for spell outcomes the spell name and "via compendium" or "via reviewed equivalent".

## Error handling

- A spell that fails to load, a grammar miss with no reviewed equivalent, or an unreadable heightening entry makes the entry unresolvable: the ability is not offered up front rather than failing mid-use.
- A failed application on one target is logged and reported; other targets continue.
- A hook failure (Charm filter, Sleep wake) never blocks the combat turn; the effect stays as applied and the GM is told.
- The die is rolled once and posted before any save; a roll failure refunds the action.

## Testing

- **`applySpellEffects` (pure/mocked compendium):** Charm and Sleep failure-degree text consumed by the grammar; a grammar miss falls to the reviewed equivalent; neither → not applied; the save is not re-rolled; rank clamping and heightened scaling.
- **Random table:** Draxie Dust offered once all four entries resolve; an unresolvable entry blocks the offer and is audited; die rolled once; entries 2 and 4 unchanged from #988.
- **Charm:** AI candidate filter excludes hostile actions against the charmer and nothing else; effect ends on duration, hostile action, counteract; player reminder posted.
- **Sleep:** damage ends the effect; `wakesOnDamage: false` ignores damage; duration expiry.
- **Audit:** a fixture with the pattern outside random tables is found and classified.
- **Result card:** die, entry, saves and the spell source line.
- **Regression:** #988 tests (entries without spell outcomes), #987/#935/#1047 behavior unchanged.
- **Live verification:** a draxie's Draxie Dust rolling each of the four entries across several creatures, an AI charmed creature declining to attack the draxie, a sleeping creature waking on damage.

## Explicitly out of scope

- Casting spells for real with a fresh spell save (#1047's `castInnateSpell`) — this spec applies a spell's effect, not a cast.
- Sustained effects (#1102), afflictions (#1103), area forced movement (#1104).
- Prose interpretation by the reasoning model.

## Open questions

None blocking. Left to planning: the grammar patterns finalized against the Charm and Sleep failure-degree texts, how the spell's "hostile action ends the effect" rule is encoded in the reviewed table, and where the damage-taken hook is registered relative to #1095's.
