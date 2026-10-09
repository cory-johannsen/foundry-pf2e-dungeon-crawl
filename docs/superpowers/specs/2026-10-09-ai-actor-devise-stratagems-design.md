# Advanced AI Actors: Devise a Stratagem — Skill and Defensive Stratagems

**Issue:** #990 — Devise a Stratagem skill and defensive stratagems, deferred from #946.

**Builds on:** #922 / `docs/superpowers/specs/2026-10-08-ai-actor-targeted-feat-actions-design.md` (the `targetedSelfEffect` kind, TokenMark `uuid` pre-fill, Devise limited to the attack stratagem), #946 / `docs/superpowers/specs/2026-10-08-ai-actor-marked-target-widening-design.md`, #909 (candidate/decision pipeline), #911/#940 (maneuvers), #914 (agent-effect tagging and combat-end cleanup), #925 (result descriptor).

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

#922 lets an AI investigator use Devise a Stratagem with the **attack** stratagem only: the d20 stored on the effect replaces the next Strike roll against the marked creature. PF2e's Devise a Stratagem has three modes on the same effect — attack, **skill** and (with the feat) **defensive**. This spec adds the other two and makes the choice between all three a model decision, expressed as separate candidates:

- **Skill stratagem** — the actor can't Strike the target until its next turn; it gets +1 circumstance to the next Int/Wis/Cha-based skill or Perception check about the target.
- **Defensive stratagem** (`feat:defensive-stratagem`) — +1 circumstance to AC and saves against the marked creature.
- **Athletic Strategist support** — a substituted d20 reaches Athletics maneuvers (Trip, Grapple, Shove, Disarm, ...) made against the marked creature.

The system's own rule elements do all of the numeric work. The module sets the stratagem choice, enforces the "can't Strike" restriction, and routes the marked target into maneuver and skill rolls.

## Investigation findings

