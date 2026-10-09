# Advanced AI Actors: More Strike-Plus Shapes

**Issue:** #978 — more NPC strike-plus shapes (per-limb multi-target Strikes, area on-hit effects, self-buff riders, and the long tail), deferred from #933.

**Builds on:** #933 / `docs/superpowers/specs/2026-10-08-ai-npc-strike-plus-abilities-design.md` (the named-shape parser, the `npcStrike` vocabulary entry, the shape executors, grab-state tracking), #915 / `docs/superpowers/specs/2026-10-08-ai-npc-save-abilities-design.md` with #935 (save descriptors, degree outcomes, timed conditions and penalties, the coverage ratchet), #934 (self-effect application), #940 (explicit MAP modifiers) and the Strike primitives in `scripts/dungeon-combat.mjs` (`rollAndApplyStrikeAtVariant`, `castMultiStrikeBundleAndApply`, the per-turn state in `scripts/agent-candidates.mjs`).

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#933 offers a strike-plus NPC ability only when it matches one of seven named shapes completely. About 340 strike-related NPC abilities still fall outside them. This spec adds **five new shapes** and one piece of **new state**, keeping #933's rules (a pure parser per shape, all-or-nothing, a golden-file coverage ratchet):

1. **Last-action-gated follow-ups** — abilities whose requirement is "the creature's last action was a (successful) Strike (that dealt <type> damage)". Needs a **last-action record** in the per-turn state.
2. **Multi-Strike variants with penalties and different targets** — "N Strikes at a –P penalty, each against a different target", "two Strikes with different maws", with MAP rules and both-hit riders.
3. **Per-limb and each-creature Strikes** (the Thrash family) — "Strike each creature in its reach once; jaws once, stinger once, body any number of times."
4. **Strike plus area on-hit effect or save** — a Strike whose hit, or whose use, triggers an emanation save for other creatures (Wind Strike, Thundering Iron).
5. **Strike plus self-buff rider** — a Strike followed by a gained bonus or condition, including a restricted extra action (Quickened for Strike and Stride only).

