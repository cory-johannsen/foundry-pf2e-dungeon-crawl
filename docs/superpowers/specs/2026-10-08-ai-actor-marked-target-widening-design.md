# Advanced AI Actors: Widening Marked-Target Self-Effect Feats

**Issue:** #946 — widen marked-target self-effect feats beyond Hunt Prey and Devise a Stratagem.

**Builds on:** #922 / `docs/superpowers/specs/2026-10-08-ai-actor-targeted-feat-actions-design.md` (the `targetedSelfEffect` vocabulary kind, target binding by pre-filling the `TokenMark` rule's `uuid`, one entry per legal target), #914 / `docs/superpowers/specs/2026-10-08-ai-actor-self-effect-widening-design.md` (derived effect-item eligibility filter, `effectSummary`, cap, agent-effect tagging and combat-end cleanup), #910's feat vocabulary and executor, #934's closed requirement-predicate set, and #909's `/v1/combat-candidates` pipeline.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-08 (see "Resolved decisions").

## Summary

#922 offers two marked-target feats (Hunt Prey, Devise a Stratagem) from an explicit allowlist, and #914's derived filter excludes every effect that contains a `TokenMark` or a `target:` predicate. This spec replaces both with a **derived, data-driven classification** of the one-action/free self-effect feats whose effect depends on a target, and offers two groups:

1. **Marked-target effects** — effects containing a `TokenMark`: the actor designates a creature and the effect's bonuses apply against it (Harsh Judgement, Duelist's Challenge, Smite, Size Up, Whispers of Weakness, Hunt the Razer's Pawn, Harvest Blood, ...). They use #922's one-entry-per-legal-target flow, with the `TokenMark` rule's `uuid` pre-filled so no prompt appears.
2. **Target-conditional self-effects** — effects whose rules only carry `target:` roll-option predicates (Point Blank Stance, Monastic Archer Stance, Spell Parry, Eye of the Arclords). The system evaluates those predicates on each roll, so these need **no chosen target**: they are ordinary #914 self-effects, wrongly excluded by #914's over-broad "target-dependent" rule.

Requirements are checked against #934's closed predicate set; a feat with any requirement outside that set is not offered. Everything else the 21-item population contains is deferred to filed follow-ups.

## Investigation findings

Confirmed against the live compendia (`pf2e.feats-srd`, `pf2e.actionspf2e`) and their linked effect packs, and #914/#922.

