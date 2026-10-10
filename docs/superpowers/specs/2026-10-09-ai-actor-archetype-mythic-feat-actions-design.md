# Advanced AI Actors: Archetype and Mythic Targeted Feat Actions

**Issue:** #998 — archetype and mythic targeted feat actions, deferred from #947.

**Builds on:** #947 / `docs/superpowers/specs/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect-design.md` (shapes, override table, class set), #933, #934, #992 (closed-world state rule), #997.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

About 59 archetype feats and 9 mythic feats are targeted actions with no `selfEffect` (Walk the Plank, Fated Duel, Lesson of the Broken Wing, Imprison Foe, Scout's Charge, Black Powder Flash, Mesmerizing Gaze, Boaster's Challenge, ...). They are too heterogeneous to add wholesale. This spec adds a **reviewed allowlist**: a generated, ranked audit of the population is reviewed once, and only the approved slugs are recognized, through #947's existing shapes. Nothing new is parsed; a feat the shapes cannot fully consume stays out (all-or-nothing). Mythic feats that spend Mythic Points are not offered.

## Investigation findings

- **Population.** A text scan of one/two-action and free archetype and mythic feats whose text designates a target creature without a `selfEffect` finds roughly 20 obvious candidates (for example Lassoing Lash, Command Attention, Fabricate Truth, Lesson of the Broken Wing, Scout's Charge, Battlefront Sabotage, Boaster's Challenge, Mesmerizing Gaze, Black Powder Flash, Steal Time, Spiral Sworn) beyond the 68 counted in #947, with the rest requiring bespoke state.
- **Heterogeneous traits.** The set mixes `flourish`, `incapacitation`, `spellshape`, `mythic`, mental/visual/auditory effects, and bespoke riders. #947's shapes (`strikePlus`, `skillCheckVsDc`, `targetSave`, `targetEffect`) cover only a subset.
- **Prerequisites.** An archetype feat on a character sheet already satisfies its dedication and level prerequisites; the module need not re-check them. The class-trait gate in #947 does not apply (the feats carry the `archetype` trait, not a class).
- **Mythic.** Mythic feats frequently spend Mythic Points, which the module does not track.

## Resolved decisions

1. **Reviewed allowlist, shapes only.** An audit script ranks the population; the owner-approved slugs form `ARCHETYPE_MYTHIC_ALLOWLIST`. Only those feats are parsed.
2. **No new overrides in this spec** (filed as #1118).
3. **Mythic point spending is out** (filed as #1117); mythic feats that do not spend points may be allowlisted.
4. **Prerequisites are the sheet's job.** An actor that owns the feat may use it, subject to #947's gates and #992's closed-world requirements.

## Design

### Audit (`tools/audit-archetype-feats.mjs`)

Reads the compendium, runs `parseTargetedFeat` over every archetype/mythic item without a `selfEffect`, and emits a ranked report (shape, cost, likely AI value from cost/range/effect, parse outcome). It marks each row `parses` / `partial` / `unsupported`. Only `parses` rows are eligible for the allowlist.

### Allowlist (`scripts/feat-action-allowlist.mjs`)

```js
export const ARCHETYPE_MYTHIC_ALLOWLIST = new Set([/* slugs approved from the audit */]);
```

`parseTargetedFeat` accepts an item when its class trait is in `FEAT_ACTION_CLASS_SET` **or** its slug is in the allowlist. The audit output is stored as a fixture; a test asserts every allowlist slug is `parses` in the fixture, so a compendium change that breaks a parse fails loudly.

### Gates

- Mythic feats: any text that spends or refers to Mythic Points (`mythic point`, `Mythic Point`, `spend a Mythic Point`) → not offered.
- All other gates from #947 (cost, frequency, traits, requirement predicates, flourish/finisher, closed-world state) apply unchanged.

### Vocabulary and execution

No changes: allowlisted feats flow through the existing `targetedAction` vocabulary entries and executors. Candidate summaries state the shape's effect deterministically.

## Error handling

- An allowlist slug that disappears from the compendium or fails to parse is skipped with a debug warning.
- Mythic text that cannot be classified as point-free → not offered.

## Testing

- **Audit:** fixture of classified rows; allowlist membership test; deterministic ranking.
- **Parser:** allowlisted feats parse via shapes; non-allowlisted archetype feats are ignored; mythic point text excluded.
- **Vocabulary:** an allowlisted archetype feat is offered to an actor that owns it and not to one that does not.
- **Live verification:** an AI actor with an allowlisted archetype feat uses it against a legal target.

## Explicitly out of scope

- Override entries for archetype feats the shapes miss — #1118.
- Mythic point tracking and mythic feats that spend points — #1117.
- Wholesale parsing of the archetype/mythic population (rejected alternative).

## Open questions

None. Planning-time details: the allowlist contents (decided from the audit), and how many audited rows qualify.