Strike plus spell riders (#1047) and the remaining long tail (#1048) are filed as follow-ups.

## Investigation findings

Confirmed against the repo and the local PF2e source data (Monster Core 1–2, Bestiary 1–3).

- **Starting point (#933).** Seven shapes: strike against a grabbed creature, Constrict-like damage, extended reach, two-target Strikes, single-roll multi-AC, a multi-Strike bundle with a both-hit rider, and a Strike with an on-hit effect. A shape accepts an ability only if every sentence is consumed.
- **Population after #933** (active strike-related abilities that are not movement and not glossary riders, excluding Draconic Frenzy-form bundles the existing code covers): roughly **344**, of which about **81** are multi-Strike variants, **30** last-action-gated follow-ups, **12** Strike plus area on-hit effects, **9** per-limb/each-creature Strikes, **9** Strike plus spell riders, **7** Strike plus self-buff riders, **1** Strike plus heal, plus ~27 miscellaneous Strike-with-rider abilities and ~170 unclassified.
- **Representative texts** (from the data).
  - *Last-action follow-ups:* Spreading Flames (Living Wildfire) — Requirements: "last action was a Strike that dealt fire damage"; Choking Pain (Mummy Guardian) — "last action was a successful fist Strike"; Steal Shadow (Shadow) — "hit a living creature with a shadow hand Strike on its previous action".
  - *Multi-Strike variants:* Hungry Flurry (Giant Flytrap) — "four leaf Strikes at a –2 penalty, each against a different target; these attacks count toward the flytrap's multiple attack penalty …"; Pull Apart (Mukradi) — "two Strikes with different maws against the same target; if both hit, the target takes an extra [damage]"; Broad Swipe and Mangling Rend (already #933).
  - *Thrash family* (Benthic Worm, Mukradi, Magma Worm): "makes a Strike once against each creature in its reach. It can Strike up to once with its jaws, up to once with its stinger, and any number of times with its body. Each attack counts toward the multiple attack penalty, but the penalty doesn't increase until after it makes all the attacks."
  - *Strike plus area:* Wind Strike (Cloud Giant) — a ranseur Strike; "on a hit, the target takes an additional 4d8 bludgeoning damage and is Deafened for 1 minute. Whether or not the Strike hits, each non-cloud giant within a 20-foot emanation …" an area save; Thundering Iron (Mountain Oni) — a tetsubo Strike whose success affects a template; Flaming Stroke (Fire Giant) — a greatsword Strike at –2 against creatures in an area.
  - *Self-buff riders:* Suck Blood (Chupacabra) — "gains the Quickened condition for 1 minute and can use the extra action only for Strike and Stride actions"; Ramming Speed (Bottlenose Dolphin) — a distance-gated +1 circumstance bonus (a #972 charge clause); Sudden Retreat (Hippocampus) — a tail Strike, then a Swim, with a +2 circumstance bonus to AC.
- **The module has no record of what its previous action was.** The per-turn state (`initAgentTurnState`: `{ actionsRemaining, mapIncrement, maneuverPicks }`) tracks only the action budget and the MAP step; `applyAgentDecision` executes a candidate and updates those numbers. The result of the Strike (hit, degree, damage types, target) is available at the moment `rollAndApplyStrikeAtVariant` returns but is not kept.
- **#933's MAP mechanics already allow the penalty rules in the text** (both-count-then-increase, counts as N attacks) through the variant index and by controlling how far `mapIncrement` advances.
- **#935's helpers exist for the outcomes and buffs:** `applyTimedCondition`, `applyTimedPenalty` (a FlatModifier effect), the save/degree executor, and the descriptor/golden-file audit machinery.
- **An extra action with a restriction has no representation today**; `actionsRemaining` is a plain integer (`MAX_ACTIONS_PER_TURN`).

## Resolved decisions

1. **First slice:** last-action-gated follow-ups, multi-Strike variants with penalties and different targets, per-limb and each-creature Strikes, and Strike plus area on-hit effect or save.
2. **Strike plus self-buff riders are included now; Strike plus spell riders are #1047.**
3. **Recognition stays #933's:** named shapes, a pure parser per shape, all-or-nothing, a reviewed override table for exceptions, and the golden-file coverage ratchet from #935. The long tail is #1048.

## Design

### New state: the last-action record

`turnState` gains `lastAction`, written by `applyAgentDecision` after every executed candidate:

```js
lastAction: {
  type: "strike" | "multiStrike" | "npcStrike" | "cast" | "stride" | "maneuver" | "other",
  index: 0,                     // action number within the turn
  strike: {                     // present when the action involved Strikes
    limb, targetId, hit: boolean, degree, dealtDamage: boolean, damageTypes: ["fire", ...]
  } | null
}
```

- It reflects the **immediately preceding action in the same turn**; any later action overwrites it, and it is cleared when the turn state resets (turn start). A multi-Strike action records its final Strike's data plus `anyHit` / `allHit`.
- `strike.hit`, `degree`, `targetId` and `limb` come from `rollAndApplyStrikeAtVariant`'s result; `damageTypes` and `dealtDamage` come from the damage roll's context where it exposes them, with the weapon's base damage type as a fallback; planning confirms which source is reliable.
- It is stored in the same flag the turn state already uses, so no new persistence mechanism is needed.

### Shapes (extends `scripts/npc-strike-shapes.mjs`)

Each shape lists its recognition cue and parameters; the parser accepts the ability only if every sentence is consumed (and a Requirements clause outside the closed predicate set makes the ability `null`).

1. **`lastActionFollowUp`** — Requirements: "<creature>'s last action was a [successful] <limb> Strike [that dealt <type> damage | against a creature, object, or spell effect]" or "<creature> hit a <target type> with a <limb> Strike on its previous action". Predicates: `lastActionWasStrike`, `lastStrikeHit`, `lastStrikeLimb:<limb>`, `lastStrikeDamageType:<type>`, `lastStrikeTargetType`. Effects (all-or-nothing): (a) a **follow-up basic-save damage** (`@Damage` + `@Check[...|basic]`) against the creature struck, the creatures adjacent to it, or an emanation around the actor; (b) a save with outcomes (#915/#935 descriptor); (c) a timed condition on the struck creature. The follow-up's target comes from `lastAction.strike.targetId`.
2. **`multiStrikeVariant`** — "makes N <limb> Strikes [at a –P penalty] [each against a different target | against the same target | with different <limbs>]", an optional MAP sentence (`both-count-then-increase`, `counts as N`), and an optional all-hit rider (extra damage, condition, linked effect — #933's `bundleWithBothHitRider`, generalized). Params: `count`, `limbMode: "same" | "differentEach" | "any"`, `penalty`, `targetMode: "same" | "different"`, `mapRule`, `allHitRider?`.
3. **`eachInReach`** (the Thrash family) — "makes a Strike once against each creature in its reach. It can Strike up to once with <limb A>, up to once with <limb B>, and any number of times with <limb C>" plus the MAP sentence. Params: `perLimbMax: { <limb>: n | "any" }`, `mapRule`.
4. **`strikeWithAreaSave`** — a Strike clause (as #933's `strikeWithOnHit`) plus an area save: `@Template[emanation|burst|…|distance:N]`, `@Check[<save>|dc:N]`, subject filter ("each non-<ancestry> creature"), outcomes parsed by #935's block/inline grammars, centered on the actor or the target, applying whether or not the Strike hits (when the text says so). Params: `strike`, `onHit`, `area: { shape, distanceFeet, center }`, `save`, `dc`, `subjectFilter`, `degrees`.
5. **`strikePlusSelfBuff`** — a Strike (or follow-up) followed by a self effect: a numeric bonus ("a +2 circumstance bonus to AC [until …]"), a condition with a duration, or **Quickened with a restriction** ("can use the extra action only for Strike and Stride actions"). Params: `buff: { kind: "bonus" | "condition" | "extraAction", … }`, `duration`.

A sentence none of these shapes consume makes the ability `null`.

### Vocabulary (extends `buildNpcStrikeVocabulary`)

Same gates as #933 (cost vs actions remaining, `frequency.value`, recharge, limb resolution), plus per shape:

- `lastActionFollowUp`: offered only when `turnState.lastAction` satisfies every predicate; targets come from the record (the struck creature, creatures adjacent to it, or the actor's emanation).
- `multiStrikeVariant`: one entry per legal ordered set of distinct targets in reach (best-N by priority) when `targetMode` is `different`, or one per opponent when `same`; the penalty is part of the summary.
- `eachInReach`: one entry when at least one enemy is in reach; `summary` lists how many enemies would be Struck and with which limbs.
- `strikeWithAreaSave`: one entry per Strike target (and per candidate emanation center) ranked by enemies affected and allies spared.
- `strikePlusSelfBuff`: as the base Strike entries, with the buff in the summary.

The per-turn cap and ranking from #933 apply.

### Execution (extends `applyAgentDecision`'s `npcStrike` branch)

- **`lastActionFollowUp`:** re-check the predicates against the live `lastAction` at execution time (a stale record aborts without spending the action), then run the follow-up: basic-save damage through the save executor and `applyDamage` with degree multipliers, a save with outcomes through #915/#935, or a timed condition.
- **`multiStrikeVariant`:** roll each Strike through `rollAndApplyStrikeAtVariant` with the penalty as an explicit modifier, assigning distinct targets in priority order and distinct limbs per `limbMode`; apply the MAP rule by controlling the variant index and by how far `mapIncrement` advances; apply the all-hit rider only if every Strike hit.
- **`eachInReach`:** enumerate enemy creatures in reach (allies and neutrals are not Struck), assign limbs deterministically under `perLimbMax` (the capped limbs go to the highest-priority targets, the "any number" limb to the rest), roll all Strikes at the same variant index, and advance `mapIncrement` by the number of Strikes only afterward.
- **`strikeWithAreaSave`:** roll the Strike and apply its on-hit effects as #933; then compute the affected creatures from the template geometry (the same helper #915's area executor uses), exclude the subject filter's excluded creatures, roll each save, and apply outcomes/immunity through #915/#935.
- **`strikePlusSelfBuff`:** after the Strike, apply the buff: a bonus through #935's timed-effect helper (a `FlatModifier` effect), a condition through the timed-condition helper, or an **extra action**: `turnState.extraActions.push({ count: 1, restrictTo: ["strike", "stride"], expiresAt })`, which the candidate builder honors (below).

### Restricted extra actions (turn-state extension)

`turnState` gains `extraActions: [{ count, restrictTo?: string[], expiresAt }]`. `buildCandidateList` treats the sum of `extraActions` counts as additional actions that **only candidates whose type is in `restrictTo`** (or any type when absent) may spend; `applyAgentDecision` consumes a restricted extra action first when the chosen candidate's type permits it, otherwise a normal action. Quickened therefore adds exactly one extra action for Strike and Stride candidates; it lapses at `expiresAt` (end of the turn or the buff's duration, whichever is first). This is the only structural change to the turn state besides `lastAction`.

### Overrides, audit and ratchet

- A reviewed `NPC_STRIKE_OVERRIDES` table (keyed by ability name plus source, reviewer comment, fixture assertion) supplies hand-written descriptors for high-use abilities the shapes miss; an override replaces the parser result.
- The #935-style golden-file audit covers every strike-related ability instance with `{ creature, ability, shape | override | notOffered, reason }` and a monotonic count test, extended with the new shapes; it also reports unparsed reasons to prioritize #1047/#1048.

### Reporting

Each action reports through #925's result descriptor: per-Strike results, the follow-up outcome, the area save results, and the buff applied. A skipped or aborted step reports why (a stale last-action record, no targets in reach).

## Error handling

- Parsers never throw; an unmatched sentence or Requirements clause is `null` (not offered).
- A stale or missing `lastAction` makes follow-ups unavailable rather than assumed.
- A Strike that cannot be rolled (target defeated mid-sequence, limb unavailable) skips the remaining steps, reports the partial result, and still advances `mapIncrement` only by the Strikes actually made.
- A failing rider/area/buff application is logged and reported; earlier damage and effects stand.
- An `extraActions` entry whose expiry has passed is dropped before candidates are built; malformed entries are ignored.

## Testing

- **Shape parsers (pure), real-text fixtures:** each of the five shapes with the texts above (Spreading Flames, Choking Pain, Steal Shadow, Hungry Flurry, Pull Apart, Thrash, Wind Strike, Thundering Iron, Suck Blood, a +2 AC rider); texts that must return `null` (spell riders, an unrecognized Requirements clause, abilities with unconsumed sentences).
- **Last-action record:** written after strike, multi-strike, move and other actions with the right fields (including `anyHit`/`allHit`); overwritten by the next action; cleared at turn start; follow-ups offered only when every predicate holds and aborted when stale.
- **Executors (mocked Foundry):** distinct targets and limbs, penalties as explicit modifiers, MAP index and `mapIncrement` movement for each rule, per-limb caps and deterministic assignment for `eachInReach`, area membership and subject filters, all-hit riders only when every Strike hit, buff creation with durations.
- **Extra actions:** Quickened-restricted extra action spends only on Strike/Stride candidates, expires correctly, normal actions unaffected; candidate lists respect the restriction.
- **Coverage audit with ratchet:** the golden file and monotonic count over the strike-related fixture; a deliberate regression test proves a drop fails.
- **Regression:** #933's shape parsers and executors, the existing multi-strike bundle and Strike tests, #935's audit and `turnState` tests keep passing; abilities offered before remain offered with identical behavior.
- **Live verification:** a worm using Thrash against several party members, a flytrap with Hungry Flurry, a giant with Wind Strike, a monster using a last-action follow-up after a hit, and a chupacabra gaining its restricted Quickened extra action.

## Explicitly out of scope

- Strike plus spell riders (Dispelling Strike, Dimensional Ambush, Drain Magic) — #1047.
- The remaining long tail of strike-related abilities — #1048, and equipment-damage abilities — #979.
- Movement abilities with a Strike (#932/#972) and reactions (#931 and the reaction series).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-09. Implementation details left to planning: which source reliably gives a Strike's damage types for the last-action record, the exact grammars finalized against the fixture, the initial override list, and how the `extraActions` restriction is surfaced to the model in candidate summaries.
