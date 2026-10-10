# Advanced AI Characters: Champion Reactions With an Enemy Choice or an Ally Rescue

**Issue:** #1030 — champion reactions that need an enemy's choice or free an ally (Glimpse of Redemption, Iron Command, Liberating Step), deferred from #962.

**Builds on:** #962 / `docs/superpowers/specs/2026-10-09-ai-character-feat-reactions-design.md` (feat reactions for AI-controlled party characters, Retributive Strike, Flash of Grandeur, Champion's Resistance handling), #931 (registry, `resolveReactions`, `markReactionUsed`), #963 (interception hooks, `commitId`), #961, #915/#935 (saves, timed conditions), #932 (movement executor), #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Three champion reactions are not in #962's first slice because they depend on something other than the champion: **Glimpse of Redemption** and **Iron Command** make the *enemy* choose between two outcomes, and **Liberating Step** frees an ally and lets them move. This spec adds an **enemy-choice mechanism** (deterministic policy for AI enemies, a two-button chat card for human-controlled enemies, with the same policy as the fallback) and the ally-rescue effects.

## Investigation findings

From the compendium (`actions/class/champion/`).

- **Glimpse of Redemption** (champion, divine): trigger "an enemy damages your ally, and both are in your champion's aura". The enemy chooses **Repent** (the ally is unharmed by the triggering damage) or **Refuse** (the ally gains resistance to all damage against the triggering damage equal to `2 + level`, and after the damage is applied the enemy becomes Enfeebled 2 until the end of its next turn). A mindless enemy or one unable to repent uses Refuse. It links Champion's Resistance for the resistance.
- **Iron Command** (champion, divine, emotion, mental): trigger "an enemy in your champion's aura damages you". The enemy chooses **Kneel** (drops Prone as a free action) or **Refuse** (takes mental damage: `1d6` at level 1, `2d6` from 5, `3d6` from 9, `4d6` from 12, `5d6` from 16, `6d6` from 19). Either way, your Strikes against it deal extra spirit damage (1; 2 at 9th; 3 at 16th) until the end of your next turn (Champion's Extra Damage effect).
- **Liberating Step** (champion): trigger "an enemy damages, grabs or restrains your ally, and both are in your champion's aura". The ally is freed: if the trigger was damage, resistance `2 + level` (Champion's Resistance); the ally may attempt a new save against one grabbing/restraining/immobilizing/paralyzing effect that allows a save, or Escape from one effect as a free action; and if the ally can move, it may Step as a free action.
- **Existing machinery.** #962 already resolves champion reactions at the damage seam (#959/#963's `applyDamage` wrapper): trigger detection, the aura test, `markReactionUsed`, and Champion's Resistance application. Escape and Step executors exist (#911/#932), and #986 holds the grab state. The module can present a chat card with buttons and handle the click (as for other GM-confirm cards) and a timeout.
- **What's new.** Nothing in the module lets a *third party* pick an outcome; the interception mechanism changes damage synchronously, so the enemy's choice must be decided synchronously (policy) or asynchronously (card) with the damage held back.

## Resolved decisions

1. **Enemy choice by a deterministic policy** per option; the first resort for AI enemies, the fallback for everyone else.
2. **Human-controlled enemies get a two-button chat card**, with the deterministic policy applied after a timeout or in GM-less mode.
3. **Liberating Step frees the ally through existing executors**: Escape (free) or a new save, then a free Step; the resistance branch applies when the trigger was damage.
4. **RAW exceptions honored**: mindless/unable enemies always Refuse.

## Design

### Enemy-choice mechanism (`scripts/enemy-choice.mjs`)

```js
chooseEnemyOutcome({ reaction, enemy, champion, ally, options, context }) → { choice: "repent"|"refuse"|"kneel", source: "policy"|"player" }
```

- **Ability to repent:** `unableToChoose(enemy)` is true for mindless creatures (trait `mindless`), creatures with the `unconscious`, `paralyzed` or `dead` conditions, or constructs/oozes/vegetation without minds as determined by the trait set; the forced option is Refuse. Glimpse of Redemption states this rule; Iron Command is silent, so the module applies the same default (a creature that cannot choose takes the second listed option, Refuse) and documents it as an interpretation.
- **Deterministic policy (AI enemies):** pick the option with the lower *expected cost* to the enemy: Glimpse: Repent costs the enemy nothing but forfeits the damage (the ally unharmed); Refuse costs Enfeebled 2 for a turn and resistance for the ally. The policy compares: `valueOfDamage` (the triggering damage, capped by the ally's remaining HP) against `penaltyOfEnfeebled2` (a fixed score: 2 × the enemy's attack/DC dependence, simplified to 6 points); the enemy Repents when the damage it would forfeit is less than the penalty, else Refuses. Iron Command: Kneel costs an action-free Prone (a fixed score of 5, standing in for the lost positioning and attack penalties); Refuse costs the expected mental damage (`dice × 3.5`, halved if the enemy is mental-resistant, 0 if immune). Kneel when the mental damage is greater than the fixed score, else Refuse. Scores are constants in one table with comments for reviewers.
- **Human-controlled enemies (a player character or an owned token):** a chat card whispered to the controlling user(s) — "<Champion> invokes <reaction>! Choose: [Repent] [Refuse]". The damage that triggered the reaction is held (the intercepted flow marks the pending damage and applies it after the choice); a click resolves immediately; a timeout (default 30 s, a module setting) or GM-less mode applies the policy.
- **Result:** a typed object `{ choice, source }`, used by the effect appliers. Always announced publicly with the choice and its source ("<enemy> refuses" / "(auto)").

### Glimpse of Redemption

1. Eligibility (#962 gates): champion is agent-controlled, has the feat, reaction unused; the enemy damaged an ally; both within the champion's aura (aura radius from the champion's Aura feature, 15 ft base, 30 ft with Aura of Courage etc., read from the class feature rather than hardcoded).
2. `chooseEnemyOutcome`.
3. **Repent:** the triggering damage is negated for the ally (the intercepted damage amount set to 0 via the #963 wrapper; if it was already applied, healed back by the amount).
4. **Refuse:** the ally gains resistance to all damage equal to `2 + champion level` against the triggering damage (via Champion's Resistance as #962 applies it); after the damage applies, the enemy becomes Enfeebled 2 until the end of its next turn (#935's timed condition).
5. `markReactionUsed`, announce.

### Iron Command

1. Eligibility as above, with the enemy damaging the champion itself.
2. `chooseEnemyOutcome`.
3. **Kneel:** the enemy drops Prone (free action) via the condition helper. **Refuse:** deal the leveled mental damage to the enemy (a basic damage roll through `applyDamage`; no save).
4. Regardless, apply the Champion's Extra Damage effect (1 spirit damage, 2 at 9th, 3 at 16th) to the champion's Strikes against that enemy until the end of the champion's next turn (the linked effect from the compendium; an effect with a `TokenMark`-like targeting uses the enemy's token, otherwise a damage rule element predicated on `target:` being that creature is created with the existing helper).
5. `markReactionUsed`, announce.

### Liberating Step

1. Eligibility as above, with the trigger being the enemy damaging, grabbing or restraining the ally.
2. If the trigger was damage: Champion's Resistance for the ally as in #962.
3. **Freeing:** if the ally is Grabbed, Restrained, Immobilized or Paralyzed by an effect from the triggering enemy or any other source: pick the effect in this order — one that allows a saving throw (a new save), else the grab (Escape as a free action via the existing Escape executor); roll once; on success remove that one effect. The ally acts as an AI/NPC or character as the executor requires; for a human-controlled ally the card offers the options.
4. **Step:** if the ally can move afterward, it Steps as a free action via the movement executor, choosing the square that ends farthest from the triggering enemy within 5 ft (the "step away" policy), or stays if none.
5. `markReactionUsed`, announce.

### Reporting

All three report through #925's descriptor, with `reaction`, `choice` and `source` fields. The champion's reaction, the enemy's choice and the effect are one log record.

## Error handling

- Aura radius unreadable: reaction not offered.
- Choice card never answered / interrupted: policy fallback; damage held at most the timeout.
- Escape/save/Step failure: the reaction is still used; the failure is reported.
- Re-entrancy: a reaction caused by damage from a reaction does not trigger a further champion reaction (shared guard from #963).

## Testing

- **Enemy-choice:** unable-to-choose enemies Refuse; the policy table on fixtures (both options); human card timeout path; GM-less path.
- **Glimpse:** Repent negates the damage; Refuse gives resistance and Enfeebled 2; level scaling.
- **Iron Command:** Kneel/Refuse outcomes and damage dice per level; extra spirit damage by level; effect duration.
- **Liberating Step:** damage branch resistance; save-or-escape selection; Step policy; no-move case.
- **Interception:** damage held while a human choice is pending and then applied or negated.
- **Live verification:** an AI champion's ally is hit by a goblin: Glimpse resolves with the goblin's chosen outcome; a human-controlled enemy PC sees the choice card.

## Explicitly out of scope

- Other champion reactions (Retributive Strike, Flash of Grandeur are #962; other causes' reactions are #1031).
- Asking the reasoning pipeline to choose for enemies (rejected; deterministic policy only).

## Open questions

None. Planning-time details: the enemy-choice score constants and the champion aura radius source for each cause.