- **The population.** #914 counted 241 one-action/free items with a `selfEffect`, of which 21 carry a `TokenMark` rule or a `target:`/`@target` reference and were excluded. Those 21 are two different things.
- **Group 1: `TokenMark` effects — 13** (rule slug in parentheses): Harsh Judgement (`harsh-judgement`), Whispers of Weakness, Duelist's Challenge, Hungry Blade, Enforce Oath, Nothing Personal, Smite, Harvest Blood, Hunt the Razer's Pawn, Size Up, Unfazed Assessment (also a `ChoiceSet`), plus Hunt Prey and Devise a Stratagem (already #922). Their other rule elements are the bonuses themselves (`FlatModifier`, `AdjustModifier`, `DamageDice`, `TempHP`, `EphemeralEffect`) predicated on `target:mark:<slug>`; durations vary: unlimited (Harsh Judgement, Enforce Oath, Hunt Prey), until the encounter ends (Duelist's Challenge), rounds, minutes, hours or days (Hungry Blade 10 minutes, Nothing Personal 1 hour, Hunt the Razer's Pawn / Size Up 1 day).
- **Group 2: `target:` predicates without a `TokenMark` — 8**: Eye of the Arclords (`target:condition:hidden|undetected`), Spell Parry (`target:self`), Monastic Archer Stance and Point Blank Stance (`target:range-increment:…`, `target:distance`), Come and Get Me (`target:condition:off-guard`, also a `GrantItem`), Divine Weapon, Intensified Element Stance and Hunt Runelord (each also a `ChoiceSet`). **No effect uses an `@target` injected value**, only roll-option predicates: the system tests them against the *roll's* target at each roll, so the actor needs no pre-chosen target. The four without a `ChoiceSet`/`GrantItem` are clean: Eye of the Arclords, Spell Parry, Monastic Archer Stance, Point Blank Stance.
- **How a mark binds** (from #922): `TokenMarkRuleElement#preCreate` uses the rule's `uuid` if set, else the user's single target, else opens an interactive prompt; `beforePrepareData` records `synthetics.tokenMarks[tokenUuid]`; rolls against that token see `target:mark:<slug>`. The module's Strike roll already passes `target: { document: token }`, so the predicates resolve.
- **Requirements are common in group 1.** Examples: Enforce Oath ("you can see a creature you've sworn an oath against"), Nothing Personal ("an active course of action planned"), Hungry Blade ("your previous action was a Strike with your spectral dagger that dealt spirit damage"), Whispers of Weakness (target within 60 feet). Several need per-feature state the module does not track (#992); simple ones (target visible, enemy, within range) are checkable.
- **Mark lifecycle in the feats' own text.** Harsh Judgement: the creature is the "condemned foe until they are defeated, you use Harsh Judgment on a different creature, or the encounter ends"; Duelist's Challenge: the dueling opponent "until it's defeated, it flees from the encounter, or the encounter ends". The system's effect durations alone leave a mark pointing at a defeated token until it expires.
- **#914's exclusion rule is the cause of the group-2 miss:** its check (c) "TokenMark, a `target:` predicate or an `@target` reference" lumps roll-time predicates in with real target binding.

## Resolved decisions

1. **Both groups are in this issue:** marked-target effects and target-conditional self-effects. Devise's skill/defensive stratagems (#990) and effects with choices or granted items (#991) are deferred.
2. **Requirements: a closed set of checkable predicates (#934's set, plus "previous action was a Strike" from turn state if needed); feats with any other requirement are not offered.** Feats needing untracked state are #992.
3. **Mark lifecycle: the module removes tagged marks** when the marked creature is defeated or leaves, when the actor re-designates (a new mark of the same kind replaces the old), and at combat end, matching the feats' text.

## Design

### Classification (`classifyTargetEffect`, pure, in `scripts/agent-candidates.mjs`)

Given an effect source, returns one of:

- `none` — no target dependence; plain #914 self-effect.
- `targetConditional` — rule predicates contain `target:` roll options but **no** `TokenMark`, and there is no `@target` reference anywhere in the rules; plain #914 self-effect.
- `marked` — contains a `TokenMark` rule; needs a chosen target (#922 flow).
- `unsupported` — any `ChoiceSet`, `GrantItem`, an `@target` reference, or a `TokenMark` whose rule has no usable slug.

#914's filter (c) is replaced by this classification: `none` and `targetConditional` pass the target check; `marked` is routed to the #922 kind; `unsupported` is excluded. The other #914 gates (no-rules, hours/days duration, denylist, already-active, cost, frequency) are unchanged.

### Vocabulary

- **`targetConditional`:** offered as `kind: "selfEffect"` entries (#914), no target, with an `effectSummary` that names the condition ("+2 to attacks vs. targets within the first range increment").
- **`marked`:** offered as `kind: "targetedSelfEffect"` entries (#922), one per legal target: opposing combatants the actor can see (line of sight and detectability helpers, as #922), further filtered by the feat's own target constraint where it is a checkable predicate (enemy, within N feet; e.g. Whispers of Weakness within 60 ft). The entry's `effectSummary` is deterministic from the effect's rule keys plus the mark slug ("mark: +damage vs <name>, until defeated").
- **Requirement predicates:** each feat's `Requirements` text is evaluated with #934's closed predicate set (hand free, wielding/wearing, enemy within range/with condition, active-effect checks) extended with `previousActionWasStrike`; any other requirement text → not offered.
- **Replacement rule:** a marked feat is not offered for the creature it currently marks, and a new designation of the same feat replaces the old mark (the old effect is deleted first), as #922 does for Hunt Prey.
- The #914 cap and ranking apply across all self-effect entries; marked entries rank by target priority like Strike candidates.

### Reasoning call and validation

Unchanged from #922/#914: vocabulary entries are validated by literal membership on `(type, itemId, targetId?)`; picks become `feat:<itemId>[:<targetId>]` candidates appended before `/v1/combat-decision`. Strike candidate summaries against a marked creature keep #922's annotation so the model sees the intended follow-up.

### Execution

- `selfEffect` (target-conditional): #910/#914's self-effect path, unchanged.
- `targetedSelfEffect` (marked): #922's executor: clone the effect source, set the `TokenMark` rule's `uuid` to the chosen target token's UUID, merge origin context, create the effect, tag it `flags.pf2e-dungeon-crawl.agentSelfEffect = true`, delete a prior mark from the same feat first. No sub-choice handling is needed beyond what #922 already does for Devise.

### Mark lifecycle (new)

Agent-created mark effects carry two extra flags: `flags.pf2e-dungeon-crawl.markTargetTokenUuid` (the bound token) and the existing `agentSelfEffect` tag. A cleanup routine removes a tagged mark effect when:

1. the marked creature is **defeated** or removed from the combat (an `updateCombatant`/`deleteCombatant`/defeat handler, the same signals the combat code already uses for defeats);
2. the actor **re-designates** (handled at execution);
3. the **combat ends** (the #914 cleanup also removes tagged marks, including those with timed durations that would otherwise outlive the combat).

Because RAW also ends some marks when the creature "flees from the encounter", fleeing creatures count as removed when they leave the scene/combat.

## Error handling

- Classification or requirement parsing failure excludes the feat, never defaults it to eligible.
- Missing token UUID for a target, an effect source without a matching `TokenMark` rule, or an actor with no active token aborts before creating anything (an unbound effect would open the interactive prompt on an unattended client).
- A throwing effect creation leaves the action unspent and is logged and reported to the GM.
- A cleanup failure is logged and reported; it never blocks combat resolution.
- Reasoning-service failure → no new entries that turn; the existing candidate set proceeds.

## Testing

- **Classification (pure), real effect fixtures:** `marked` (Harsh Judgement, Smite), `targetConditional` (Point Blank Stance, Spell Parry), `unsupported` (Unfazed Assessment, Come and Get Me), `none` (a plain buff); #914's other gates still apply.
- **Data-driven audit:** a snapshot over the 21-item population asserting the group counts (13 marked incl. #922's two, 8 target-conditional, 4 clean target-conditional) and which are offered/not offered with the reason, so a compendium change is visible; also the ratchet for #990–#992 progress.
- **Requirement predicates:** each supported predicate; unknown requirement text → not offered; `previousActionWasStrike` from turn state.
- **Vocabulary:** per-target entries filtered by the feat's own range/visibility constraint, replacement rule, cap/ranking, target-conditional entries without targets.
- **Executor (mocked Foundry):** the `TokenMark` rule's `uuid` set to the chosen token; effect tagged with `markTargetTokenUuid`; prior mark deleted on re-designation; failure paths leave the action unspent.
- **Lifecycle:** mark removed on defeat/removal of the marked creature, on re-designation, and at combat end; unrelated effects untouched.
- **Live verification:** a champion AI with Smite/Enforce-style marks and a fighter AI with Point Blank Stance in a real fight; marks bind with no prompt, show the right bonuses against the target, and disappear when the target dies.

## Explicitly out of scope

- Devise a Stratagem's skill and defensive stratagems — #990.
- Effects with `ChoiceSet` or `GrantItem` (Unfazed Assessment, Hunt Runelord, Come and Get Me, Divine Weapon, Intensified Element Stance) — #991.
- Feats whose requirements need untracked state (sworn oaths, planned course of action, last-action damage type) — #992.
- Targeted feat actions without a `selfEffect` (#947) and NPC abilities (#915–#934).
- Prose interpretation by the reasoning model.

## Open questions

None; scope questions were resolved with the owner on 2026-10-08. Implementation details left to planning: the exact feat-by-feat audit result, whether the defeat handler reuses an existing combatant-defeat hook, and the per-feat range constraints extracted from requirement text.
