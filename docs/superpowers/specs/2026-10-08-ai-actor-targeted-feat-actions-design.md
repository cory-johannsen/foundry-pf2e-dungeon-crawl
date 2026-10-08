# Advanced AI Actors: Marked-Target Feat Actions (Hunt Prey, Devise a Stratagem)

**Issue:** #922 — targeted feat actions for AI actors (Hunt Prey, Devise a Stratagem, etc.). This spec also absorbs #927 (marked-target self-effect feats), which was closed as merged into #922.

**Builds on:** #910 / `docs/superpowers/specs/2026-10-08-ai-actor-feat-actions-design.md` (feat vocabulary builder, `feat` execution branch, self-effect application), #914 / `docs/superpowers/specs/2026-10-08-ai-actor-self-effect-widening-design.md` (derived eligibility filter, cap, combat-end cleanup) and #909's `/v1/combat-candidates` pipeline.

**Status:** Approved. Scope was decided in a clarifying-question session with the owner on 2026-10-08 (see "Resolved decisions"). First slice: **Hunt Prey and Devise a Stratagem**.

## Summary

#910 and #914 model self-effect feat actions whose linked effect needs no target. Some of the best class actions — the ranger's Hunt Prey and the investigator's Devise a Stratagem — are also self-effect actions, but their effect is bound to a **chosen opposing creature** through the PF2e system's own `TokenMark` rule element. #910/#914 exclude them because choosing the creature is a decision the AI has not been able to make.

This spec adds a `targetedSelfEffect` kind to the #910 `feat` vocabulary. Foundry enumerates one entry per legal target creature; the #909 reasoning endpoint picks among them; execution creates the system's own effect item already bound to the chosen token, so the system — not the module — handles everything that happens afterwards: the Hunt Prey bonuses, and Devise a Stratagem's d20 substitution into the next Strike against the marked creature.

## Investigation findings

Confirmed against the installed PF2e system (`pf2e.mjs`, v8.5.0) and the local PF2e source data.

