# Advanced AI Actors: Targeted Feat Actions Without a Self-Effect

**Issue:** #947 — targeted feat actions without a `selfEffect` (Exploit Vulnerability, Mark for Death, Demand Surrender, Bon Mot, Fated Duel, ...).

**Builds on:** #910 (feat vocabulary, executor, the four-entry composite table), #922 (targeted vocabulary entries with `targetId`), #933 (named Strike-plus shapes), #915 / #935 (save-ability parser, degree-outcome grammars, timed conditions and penalties, coverage ratchet), #909 / #940 (skill-check actions against a DC, maneuver MAP accounting), #934 (closed requirement-predicate set), and #909's `/v1/combat-candidates` pipeline.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-08 (see "Resolved decisions").

## Summary

#910 offers feats with a PF2e `selfEffect` plus four hand-written composite feats; #922 and #946 add marked-target self-effects. About **198** activatable feat and class actions that **target a creature** have **no `selfEffect`** and are never offered. They are heterogeneous, but they are not unstructured: they fall into four recurring shapes — a Strike with a rider, a skill check against a DC with degree outcomes, a saving throw with outcomes, and a plain effect applied to a target — each of which an earlier spec already models for another actor kind.

This spec offers these feats through the existing `feat` vocabulary type with a new kind `targetedAction`. A feat is recognized **by shape first**: a pure parser reuses the Strike-plus shapes (#933), the save and degree-outcome grammars (#915/#935) and the skill-check pattern (#909), and a **reviewed per-feat override table** covers high-value feats the shapes miss. The first slice is limited to nine classes (fighter, rogue, champion, swashbuckler, monk, ranger, barbarian, investigator, thaumaturge); everything else is filed as follow-ups. As elsewhere, a feat with any unmodeled text or requirement is **not offered** (all-or-nothing).

## Investigation findings

Confirmed against the live compendia (`pf2e.feats-srd`, `pf2e.actionspf2e`) and the earlier specs.

- **Population.** Counting one-, two-, three-action and free feats/actions with no `selfEffect` whose text designates a target creature (choose / select / designate / target a creature, foe or enemy): **198**. By shape: **Strike-plus 68**, **save-based 69**, **plain effect 57**, **damage-only 4** (by cost: 1-action 95, 2-action 87, 3-action 12, free 4). 151 are class feats, 22 are offensive/other actions, 10 ancestry, 8 skill.
- **By class trait** (first matching class trait): archetype 59, kineticist 13, mythic 9, rogue 7, magus 7, fighter 6, gunslinger 6, swashbuckler 4, cleric 4, inventor 3, monk 3, thaumaturge 2, druid 2, sorcerer 2, champion 2, wizard 2, investigator 2, witch 1, oracle 1, ranger 1, psychic 1, other (ancestry/skill/general and unclassed) 61. The nine first-slice classes together hold roughly **28** feats; 0 for barbarian in this pack sample.
- **Representative feats by shape** (read from the data).
  - *Strike-plus:* Felling Strike (fighter, 2 actions: Strike; on a hit that deals damage to a flying target, it falls), Dragging Strike and Revealing Stab and Brutish Shove (fighter), Mug and Coordinated Distraction (rogue), Targeting Finisher (swashbuckler finisher), Gruesome Strike (champion), Disrupt Qi and Flinging Blow (monk), Penetrating Shot (ranger), Connect the Dots (investigator), Twin Weakness (thaumaturge).
  - *Skill check vs a DC:* Bon Mot (Diplomacy against the target's Will DC, with degree outcomes), Exploit Vulnerability (thaumaturge, esoteric lore check).
  - *Save-based:* Predictable! and Sabotage (rogue), Leading Dance (swashbuckler), Explosive Death Drop (monk).
  - *Plain effect:* Instant Opening (rogue: "choose a target within 30 feet; it's off-guard until the start of your next turn"), The Bigger They Are and Person of Interest (swashbuckler, investigator), Devoted Guardian (champion), Shove Down (rogue, free).
- **Four earlier designs already cover the needed machinery.** #933's shapes (`strikeWithOnHit`, `strikeAgainstGrabbed`, extended-reach, multi-target) describe "a Strike with a rider"; #915/#935 give a save + per-degree outcome descriptor with conditions, penalties, durations and immunity and a timed-condition helper; #909/#940 give the skill-check-via-`game.pf2e.actions`-style roll with explicit modifiers, MAP accounting and degree reading; #922 gives per-target vocabulary entries and effect binding.
- **Feat-specific differences from NPC abilities.** The acting statistic and DC come from the character (class DC, skill modifier, "your Strike"), the Strike comes from the character's equipped weapons and must satisfy the feat's own requirement (a slashing weapon, a two-handed weapon, a thrown weapon), and many feats carry a `Requirements` block (previous action was a Strike, a flourish already used this turn, a certain weapon wielded). #934's closed predicate set covers wielding/wearing, hand free and enemy-in-range checks; some requirements need state the module does not track.
- **Traits drive turn rules.** `flourish` (once per turn), `finisher` (ends further attacks), `press` and `concentrate`/`manipulate` appear on many; once-per-turn flourish and the finisher "ends the turn's attacks" rules are PF2e RAW and must be tracked in per-turn state.

## Resolved decisions

1. **All four families are in the first slice:** Strike-plus feats, skill-check feats against a DC, save-based feats, and plain target-effect feats.
2. **Class set for the first slice:** fighter, rogue, champion, swashbuckler, plus monk, ranger, barbarian, investigator and thaumaturge. Magus and gunslinger (#997), archetype and mythic (#998) and kineticist, other casters, ancestry and skill feats (#999) are follow-ups.
3. **Recognition: shapes first, with a reviewed per-feat override table for the rest.** Anything not matched by a shape or an override is not offered.
4. **All-or-nothing**, as in #915/#932/#933/#934.

## Design

### Recognition (`scripts/feat-action-shapes.mjs`, pure)

`parseTargetedFeat(item, actor)` returns `null` or `{ shape, cost, frequency, traits, requirements[], params }`. Normalization follows #915/#933 (strip HTML, keep `@Damage`/`@Check`/`@Template`/`@UUID` links as tokens, split `Frequency`/`Requirements`/`Trigger` blocks). An item is considered only if its type is `feat` or `action`, its action type is `action` or `free`, it has no `selfEffect`, and one of its class traits is in `FEAT_ACTION_CLASS_SET` (the nine classes). Shapes:

1. **`strikePlus`** — "Make a Strike (with <weapon requirement>) … if it hits <rider>". Rider is one of #933's modeled shapes (on-hit condition with duration, extra damage, forced movement the module models, knocked prone, target falls if flying); params: `weaponRequirement`, `rider`, `attacks` (1 or more), `mapRule`. Reuses #933's shape parser, generalized so its input is any item description rather than only NPC abilities.
2. **`skillCheckVsDc`** — "<Skill> check against the target's <Will|Fortitude|Reflex|Perception> DC (or a standard DC)" with degree-of-success blocks parsed by #935's block grammar (conditions, penalties, immunity). Params: `statistic`, `dcSource`, `degrees`.
3. **`targetSave`** — the target attempts a save against the actor's class DC (or the feat's stated DC) with outcomes parsed by #935's block and inline grammars. Params: `save`, `dcSource`, `degrees`.
4. **`targetEffect`** — "Choose a target within N feet. It is <condition(s)> [for/until <duration>]" with no check; params: `rangeFeet`, `conditions[]`, `durationSeconds`.

A shape accepts the feat only if **every** sentence is consumed by its grammar. Traits impose rules rather than text: `flourish`, `finisher` and `press` are read from `traits` and enforced by the turn-state checks below.

**Requirement predicates** use #934's closed set, extended for feats: `wieldingTrait:<trait>` / `wieldingDamageType:<type>`, `handFree`, `twoHanded`, `previousActionWasStrike`, `enemyWithin`, `notUsedFlourishThisTurn`, `haveEffect:<slug>`. A requirement outside this set (Spellstrike charged, a sworn oath, a planned course of action) → not offered.

### The override table (`scripts/feat-action-overrides.mjs`)

Keyed by feat slug plus source book, a complete hand-written descriptor (`shape`, `params`) for feats the shapes miss or misread, for example a feat with an unusual targeting rule. Each entry has a reviewer comment and a fixture assertion that the override matches the item's text; an override replaces the shape result for that feat and the four #910 composite feats (Power Attack, Sudden Charge, Lunge, Twin Feint) stay in #910's table and take precedence over this parser.

### Vocabulary (`buildTargetedFeatVocabulary`, `scripts/agent-candidates.mjs`)

Called from `getPendingAgentTurn` beside `buildFeatVocabulary`. For each parsed feat on the acting character: apply #910's gates (cost vs actions remaining, `frequency.value > 0`, not on cooldown) and the trait rules (`flourish`: not already used this turn; `finisher`: the attack chain not yet ended); evaluate the requirement predicates; resolve the shape's legal targets (opponents within range with line of sight and detectability, or those in weapon reach for `strikePlus`, with the equipped weapon satisfying `weaponRequirement`). One entry per legal target:

```js
{ type: "feat", kind: "targetedAction", shape, itemId, slug, name, cost, targetId, summary }
```

with a deterministic `summary` ("Felling Strike: Strike Griffon; if it hits a flier, it falls"). The #914 per-turn cap applies across feat entries.

### Reasoning call, validation

As in #922: picks validated by literal membership on `(type, itemId, targetId)`; survivors become `feat:<itemId>:<targetId>` candidates appended before `/v1/combat-decision`.

### Execution (`applyAgentDecision`, `feat` branch, `kind: "targetedAction"`)

Common steps: spend the cost through `turnState` (and the flourish/finisher flags); decrement `system.frequency.value`; post the usage message (`item.toMessage()`); report through #925's result descriptor. Then per shape:

- **`strikePlus`:** pick the character's ready strike satisfying `weaponRequirement`, roll it through `rollAndApplyStrikeAtVariant` at the current MAP variant, apply the rider on a hit via #933's rider executors, advance `mapIncrement` per the shape's MAP rule.
- **`skillCheckVsDc`:** roll the actor's statistic against the target's DC with explicit modifiers (including #940's MAP modifier when the feat has the `attack` trait), read the degree, and apply the degree's conditions/penalties/immunity through #915/#935's helpers (`applyTimedCondition`, `applyTimedPenalty`, the immunity timestamp).
- **`targetSave`:** roll the target's save against the DC through the system (as #915, including the system's incapacitation handling when the trait is present), then apply the degree outcomes the same way.
- **`targetEffect`:** apply the stated conditions with durations through the timed-condition helper.

## Error handling

- Parsing never throws; an unmatched feat or any unconsumed sentence is `null` (not offered).
- A requirement that cannot be evaluated excludes the feat for that turn rather than defaulting it available.
- No ready strike satisfying `weaponRequirement` at execution time aborts before spending the action.
- A failing rider/condition/effect application is logged and reported to the GM; earlier results stay.
- Reasoning-service failure → no targeted feat entries that turn; the existing candidate set proceeds.

## Testing

- **Shape parsers (pure), real-text fixtures:** a Strike-plus feat (Felling Strike, Dragging Strike), a skill-check feat (Bon Mot), a save feat (Predictable!), a plain-effect feat (Instant Opening); feats that must return `null` (spellshape feats, Spell Swipe, a feat with an untracked requirement, an out-of-class-set feat).
- **Coverage audit with ratchet (as #935):** a golden file of every candidate feat in the first-slice class set with `{ feat, class, shape | override | notOffered, reason }` and a monotonic count test, so grammar changes and compendium changes show in PR diffs and coverage cannot silently drop.
- **Requirement predicates:** each supported predicate, unknown requirement text → not offered, `notUsedFlourishThisTurn` and finisher chain handling.
- **Vocabulary builder:** cost/frequency gates, trait rules, per-target legality (weapon requirement, range, line of sight), cap.
- **Executors (mocked Foundry):** each shape's roll/apply sequence, MAP/variant handling, flourish/finisher state, failure paths leaving the action unspent.
- **Override table:** every entry matches its fixture; override precedence over the parser; #910 composite feats unchanged.
- **Live verification:** a rogue (Instant Opening, Mug), a fighter (Felling Strike or Dragging Strike) and a swashbuckler (Targeting Finisher) AI in a real fight.

## Explicitly out of scope

- Magus and gunslinger feats — #997; archetype and mythic feats — #998; kineticist, other caster classes, ancestry, skill and general feats — #999.
- Feats with a `selfEffect` (#910/#914/#922/#946) and the four #910 composite feats.
- Spellshape and impulse feats that modify a following spell.
- Requirements needing untracked state (#992 for the marked-target family; the same tracking serves these).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-08. Implementation details left to planning: factoring #933's shape parser into an item-agnostic module shared by NPC abilities and feats, the exact grammars finalized against the fixture, the initial override list, and where a feat's DC (class DC vs stated DC) is read.
