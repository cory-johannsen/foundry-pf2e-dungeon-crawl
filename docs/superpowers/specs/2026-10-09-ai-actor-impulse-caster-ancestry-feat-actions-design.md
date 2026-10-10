# Advanced AI Actors: Kineticist, Caster-Class, Ancestry and Skill Targeted Feat Actions

**Issue:** #999 — kineticist impulse, caster-class, ancestry and skill targeted feat actions, deferred from #947.

**Builds on:** #947 / `docs/superpowers/specs/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect-design.md` (shapes, override table, `targetedAction` kind), #998 / `docs/superpowers/specs/2026-10-09-ai-actor-archetype-mythic-feat-actions-design.md` (audit and reviewed allowlist), #992 (closed-world state), #997.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#947's first slice covers nine classes. The remaining targeted/no-`selfEffect` feats fall in three groups: **kineticist impulses** (13), **caster-class feats** (cleric, wizard, sorcerer, druid, witch, oracle, inventor, psychic) and **ancestry, skill and general feats**. This spec brings all three groups in with the #998 approach: a generated, ranked audit; an owner-approved **allowlist**; recognition through #947's existing shapes only. Feats that need new state (kinetic aura/gate, pending spellshape) stay out until that state exists (filed as #1120).

## Investigation findings

- **Population.** Counts from #947: kineticist 13, cleric 4, inventor 3, druid 2, sorcerer 2, wizard 2, witch 1, oracle 1, psychic 1, and about 61 other (ancestry, skill, general, unclassed).
- **Impulse and spellshape feats.** Kineticist impulses are actions that usually produce an attack or save with a damage rider and depend on the kineticist's gate, element and aura. Spellshape feats (Shadow Spell, Contagious Spell) modify the next spell cast and carry the `spellshape` trait. Neither fits #947's shapes unless the text is self-contained.
- **Ancestry and skill feats** are mostly single-sentence targeted effects (Recollect Studies, Mesmerizing Gaze style) that the `targetEffect`, `skillCheckVsDc` and `targetSave` shapes can consume.
- **Same plumbing as #998.** The audit/allowlist/fixture-ratchet pattern needs no new vocabulary or executor code.

## Resolved decisions

1. **All three groups in scope**: kineticist impulses, caster-class feats, ancestry/skill/general feats.
2. **Reviewed allowlist via shapes** (as #998). Nothing the shapes cannot fully consume is offered.
3. **No new state tracking in this spec** — kinetic aura/gate and pending-spellshape tracking filed as #1120.
4. **Spellshape feats** are excluded from the allowlist until #1120 (they modify a following spell).

## Design

### Audit (`tools/audit-feat-population.mjs`)

Generalizes #998's `tools/audit-archetype-feats.mjs` to take a group (`kineticist`, `caster`, `ancestry-skill`). For each item it runs `parseTargetedFeat` and records shape, cost, range, parse outcome (`parses` / `partial` / `unsupported`) and a trait-based reason for exclusion (`spellshape`, `impulse-state`, `needs-state`). Output is a ranked report plus a fixture.

### Allowlist

`scripts/feat-action-allowlist.mjs` (from #998) gains `FEAT_ALLOWLIST` keyed by slug, partitioned by group. `parseTargetedFeat` accepts an item when its class trait is in `FEAT_ACTION_CLASS_SET` or its slug is in an allowlist. A test asserts each allowlist slug is `parses` in the fixture.

### Exclusion rules

Not offered even if allowlisted: `spellshape`-trait feats (until #1120); impulses whose text refers to the kinetic gate, a junction, an aura or "your kinetic aura"; any feat whose requirement is outside #934/#992's predicate set; ancestry feats needing a heritage, ancestry-specific resource (breath counters, etc.) the module does not track.

### Vocabulary and execution

Unchanged; allowlisted feats use the existing `targetedAction` entries and executors.

## Error handling

- Missing or unparsable allowlist slug: skipped, debug warning.
- Class-trait gate falls back to the allowlist; never both on a non-class feat.

## Testing

- **Audit:** per-group fixtures; deterministic ordering; reason codes.
- **Parser:** allowlisted feats parse; spellshape and aura-text feats rejected.
- **Vocabulary:** an allowlisted ancestry/skill feat is offered to an owning actor only.
- **Live verification:** an AI cleric/druid and an AI actor with an allowlisted ancestry feat use their feats against valid targets.

## Explicitly out of scope

- Kinetic aura/gate and pending-spellshape state — #1120.
- Non-allowlisted feats and wholesale parsing (rejected).

## Open questions

None. Planning-time details: allowlist contents per group (from the audit).
