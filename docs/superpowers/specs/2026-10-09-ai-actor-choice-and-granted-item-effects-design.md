# Advanced AI Actors: Self-Effects With Choices or Granted Items

**Issue:** #991 — marked-target and target-conditional effects with choices or granted items (Unfazed Assessment, Hunt Runelord, Come and Get Me, Divine Weapon, Intensified Element Stance), deferred from #946.

**Builds on:** #910/#914 (`feat` self-effect vocabulary, effect tagging, combat-end cleanup), #946 / `docs/superpowers/specs/2026-10-08-ai-actor-marked-target-widening-design.md` (marked-target and `target:` predicate widening), #922 (`targetedSelfEffect`), #990 (per-choice entries, the Devise precedent), #897 (`scripts/choice-set.mjs`, `resolveChoiceSetsOnItemData`).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#914/#946 exclude any effect with an unresolved `ChoiceSet` (creating it would open a blocking dialog) or a `GrantItem` (a second item the module does not track). Five known feat effects are therefore unavailable to AI actors. This spec brings all five in:

| Feat | Choice / grant | Kind |
|---|---|---|
| Unfazed Assessment | `ChoiceSet` bonus (1/2) + `TokenMark` | `targetedSelfEffect` |
| Hunt Runelord | `ChoiceSet` runelord school (7) | self effect, 1/day |
| Come and Get Me | `GrantItem` Off-Guard + `EphemeralEffect` | self effect |
| Divine Weapon | `ChoiceSet` owned equipped weapon | free action, 1/turn |
| Intensified Element Stance | `ChoiceSet` element, predicated on `prepare-elemental-medicine:*` | stance |

Legal choices become separate vocabulary entries and the model picks; the module pre-sets `flags.pf2e.rulesSelections.<flag>` on the effect source before creation so the system never prompts. Granted items are left to the system's own parent-deletion handling, with a combat-end sweep as a safety net.

## Investigation findings

- **ChoiceSet shapes.** `bonus` (Unfazed): static `[{value:2,crit success},{value:1,success}]`; the bonus is "+2 for a critical success, +1 for a success" of the Recall Knowledge that is the feat's prerequisite. Runelord school: static list of seven values (envy … wrath). Divine Weapon: `choices: { ownedItems: true, predicate: ["item:equipped"], types: ["weapon"] }` — resolved against the actor's equipped weapons. Intensified Element: five static choices, each carrying a `predicate` on `prepare-elemental-medicine:<element>` (earth/fire/metal/water/wood) that only the actor's own prepared medicine options satisfy.
- **#897 helper is random and static-only.** `resolveChoiceSetsOnItemData` picks uniformly from `choices` arrays and ignores `predicate` and the object-form (`ownedItems`) choices. It stays for generation-time items; AI feat effects need a different resolver.
- **GrantItem.** Come and Get Me grants `Compendium.pf2e.conditionitems.Item.Off-Guard` (`allowDuplicate: false`) and an `EphemeralEffect` bonus effect; the system's `GrantItem` deletes granted items when the granting effect is deleted (default `onDeleteActions`), and records `flags.pf2e.grantedBy` / `itemGrants`.
- **Existing gate.** `hasUnresolvedChoiceSet` (`scripts/dungeon-combat.mjs`) already excludes items whose rule lacks a selection; #914's eligibility filter excludes ChoiceSet/GrantItem effects outright.

## Resolved decisions

1. **The model chooses among legal options** (not random, not a module heuristic). Each legal choice is its own entry.
2. **Rule-determined choices are derived, not offered.** Divine Weapon's weapon must be the one the AI is about to use; Unfazed Assessment's bonus follows the Recall Knowledge degree.
3. **GrantItem: rely on the system's parent-deletion handling plus a combat-end sweep** that deletes any item whose `grantedBy` effect no longer exists.
4. **All five effects in scope.**
5. **No new gameplay rules.** All numbers come from the effects' own rule elements; the module only supplies the choice.

## Design

### Choice resolver (`scripts/feat-effect-choices.mjs`, pure)