- **One effect, three modes.** `Effect: Devise a Stratagem` (`feat-effects/effect-devise-a-stratagem.json`) contains the `TokenMark` (slug `devise-a-stratagem`), a toggleable `RollOption` whose `suboptions` are `attack`, `skill`, `defensive`, and rule elements predicated on `devise-a-stratagem:<choice>`: the Strike `SubstituteRoll` (attack), a `FlatModifier` +1 circumstance on skill/Perception selectors with `removeAfterRoll` (skill), and +1 circumstance to AC and saves predicated on the mark (defensive, only for actors with the feat).
- **Sub-choice storage.** `RollOptionRuleElement` keeps the choice in its `selection` field; the constructor resets `selection` to the first suboption (`attack`) when the stored value is not among the suboptions (`pf2e.mjs`, RollOption constructor). So the module sets `selection` on the effect **source's** rule (`system.rules[i].selection`) before `createEmbeddedDocuments`, and the choice survives the constructor check.
- **Existing hooks.** #922's executor already builds the effect source, pre-fills the TokenMark `uuid`, sets frequency and tags the effect (#914). The only new executor step is the selection write, plus a restriction record for the skill stratagem.
- **Athletic Strategist** (`feats/athletic-strategist.json`) adds, inside the effect's rules, an Athletics `SubstituteRoll` predicated on the feat and on the mark. It applies only when the maneuver roll carries the mark as its target context, which the module's maneuver executors (#909/#911/#940) must provide.
- **Strategic Assessment** is an informational GM note on a hit with a substituted Strike. It has no mechanical effect and is deferred.

## Resolved decisions

1. **Scope: skill stratagem, Athletic Strategist support, defensive stratagem.** Strategic Assessment (informational) is deferred to a follow-up (#1109).
2. **Separate candidates per stratagem per target.** Each (stratagem, target) pair is its own vocabulary entry; the model chooses. Defensive entries exist only if the actor has `defensive-stratagem`.
3. **Hard filter for the skill stratagem.** While the restriction is active, all Strike, multi-strike and Strike-plus candidates against the stratagem target are removed from candidate lists. This enforces the RAW restriction without relying on the model.
4. **Native effects only.** Bonuses come from the effect's rule elements. The module does not reimplement them.
5. **Frequency and d20 unchanged.** Once per round; the badge `1d20` is rolled at creation for every mode (the system rolls it regardless).

## Design

### Vocabulary (`scripts/agent-candidates.mjs`)

Extend #922's entry:

```js
{ type: "feat", kind: "targetedSelfEffect", itemId, slug: "devise-a-stratagem", name, cost: 1,
  targetId, stratagem: "attack" | "skill" | "defensive", effectSummary }
```

- Legal targets and gates are unchanged from #922 (line of sight, not already active, frequency available).
- One entry per `(targetId, stratagem)`. `skill` and `attack` are always offered; `defensive` only with `defensive-stratagem`.
- `effectSummary` is deterministic: attack "d20 replaces next Strike vs <name>"; skill "+1 to next skill check vs <name>, can't Strike it this turn"; defensive "+1 AC/saves vs <name>".
- Candidate ids: `feat:devise-a-stratagem:<targetId>:<stratagem>`. Picks are validated by literal membership on `(type, itemId, targetId, stratagem)`.

### Execution (`applyAgentDecision`, `targetedSelfEffect`)

Replaces #922 step 4: write the chosen `stratagem` into the `selection` of the `devise-a-stratagem` RollOption rule on the effect source, then create the effect. If the rule is not found, fail the action without spending it (#922 failure path).

For `skill`, additionally record the restriction on the actor's turn state: `flags.pf2e-dungeon-crawl.stratagemNoStrike = { targetId, until: <actor's next turn start> }`, cleared at that turn start and by #914's combat-end cleanup.

### Candidate filter (`strike` family)

When building candidates for the actor, if `stratagemNoStrike` is active, drop every `strike`, multi-strike and Strike-plus candidate whose `targetId` equals the restricted target. Other candidates (maneuvers, spells, Demoralize, movement) are unaffected.

### Skill-check follow-up

- **Synergy annotations.** Candidate summaries for Demoralize, Seek, Feint and similar skill/Perception actions against the marked target gain "(+1 Devise a Stratagem)" while the skill stratagem is active, so the model can see the payoff.
- The bonus itself is applied by the system when the module rolls these checks with the marked target in context. Rolls keep passing the target token as the `target` roll context (already the case for #909 actions). `removeAfterRoll` consumes the bonus.

### Athletic Strategist

With the feat and an active effect on the marked target, maneuver executors (#911/#940) pass the target in the roll context so `target:mark:devise-a-stratagem` is true and the effect's Athletics `SubstituteRoll` applies. Maneuver candidate summaries add "(d20 replaces Athletics)" when applicable. The effect consumes the substitution itself.

### Result descriptor (#925)

The executor reports `stratagem` and `targetId` in the result so the log line reads "devises a defensive stratagem against <name>".

## Error handling

- Missing RollOption rule or unknown suboption: action fails, cost and frequency unspent, GM whisper.
- Restriction flag survives a stale actor: it carries an explicit `until` turn marker and is ignored if the combat has changed.
- Actor lacks `defensive-stratagem`: no defensive entry; a forged pick fails literal membership validation.
- Target removed from combat before the next turn: restriction is moot and cleared.

## Testing

- **Vocabulary:** one entry per stratagem per target; defensive gated by feat; unchanged gates; ids and validation.
- **Executor (mocked Foundry):** selection written per stratagem; restriction set only for skill; failure paths; cost ordering.
- **Candidate filter:** Strikes against the restricted target removed, other targets and non-Strike actions kept; filter clears at next turn.
- **Annotations:** Demoralize/Seek/Feint and maneuver summaries appear only when applicable.
- **Live verification:** an AI investigator uses each stratagem; skill: no Strike offered against the target and the next Demoralize shows +1 which is then consumed; defensive: AC/saves show +1 vs the target; Athletic Strategist: a Trip uses the stored d20.

## Explicitly out of scope

- Strategic Assessment informational note on a substituted Strike hit — #1109.
- Devise a Stratagem for human players (the prompt is theirs).
- Other marked-target feats (covered by #946).

## Open questions

None. Planning-time details: the exact turn marker for `until`, and where maneuver roll contexts are assembled.