- **The premise of #922 is partly out of date.** The issue said these feats need a way to carry a bonus forward "to be read back by a later action" and that they do not fit the self-effect shape. In fact both actions carry a `system.selfEffect`, and the read-back is done by the system's own rule elements (below). What the module lacks is only the **target choice** and the **creation of the effect bound to that target**.
- **Hunt Prey** (`actions/class/ranger/hunt-prey.json`): one action, `selfEffect` set, no frequency. Its effect `Effect: Hunt Prey` has an unlimited duration and a single rule element `TokenMark` with slug `hunted-prey`; the bonuses themselves live on the action's own rule elements (`FlatModifier` ×2, `RollOption`) and are predicated on the mark.
- **Devise a Stratagem** (`actions/class/investigator/devise-a-stratagem.json`): one action, frequency once per round, `selfEffect` set. Its effect `Effect: Devise a Stratagem` has a duration of 1 round expiring at turn start, a **badge** `{ type: "formula", value: "1d20", evaluate: true }` (the d20 is rolled when the effect is created), and rule elements: `TokenMark` (slug `devise-a-stratagem`), a toggleable `RollOption` with **sub-options** `attack` / `skill` / `defensive`, and a `SubstituteRoll` predicated on `devise-a-stratagem:attack` and `target:mark:devise-a-stratagem` for the selector `strike-attack-roll`, with `removeAfterRoll`, whose value is `@item.badge.value`. So the next Strike against the marked creature automatically uses the stored d20 and the effect consumes itself.
- **How the system binds a target.** `TokenMarkRuleElement#preCreate` resolves the mark in this order: the rule's own `uuid` if already set; otherwise the current user's single targeted token; otherwise it opens an interactive `MarkTargetPrompt` and waits for a person. At `beforePrepareData` it records `synthetics.tokenMarks[tokenUuid] = [slug, ...]`, and rolls against that token see the predicate `target:mark:<slug>`. **Pre-filling the rule's `uuid` skips both the targeting dependency and the prompt**, which is what an unattended AI turn needs.
- **The module's Strike roll already supplies the target.** `rollAndApplyStrikeAtVariant` (`scripts/dungeon-combat.mjs`) rolls `variant.roll({ target: { document: target.token }, createMessage: true })`, so the system sees the target token and the `target:mark:*` predicate resolves; no change to the Strike path is needed for the d20 substitution to apply.
- **Frequency and activation.** `system.frequency` (`{ value, max, per }`) is already respected by #910's vocabulary gates; the system decrements it in its own use-action message (#910 mirrors this).
- **Scale of the family (live compendium, this world).** 241 one-action/free self-effect items exist (#914); about 21 of their effects carry `TokenMark` or an `@target` dependency. Separately, about 76 targeted feat actions have no `selfEffect` at all (a heterogeneous long tail: Demand Surrender, Bon Mot, Exploit Vulnerability, Mark for Death, ...), which is **not** this issue.

## Resolved decisions

1. **#927 is merged into #922.** This spec owns the marked-target self-effect family; #927 is closed as superseded. Widening beyond the first two feats is #946.
2. **Target binding: pre-fill the `TokenMark` rule's `uuid`** with the chosen target token's UUID on the effect source before creating it. System-native, no user-targeting dependency, no prompt.
3. **First slice: Hunt Prey and Devise a Stratagem only.** It proves the pattern, including Devise's sub-choice. Widening to the other TokenMark effects is #946.
4. **The long tail of targeted feat actions without a `selfEffect` is out of scope** (#947).

## Design

### Vocabulary (`buildFeatVocabulary`, #910 builder)

A new kind `targetedSelfEffect` for items that pass #910's gates (action type/cost/frequency/not-already-in-effect) **and** whose linked effect contains a `TokenMark` rule. For the first slice the item must be in an explicit allowlist (`hunt-prey`, `devise-a-stratagem`); #946 replaces the allowlist with the #914-style derived filter.

For each eligible item, one entry per legal target:

```
{ type: "feat", kind: "targetedSelfEffect", itemId, slug, name, cost, targetId, effectSummary, stratagem?: "attack" }
```

- **Legal targets:** opposing combatants. Hunt Prey: "you must be able to see or hear the prey" — a target the actor has line of sight to or can detect (reusing `hasLineOfSight`/`detectableOpponents`). Devise a Stratagem: "a creature you can see" — line of sight.
- **Devise's sub-choice is fixed to `attack`** in this slice (the stratagem the AI can use: it Strikes the chosen creature; the skill and defensive variants are #946). The entry carries `stratagem: "attack"`.
- **Already-in-effect rule:** Hunt Prey: RAW allows one prey at a time; if a Hunt Prey effect is already active, re-using it re-designates (the old effect is replaced) — the entry is offered only for a *different* target than the current mark. Devise a Stratagem: not offered while its effect is active (it also expires at turn start; frequency 1/round).
- `effectSummary` is deterministic: for Hunt Prey "mark prey: +bonuses vs <name>"; for Devise "d20 replaces next Strike vs <name>".

The shared #910/#914 cap on feat entries applies; targeted entries are ranked by target priority (the existing opponent ordering the strike candidates use).

### Reasoning call and validation

Unchanged from #910: picks are validated by literal membership on `(type, itemId, targetId)`; survivors become candidates `{ id: "feat:<itemId>:<targetId>", type: "feat", kind: "targetedSelfEffect", ... }` appended before `/v1/combat-decision`.

To let the existing Strike candidates exploit a mark, `buildStrikeCandidates`' summary for a target currently marked by one of the actor's marks gets a deterministic annotation ("marked: devise-a-stratagem, d20 = N" / "marked: hunted-prey"), derived from the actor's active effects whose `TokenMark` uuid equals the target token's UUID. The model therefore sees, on its next decision, that Striking the marked creature is the intended follow-up.

### Execution (`applyAgentDecision`, `feat` branch, `kind: "targetedSelfEffect"`)

1. Post the usage message via `item.toMessage()` and decrement `system.frequency.value` (as #910).
2. Load the effect source from `selfEffect.uuid` (`fromUuid`), clone it with `toObject()`.
3. **Bind the target:** find the rule whose `key === "TokenMark"` and `slug` matches, and set its `uuid` to the chosen target token's UUID.
4. **Devise a Stratagem only:** set the toggleable `RollOption` selection to `attack` on the effect source (the exact storage — the effect's `flags.pf2e.rulesSelections` entry for the `devise-a-stratagem` option, or the rule's `selection` field — is confirmed against the installed system during planning).
5. For **Hunt Prey**: if a prior Hunt Prey effect from this actor exists, delete it first (re-designation).
6. Merge the origin context (actor/token/item UUIDs, `getOriginData().rollOptions`) exactly as #910's self-effect path does, then create the effect on the actor. The system's own preCreate hooks run; because the `uuid` is set, no prompt appears. The effect's `1d20` badge evaluates at creation.
7. Tag the created effect `flags.pf2e-dungeon-crawl.agentSelfEffect = true` (#914): unlimited-duration effects (Hunt Prey) are removed at combat end by #914's cleanup; Devise's turn-start expiry is the system's own.
8. Spend the action cost through the existing `turnState` accounting and whisper the GM ("<actor> hunts <target>" / "<actor> devises a stratagem against <target> (d20 = N)").

Nothing about the later benefit is implemented here: the system applies the Hunt Prey bonuses and consumes Devise's d20 in the next Strike's attack roll through the effect's own rule elements.

## Error handling

- `selfEffect.uuid` unresolvable, the effect source has no matching `TokenMark` rule, or the target token UUID cannot be determined → the item is not offered; execution that hits one of these aborts before creating anything and reports to the GM (never creates an unbound effect, which would open the interactive prompt on the unattended client).
- A throwing effect creation leaves the action unspent (cost is deducted only after the effect exists) and is logged.
- `/v1/combat-candidates` failure/unconfigured → no targeted entries; the existing candidate set proceeds unchanged.
- An actor token that is not on the canvas (`getActiveTokens().length === 0`) makes the system ignore the `TokenMark` rule; such actors are excluded from the vocabulary.

## Testing

- **Vocabulary:** the allowlist gate; one entry per legal target; Hunt Prey excluded for the already-marked target and offered for another; Devise excluded while active or at frequency 0; no entry without line of sight; actors with no token excluded; cap/ordering.
- **Effect binding (pure over an effect source):** the `TokenMark` rule's `uuid` is set to the target; the original compendium source is not mutated; a source without the rule is rejected.
- **Executor (mocked Foundry):** frequency decrement, origin context, creation with the bound rule, prior Hunt Prey replaced, Devise `attack` selection applied, cost spent only after creation, GM whisper; failure paths leave the action unspent.
- **Strike-summary annotation:** a target marked by an active effect is annotated; unmarked targets are not.
- **Live verification:** a ranger AI Hunt Preys a monster (no prompt appears; bonuses show on Seek/Strike rolls vs. that monster); an investigator AI Devises a Stratagem and its next Strike against that creature uses the stored d20 and the effect disappears; both clean up at combat end / turn start as specified.

## Explicitly out of scope

- Widening to the other marked-target self-effects (Duelist's Challenge, Harsh Judgement, Come and Get Me, Enforce Oath, ...) and Devise's skill/defensive stratagems — #946.
- Targeted feat actions without a `selfEffect` (Exploit Vulnerability, Mark for Death, Demand Surrender, ...) — #947.
- Reimplementing any effect of the marks (bonuses, d20 substitution): always the system's rule elements.
- Reactions and spellshape feats (as in #910).

## Open questions

None; scope questions were resolved with the owner on 2026-10-08. Implementation details left to planning: the exact sub-choice storage for Devise's `attack` stratagem, how token UUIDs are obtained from combatants for the rule's `uuid`, and whether the Hunt Prey replacement should also clear the system's cached `tokenMarks` or rely on the effect deletion.
