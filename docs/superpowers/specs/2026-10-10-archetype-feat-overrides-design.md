# Advanced AI Actors: Override Entries for High-Value Archetype Feats

**Issue:** #1118 — hand-written reviewed override entries for archetype feats that #947's shapes do not parse, deferred from #998.

**Builds on:** #998 / `docs/superpowers/specs/2026-10-09-ai-actor-archetype-mythic-feat-actions-design.md` (the audit script, `ARCHETYPE_MYTHIC_ALLOWLIST`), #947 / `docs/superpowers/specs/2026-10-09-ai-actor-targeted-feat-actions-no-selfeffect-design.md` (shapes, `scripts/feat-action-overrides.mjs`, `explainTargetedFeat`), #1117 / `docs/superpowers/specs/2026-10-10-mythic-point-tracking-design.md` (`spendMythic`/`gainMythic`), #978 (the last-action record), #909 (skill-check candidates, Feint), #933 (Strike-plus execution, MAP), #932 (movement executors), #925 (result descriptor).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

#947's table of hand-written feat descriptors (`FEAT_ACTION_OVERRIDES`) ships **empty**, because every feat the shapes reject needs execution machinery that did not exist. This spec makes the table useful: it defines a **`sequence` shape** — an ordered list of steps drawn from a small **closed set of existing executors** — plus the DC, requirement and mythic-spend support such feats need, and then lets the owner approve a ranked list of archetype feats to author as override entries (candidates include Fated Duel, Scout's Charge and Imprison Foe).

## Investigation findings