`legalChoices(effectSource, actor) → [{ flag, options: [{ value, label }] }]` for each `ChoiceSet`:

- Static `choices`: filter by each choice's own `predicate` using the actor's roll options (Intensified Element: only elements the actor prepared).
- `ownedItems` choices: the actor's items matching `types`/`predicate` (equipped weapons).
- A ChoiceSet the resolver cannot interpret (unknown shape) marks the effect unsupported and the effect stays excluded.

The vocabulary multiplies entries by the product of choices, capped at 8 per feat; excess entries are dropped by a deterministic score (see below).

### Vocabulary

Add `choice` to the entry: `{ ..., choice: { flag, value, label } }`, id `feat:<itemId>[:<targetId>]:<flag>=<value>`. Per effect:

- **Hunt Runelord** (1/day): seven entries, one per school; `effectSummary` "Hunt Runelord (<school>): +2 Seek/Demoralize, extra damage vs frightened". Offered when a frightened or frightenable foe exists.
- **Intensified Element Stance:** one entry per prepared element; the stance rules from #914 (one stance at a time) still apply.
- **Divine Weapon:** one entry per equipped weapon, `free`, 1/turn; offered only when the actor has a Strike candidate with that weapon this turn.
- **Unfazed Assessment** (`targetedSelfEffect`): one entry per legal target; the `bonus` is derived from the last recorded Recall Knowledge result on that target (+2 critical success, +1 success). No recorded success → not offered.
- **Come and Get Me:** no choice; offered under the normal #914 gates, with a summary that names the downside (Off-Guard, damage bonus against it) so the model weighs it.

### Execution

Extends #914/#922's creation step: before `createEmbeddedDocuments`, write `flags.pf2e.rulesSelections[flag] = value` on the source and, for ownedItems choices, the weapon's item id (the form the system stores). Unfazed's TokenMark `uuid` is pre-filled as in #922. Because every ChoiceSet has a selection, the system raises no dialog. Failures (unresolvable choice at execution time) abort without spending the action.

### Granted items

- Come and Get Me's Off-Guard is created by the system when the effect is created and removed when it is deleted. The effect carries the #914 `agentSelfEffect` tag, so combat-end cleanup removes it.
- **Combat-end sweep:** after #914's cleanup, delete any item on a combat actor that has `flags.pf2e.grantedBy` pointing at an item id that no longer exists. It logs a debug line when it removes something.
- `allowDuplicate: false` plus the existing already-in-effect gate prevent stacking Off-Guard.

### Eligibility filter changes

#914/#946's rule (a) and (b) become: exclude when a ChoiceSet is uninterpretable, or when the effect has a `GrantItem` whose target is not a condition from the conditions compendium (only Off-Guard is audited here; other GrantItems stay excluded).

## Error handling

- Missing or changed compendium effect: entry not offered; stale pick fails literal membership validation.
- Divine Weapon weapon unequipped between candidate build and execution: abort, action unspent.
- Sweep errors never block combat end.

## Testing

- **Resolver:** static, predicate-filtered and ownedItems choices; unknown shape marks unsupported.
- **Vocabulary:** entries per choice with cap and ordering; derived Divine Weapon and Unfazed choices; gating.
- **Executor (mocked Foundry):** `rulesSelections` set before creation; no dialog path; abort paths; cost ordering.
- **Sweep:** orphaned granted item removed; live-parent item kept.
- **Audit test:** fixture of the five effects classified as supported; any other ChoiceSet/GrantItem effect still excluded.
- **Live verification:** an AI barbarian uses Come and Get Me and Off-Guard disappears at expiry/combat end; an AI cleric uses Divine Weapon on its equipped weapon; no choice dialog appears for any.

## Explicitly out of scope

- Random or heuristic choice resolution (rejected alternatives).
- ChoiceSet and GrantItem effects beyond these five (the other ~45 ChoiceSet effects) — a later audit would widen the resolver.

## Open questions

None. Planning-time details: where the Recall Knowledge result is recorded for the Unfazed bonus, and the exact score used to cap entries.
