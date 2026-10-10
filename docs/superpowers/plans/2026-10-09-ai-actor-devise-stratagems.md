# Devise a Stratagem — Skill and Defensive Stratagems Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen the already-merged Devise a Stratagem support (#922) from the attack stratagem only to all three real stratagem modes (attack, skill, defensive), each a separate model-chosen candidate, enforcing the skill stratagem's "can't Strike" restriction and surfacing the Athletic Strategist and skill-check synergy as candidate annotations.

**Architecture:** Unlike every other plan in this issue arc, #990 patches REAL, merged code directly (#922 already shipped) — `scripts/targeted-feat-actions.mjs`, `scripts/dungeon-combat.mjs`, `scripts/agent-candidates.mjs`. Reading that real code found the selection-writing mechanism (`selectRollOptionSuboption`) is already fully generic and needs no change at all — the actual work is widening the vocabulary to offer three dynamic entries instead of one static one, and correcting a gate (`hasStratagemStrike`) that the real code currently applies to all of Devise a Stratagem but which, read against the real effect item's own rule predicates, only makes sense for the attack stratagem.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-actor-devise-stratagems-design.md`

## Global Constraints

- Bonuses come from the effect's own rule elements; the module never reimplements PF2e's numeric effects (spec's own resolved decision).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The selection-writing mechanism the spec describes as "the only new executor step" already exists, fully generic, and needs no change.** `selectRollOptionSuboption(effectSource, option, value)` (`scripts/targeted-feat-actions.mjs:71-80`, confirmed real and already exported) writes any suboption value onto the effect source's `RollOption` rule before creation — it is not hardcoded to `"attack"`. The only hardcoded thing is the static config `TARGETED_SELF_EFFECT_ALLOWLIST["devise-a-stratagem"].suboption.value = "attack"` (`scripts/targeted-feat-actions.mjs:39`) and its one caller, `executeTargetedSelfEffectFeat` (`scripts/dungeon-combat.mjs:7904-7906`), which always reads that static value instead of a per-candidate choice. Task 2 threads a dynamic `candidate.stratagem` through this one already-correct call rather than writing a new selection mechanism.
2. **`hasStratagemStrike`'s existing gate (`scripts/dungeon-combat.mjs:3537-3544, 3587`) is applied to all of Devise a Stratagem today, but the real effect item's own rule predicates show it should only gate the attack stratagem — a genuine correctness gap this plan fixes, not something the spec itself flags.** The real effect (`feat-effects/effect-devise-a-stratagem.json`) has exactly one rule needing "a Strike the d20 can apply to": the `strike-attack-roll` `SubstituteRoll`, predicated on `devise-a-stratagem:attack`. The skill `FlatModifier` (predicated on `devise-a-stratagem:skill`) and the defensive `FlatModifier` (predicated on `devise-a-stratagem:defensive`) have no such dependency at all — a character with no suitable Strike this turn should still be offered the skill or defensive stratagem. Task 1 applies `hasStratagemStrike` only when building the `attack` entry.
3. **Athletic Strategist's own maneuver substitution is not a fourth independent mode — it is a predicate-level consequence of choosing `attack`, confirmed by reading the real effect's second `SubstituteRoll` rule.** Its predicate array requires `devise-a-stratagem:attack` (not `skill` or `defensive`) alongside `feat:athletic-strategist` and one of the four maneuver actions — so the stored d20 only ever substitutes into a listed Athletics maneuver when the actor also chose the attack stratagem. Task 4's "(d20 replaces Athletics)" annotation is gated on `stratagem === "attack"` plus the feat, not on "an active effect on the marked target" generically as the spec's own looser wording could be read.
4. **A real `AdjustModifier` rule the spec's own Investigation findings never mention** (predicated on `devise-a-stratagem:skill`, `slug: "pursue-a-lead"`) adds +1 to the Investigator class's own separately-granted Pursue a Lead modifier when both are active. This needs no module code at all — it is pure system-side rule-element interaction, consistent with the spec's own "native effects only" decision — but is worth recording here so a later reader doesn't mistake its absence from the spec as this plan having missed something.
5. **The defensive bonus's asymmetric predicate (`origin:mark:devise-a-stratagem`, not `target:mark:...`) confirms no new roll-context wiring is needed for it.** AC and save rolls are evaluated with the attacker/effect-origin as context under PF2e's own standard convention, so once the marked creature attacks the stratagem-user, the system's own existing roll-option machinery (already in place for every other AC/save roll in this module) supplies `origin:mark:devise-a-stratagem` with no module change — unlike the attack/skill modes, which need this module's own `target:` context (already supplied for #909-driven actions).

## Review Focus

- The `attack`-only `hasStratagemStrike` gate (Investigation finding 2) must be verified with a real actor that has no agile/finesse/ranged Strike at all — the skill and defensive entries must still appear, and only the attack entry must be withheld (Task 1's test).
- A forged candidate pick naming a `stratagem` value the real effect's own `suboptions` don't contain (or `"defensive"` for an actor without the feat) must fail validation the same way an unknown `(itemId, targetId)` pair already does — never silently default to `"attack"` (spec's own stated rule; Task 2's test).
- The `stratagemNoStrike` restriction must be read fresh from the actor's own current turn-state flag at candidate-build time, not cached from when the skill stratagem was chosen — a restriction that outlives its own stated `until` marker (the combat moved on, the flag was never cleared due to an error) must not silently keep suppressing Strikes forever (spec's own stated "ignored if the combat has changed" rule; Task 3's test).
- The Athletic Strategist annotation (Investigation finding 3) must disappear the instant the active effect's own stratagem is anything other than `attack` — a stale "(d20 replaces Athletics)" label on a maneuver candidate after the actor devised a defensive or skill stratagem instead would mislead the reasoning model about what the roll will actually do (Task 4's test).
- `defensive`'s vocabulary gate (feat-only) must be re-checked at execution time too, not just at vocabulary-build time — a forged or stale pick for an actor that somehow lost the feat between the two must fail cleanly rather than create an effect whose defensive rule never fires for lack of the predicate (spec's own stated "forged pick fails literal membership validation" rule, extended to the execution side; Task 2's test).

---

### Task 1: Vocabulary — one entry per `(target, stratagem)`

**Files:**
- Modify: `scripts/targeted-feat-actions.mjs` (`TARGETED_SELF_EFFECT_ALLOWLIST`)
- Modify: `scripts/dungeon-combat.mjs` (`computeTargetedSelfEffectVocabularyEntries`, around line 3560)
- Test: `tests/targeted-feat-actions.test.mjs`, `tests/dungeon-combat-targeted-feat-vocabulary.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("TARGETED_SELF_EFFECT_ALLOWLIST devise-a-stratagem (#990)", () => {
  it("lists all three stratagems with the shared RollOption, defensive flagged as feat-gated", () => {
    const config = TARGETED_SELF_EFFECT_ALLOWLIST["devise-a-stratagem"];
    expect(config.stratagems).toEqual([
      { value: "attack", requiresFeat: null, requiresStrike: true },
      { value: "skill", requiresFeat: null, requiresStrike: false },
      { value: "defensive", requiresFeat: "defensive-stratagem", requiresStrike: false },
    ]);
  });
});

describe("computeTargetedSelfEffectVocabularyEntries, devise-a-stratagem (#990)", () => {
  it("offers all three entries for an actor with a qualifying Strike and the defensive feat", async () => {
    const actor = makeInvestigator({ hasQualifyingStrike: true, feats: ["defensive-stratagem"] });
    const entries = await computeTargetedSelfEffectVocabularyEntries(actor, [opponent()], 3);
    expect(entries.filter((e) => e.slug === "devise-a-stratagem").map((e) => e.stratagem).sort())
      .toEqual(["attack", "defensive", "skill"]);
  });

  it("withholds only the attack entry for an actor with no qualifying Strike (Investigation finding 2, Review Focus)", async () => {
    const actor = makeInvestigator({ hasQualifyingStrike: false, feats: ["defensive-stratagem"] });
    const entries = await computeTargetedSelfEffectVocabularyEntries(actor, [opponent()], 3);
    const stratagems = entries.filter((e) => e.slug === "devise-a-stratagem").map((e) => e.stratagem);
    expect(stratagems).not.toContain("attack");
    expect(stratagems).toEqual(expect.arrayContaining(["skill", "defensive"]));
  });

  it("withholds the defensive entry for an actor without the feat", async () => {
    const actor = makeInvestigator({ hasQualifyingStrike: true, feats: [] });
    const entries = await computeTargetedSelfEffectVocabularyEntries(actor, [opponent()], 3);
    expect(entries.filter((e) => e.slug === "devise-a-stratagem").map((e) => e.stratagem)).not.toContain("defensive");
  });

  it("gives each stratagem its own deterministic effectSummary", async () => { /* attack/skill/defensive summaries per the spec's own text */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/targeted-feat-actions.test.mjs tests/dungeon-combat-targeted-feat-vocabulary.test.mjs -t "devise-a-stratagem"`
Expected: FAIL (only one static entry is produced today)

- [ ] **Step 3: Implement.** Replace `suboption: {option, value}` on the `devise-a-stratagem` allowlist entry with `suboptionOption: "devise-a-stratagem"` plus `stratagems: [{value, requiresFeat, requiresStrike}, ...]` (shape above). In `computeTargetedSelfEffectVocabularyEntries`, for `devise-a-stratagem` specifically, loop the config's `stratagems` list instead of emitting one entry: skip a `requiresStrike` entry when `!hasStratagemStrike(actor)` (moving that check off the item-level `continue` at line 3587 and into this per-stratagem loop), skip a `requiresFeat` entry when the actor lacks that feat slug, and set each entry's own `stratagem` field and `effectSummary` (attack/skill/defensive text per the spec's own Design §Vocabulary).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/targeted-feat-actions.test.mjs tests/dungeon-combat-targeted-feat-vocabulary.test.mjs`
Expected: PASS, Hunt Prey's own existing entries and tests unchanged (its `stratagems` field stays absent/null, preserving today's single-entry behavior).

- [ ] **Step 5: Commit**

```bash
git add scripts/targeted-feat-actions.mjs scripts/dungeon-combat.mjs tests/targeted-feat-actions.test.mjs tests/dungeon-combat-targeted-feat-vocabulary.test.mjs
git commit -m "feat(#990): offer one Devise a Stratagem entry per (target, stratagem), gating attack on a qualifying Strike and defensive on the feat"
```

---

### Task 2: Thread the chosen stratagem through the candidate id and the executor

**Files:**
- Modify: `scripts/agent-candidates.mjs` (`buildFeatVocabulary`)
- Modify: `scripts/dungeon-combat.mjs` (the candidate-id assignment for feat vocabulary entries — locate its real call site first; `executeTargetedSelfEffectFeat`, `stratagemNoStrike` write)
- Test: `tests/agent-candidates.test.mjs`, `tests/dungeon-combat-targeted-feat-execution.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("buildFeatVocabulary carries stratagem through (#990)", () => {
  it("passes entry.stratagem onto the targetedSelfEffect vocabulary row when present", () => {
    const vocab = buildFeatVocabulary({ targetedSelfEffectEntries: [{ itemId: "i", slug: "devise-a-stratagem", name: "Devise a Stratagem", cost: 1, targetId: "t1", stratagem: "skill", effectSummary: "..." }] });
    expect(vocab[0]).toMatchObject({ stratagem: "skill" });
  });
  it("Hunt Prey's own entries (no stratagem field) are unaffected", () => { /* ... */ });
});

describe("executeTargetedSelfEffectFeat, devise-a-stratagem (#990)", () => {
  it("writes the candidate's own stratagem into the RollOption selection, not the static allowlist value (Investigation finding 1)", async () => {
    // candidate.stratagem === "skill" -> selectRollOptionSuboption called
    // with ("devise-a-stratagem", "skill"), not "attack".
  });
  it("re-validates a defensive pick against the actor's own current feats at execution time, failing cleanly if the feat is missing (Review Focus)", async () => { /* ... */ });
  it("records flags.pf2e-dungeon-crawl.stratagemNoStrike = {targetId, until} only for the skill stratagem", async () => { /* ... */ });
  it("fails without spending the action for an unrecognized stratagem value", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent-candidates.test.mjs tests/dungeon-combat-targeted-feat-execution.test.mjs -t "stratagem"`
Expected: FAIL (the static "attack" value is always used today)

- [ ] **Step 3: Implement.** `buildFeatVocabulary`'s `targetedSelfEffect` branch passes through `stratagem: entry.stratagem ?? null` alongside its existing fields. Confirm the real function that turns a feat-vocabulary row into a candidate with a string `id` (search for wherever `type: 'feat'` rows gain an `id` before reaching `applyAgentDecision`'s `candidates.find((c) => c.id === candidateId)`) and extend that id template to include `:${stratagem}` when present, so `(itemId, targetId, stratagem)` triples are each their own addressable candidate. In `executeTargetedSelfEffectFeat`, read `candidate.stratagem` (falling back to the allowlist's own single `suboption` for non-Devise actions like Hunt Prey, which has none), re-validate it against the effect's own real `suboptions` and, for `"defensive"`, against the actor's own current feats, before calling `selectRollOptionSuboption(bound, config.suboptionOption, candidate.stratagem)`. For `stratagem === "skill"`, after a successful effect creation, set `combatant.setFlag(MODULE_ID, "stratagemNoStrike", {targetId: candidate.targetId, until: <the actor's own next-turn marker, matching this file's existing turn-marker convention>})`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-candidates.test.mjs tests/dungeon-combat-targeted-feat-execution.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/agent-candidates.mjs scripts/dungeon-combat.mjs tests/agent-candidates.test.mjs tests/dungeon-combat-targeted-feat-execution.test.mjs
git commit -m "feat(#990): thread the chosen stratagem through the candidate id and the selection write; record the skill restriction"
```

---

### Task 3: Candidate filter for the skill stratagem's "can't Strike" restriction

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (wherever Strike/multi-strike/Strike-plus candidates are assembled for an actor's own turn)
- Test: `tests/dungeon-combat-targeted-feat-execution.test.mjs` (or a sibling focused on candidate filtering, matching this codebase's existing split)

- [ ] **Step 1: Write the failing tests**

```js
describe("stratagemNoStrike candidate filter (#990)", () => {
  it("drops every Strike/multi-strike/Strike-plus candidate against the restricted target", async () => { /* ... */ });
  it("leaves Strikes against OTHER targets, and every non-Strike candidate, untouched", async () => { /* ... */ });
  it("ignores a restriction flag whose until marker belongs to a combat that has since moved on (Review Focus)", async () => { /* ... */ });
  it("clears automatically once the actor's own next turn starts", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "stratagemNoStrike candidate filter"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, reading `combatant.getFlag(MODULE_ID, "stratagemNoStrike")` fresh at candidate-build time (never cached), checking its `until` marker against the combat's own current round/turn before trusting it, and filtering it into the same real candidate-assembly point #922's own existing Strike/maneuver candidate builders already pass through.

- [ ] **Step 4: Run the tests to verify they pass, then the full suite**

Run: `npx vitest run`
Expected: PASS, no regressions in Strike/maneuver candidate tests for an unrestricted actor.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-targeted-feat-execution.test.mjs
git commit -m "feat(#990): drop Strike-family candidates against a skill-stratagem-restricted target"
```

---

### Task 4: Synergy annotations

**Files:**
- Modify: `scripts/targeted-feat-actions.mjs` (or the real file building skill-check/maneuver candidate summaries — confirm during implementation)
- Test: `tests/agent-action-display.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("Devise a Stratagem synergy annotations (#990)", () => {
  it("adds '(+1 Devise a Stratagem)' to a Demoralize/Seek/Feint-style candidate against the marked target while the skill stratagem is active", () => { /* ... */ });
  it("adds '(d20 replaces Athletics)' to a Trip/Grapple/Shove/Disarm candidate only when the active stratagem is attack and the actor has Athletic Strategist (Investigation finding 3, Review Focus)", () => {
    // Active effect's own stratagem === "skill" or "defensive" -> no
    // annotation, even with the feat and the mark present.
  });
  it("omits both annotations once the skill stratagem's restriction/effect has expired", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent-action-display.test.mjs -t "Devise a Stratagem synergy"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, reading the active `devise-a-stratagem` effect's own current `selection` (not just its presence) before adding the Athletic Strategist annotation, per Investigation finding 3.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-action-display.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/targeted-feat-actions.mjs tests/agent-action-display.test.mjs
git commit -m "feat(#990): skill-check and Athletic Strategist synergy annotations, gated on the active stratagem choice"
```

---

### Task 5: Result descriptor, regression, and version bump

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`executeTargetedSelfEffectFeat`'s return/report shape)
- Modify: `module.json`

- [ ] **Step 1: Write the failing test**

```js
it("reports stratagem and targetId in the result descriptor (#990)", async () => { /* ... */ });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run -t "reports stratagem and targetId"`
Expected: FAIL

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the test, then the full suite**

Run: `npx vitest run`
Expected: PASS, including `tests/antagonize.test.mjs` and `tests/agent-service-candidate-generator.test.mjs`'s own existing `targetedSelfEffect` exclusions unchanged (they key off `type`/`kind`, not `stratagem`).

- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs module.json
git commit -m "feat(#990): report the chosen stratagem in the result descriptor; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** Vocabulary (Task 1), the selection write and skill restriction (Task 2), the Strike-filter enforcement (Task 3), synergy annotations including Athletic Strategist (Task 4), and the result descriptor/version bump (Task 5) each cover a spec section. Strategic Assessment (#1109) is explicitly excluded.

**2. Placeholder scan:** No "TBD"/"TODO". Task 2's own step explicitly flags one real call site ("the candidate-id assignment... locate its real call site first") as needing confirmation during implementation rather than guessing it — an honest deferral of a small, non-design-affecting detail, not a placeholder for the design itself.

**3. Type consistency:** The `stratagem` field introduced in Task 1's vocabulary entries flows unchanged through Task 2's `buildFeatVocabulary` pass-through, the candidate id, and `executeTargetedSelfEffectFeat`'s own read of it; Task 3's filter and Task 4's annotations both read the SAME `stratagemNoStrike` flag shape Task 2 writes.

**4. Review Focus:** All five bullets (attack-only Strike gating, forged-pick rejection, fresh-read restriction with a stale-combat guard, Athletic Strategist's attack-only annotation, execution-time feat re-validation) are each pinned to a named test in Tasks 1, 2, and 4.

**Corrections found while writing this plan:** the most consequential is Investigation finding 2 — `hasStratagemStrike`'s existing gate is applied to all of Devise a Stratagem today, but the real effect item's own rule predicates show it should only apply to the attack stratagem; left unfixed, widening the vocabulary as the spec describes would have silently withheld the skill and defensive stratagems from any actor without a qualifying Strike, exactly the kind of actor who'd most want the non-Strike options. The second is Investigation finding 1 — confirming the spec's own "the only new executor step is the selection write" undersells how much is already built: the generic, already-correct `selectRollOptionSuboption` function means this plan's real work is almost entirely about the vocabulary and candidate-id layer, not the effect-creation mechanism itself.