- **The table is empty by design.** `scripts/feat-action-overrides.mjs` documents that the first-slice population had no feat the grammar misread but an existing executor could run; "an override without an executor able to act on it would be a descriptor nothing can run". Overrides take precedence over the parser inside `explainTargetedFeat` (`source: "override"`), and each must name the real item slug and be pinned by a fixture test against that item's own compendium text.
- **Real examples** (Archives of Nethys, Player Core 2 / War of Immortals):
  - *Scout's Charge* (Scout archetype, 2 actions, Flourish, level 4; requires Scout Dedication): Stride, Feint the chosen enemy (Stealth may replace Deception), then Strike it. A pure sequence of existing capabilities: movement (#932), Feint (#909), Strike (#933).
  - *Imprison Foe* (Archfiend archetype, mythic, 1 action, level 18): requirement "your last action dealt damage to a creature"; spend 1 Mythic Point; the creature attempts a Will save against your class DC or spell DC, whichever is higher; failure: transported into a cell in your extradimensional dungeon for 1 minute; success: Stunned 2; critical success: unaffected. Needs a last-action predicate (#978), a higher-of-two-DCs resolver, a mythic spend (#1117) and an approximated "removed from play" result.
  - *Fated Duel* is named in the issue; its text was not verified here, and the audit decides whether it is expressible.
- **Executors available to a sequence:** stride/step movement, skill-check actions (Feint, Demoralize, Bon Mot-style `skillCheckVsDc`), `strikePlus` Strikes with MAP, save-and-condition application (#915/#935), timed effect application, and #1117's mythic spend with refund.
- **The audit.** #998's audit already ranks archetype/mythic feats by cost, range and likely AI value and marks `parses` / `partial` / `unsupported`; the `partial` and `unsupported` rows are the override candidate pool.

## Resolved decisions

1. **The initial list is audit-ranked and owner-approved at planning time**: the planner proposes the top expressible entries (including the three named in the issue if they fit) and the owner approves the list before authoring.
2. **An override is a closed sequence of existing step kinds** (data, not code), each with parameters and a reviewer comment. No bespoke per-feat executor code.
3. **Unmodelable results use a per-entry opt-in "approximate" policy**: an entry may declare approximated pieces (for example remove a banished target from play for a duration plus a GM note); only reviewed entries get this; every unreviewed feat stays all-or-nothing.
4. **Extras in scope:** a higher-of-class-or-spell-DC resolver, last-action requirement predicates (via #978's record), and mythic point integration for point-spending overrides (via #1117). **Filed:** publishing the audit report as a docs file (#1229).

## Design

### The `sequence` shape (`scripts/feat-action-sequences.mjs`)

A new shape beside `strikePlus`, `skillCheckVsDc`, `targetSave` and `targetEffect`:

```
{ shape: "sequence",
  params: {
    steps: [ Step, ... ],
    requires?: Predicate[],     // see "Requirements"
    spend?: { mythic?: n },     // spent before the first step, refunded on early failure
    dc?: "class" | "spell" | "higherOfClassSpell" | number
  } }
```

`Step` is a closed discriminated union; each kind reuses an existing executor:

| `kind` | Parameters | Executor reused |
|---|---|---|
| `stride` | `toward: "target"`, `maxFeet?`, `endAdjacent?` | #932 movement (teleport-aware) |
| `skillCheck` | `skill`, `alternateSkill?`, `against: "perceptionDC" \| "dc"`, `onSuccess: ConditionBlock[]` | #909 skill-check actions |
| `strike` | `weaponRequirement?`, `mapIncrement?`, `extraDice?`, `onHit: ConditionBlock[]` | #933 Strike-plus execution |
| `save` | `save`, `dc`, per-degree `ConditionBlock` and `approximate?` | #915/#935 save and outcome helpers |
| `applyEffect` | `conditions[]`, `durationSeconds` | #935 `applyTimedCondition` |

A step that fails to start (no legal target, a failed requirement mid-sequence) aborts the sequence: later steps are skipped, `spend` is refunded if nothing resolved, and the action is not spent when no step ran; steps already resolved keep their effects (for example the Stride before a failed Feint). Each step's result is reported in the #925 descriptor.

### Requirements

`requires` extends #947's closed predicate set with: `lastActionDealtDamage` (from #978's last-action record: the previous action damaged a creature, optionally `target: "same"`), `lastActionWasStrike`, and the existing weapon requirement. Unknown requirement text still makes a feat not offered. Prerequisite feats (for example Scout Dedication) are the sheet's job (#998).

### DC resolver

`resolveFeatDC(actor, dcSpec)` returns the DC: `class` (the actor's class DC), `spell` (the highest spell DC from the actor's spellcasting entries), `higherOfClassSpell` (the higher of those two, falling back to whichever exists), or a fixed number. The result is recorded in the descriptor summary ("Will DC 41") for the reasoning model.

### Mythic spend

`spend: { mythic: n }` calls #1117's `canSpendMythic` when building the vocabulary (drop the feat when unaffordable) and `spendMythic` before the first step; a failure before any step resolves refunds with `gainMythic`. A sequence never spends points a second time.

### Approximated results (per-entry opt-in)

An entry may mark a `save`/`applyEffect` degree with `approximate: { kind, … }` from a closed list: `removeFromPlay` (hide the target token and mark it with a timed effect for the duration, restoring it afterward), `gmNote` (a whisper describing the unmodeled remainder). Imprison Foe's failure is `{ approximate: { kind: "removeFromPlay", durationSeconds: 60 }, gmNote: "Target transported to a cell in the actor's extradimensional dungeon for 1 minute." }`. The vocabulary summary marks approximated entries ("approximate: removed from play 1 min"). An entry without `approximate` follows the all-or-nothing rule.

### Authoring the entries

The planner runs the #998 audit, reads the `partial` and `unsupported` rows, and proposes the highest-value entries expressible with the step kinds above, with each row's reason for exclusion otherwise; the owner approves the list. Each approved entry is added to `FEAT_ACTION_OVERRIDES` as `{ shape: "sequence", params }` with a reviewer comment, its slug added to `ARCHETYPE_MYTHIC_ALLOWLIST` if not already present (an override is itself approval), and a fixture test pinning the descriptor to the item's compendium text. A feat whose text drifts from the fixture is disabled and reported.

### Vocabulary and execution

`explainTargetedFeat` already prefers overrides; the vocabulary builder gains the `sequence` case: one entry per legal target (the first step's target), with a deterministic summary generated from the steps ("Scout's Charge: Stride, Feint <name>, Strike <name>"). `applyAgentDecision` runs `sequence` steps through the existing executors in order, passing the target and shared state (the Feint outcome affects the Strike's off-guard condition through the normal condition, not through bespoke wiring).

## Error handling

- A drifted or unreadable item disables its override with a debug warning; the audit reports the row.
- An unknown step kind or malformed `params` fails validation at load: the entry is rejected with the slug in the message.
- A step failure follows the abort rules above; the action is never half-spent silently.
- A missing DC source (no class DC and no spellcasting) makes the feat not offered.
- Hooks and the sequence runner never throw into the combat turn.

## Testing

- **Schema/validation:** each step kind accepted, unknown kinds rejected, `approximate` only on allowed positions.
- **`resolveFeatDC`:** class, spell, higher-of, fixed, missing sources.
- **Requirements:** `lastActionDealtDamage` with and without the record, `lastActionWasStrike`, unknown text still not offered.
- **Sequence runner (mocked executors):** the Scout's Charge sequence runs Stride → Feint → Strike in order; an early abort skips later steps and refunds `spend`; partial resolution keeps resolved effects; result descriptor lists each step.
- **Mythic spend:** unaffordable drops the feat; spend before step one; refund on early failure.
- **Approximate results:** `removeFromPlay` hides and restores, the GM note whisper, summary marking; unapproximated entries stay all-or-nothing.
- **Fixture pins:** every override entry matches its item's compendium text; precedence over the parser; #910 composites unaffected.
- **Coverage audit with ratchet (as #947/#998):** a golden file of override entries and a monotonic count so changes show in PR diffs.
- **Live verification:** an AI scout using Scout's Charge against an enemy (Stride, Feint, Strike), an AI archfiend using Imprison Foe after damaging a creature with the point spent and the target removed for a minute, a requirement failure dropping the feat from the list.

## Explicitly out of scope

- Publishing the audit report as a docs file (#1229).
- Spellshape and kinetic state feats (#1120), mythic point tracking itself (#1117).
- Feats whose text needs a step kind not listed above; they stay out until a later spec adds the step.
- Prose interpretation by the reasoning model.

## Open questions

None blocking. Left to planning: the audit-ranked list for owner approval, the exact `ConditionBlock` and `extraDice` parameter shapes against the executors, and Fated Duel's expressibility once its text is checked.
