# Corpse-Based NPC Abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give defeated NPCs a corpse record (death time on the game clock, position, creature data, a consumed-by set) and a new `corpse` family of `npcSelf` entries so a ghoul can use Consume Flesh and a ghonhatine can use Feed on an adjacent, recently-dead corpse.

**Architecture:** A token-flag corpse record, written once at the module's single real defeat seam. A pure query module (`scripts/corpses.mjs`) for adjacency/age/consumed-state. A `corpse` family patched into #934's still-plan-only `parseSelfAbility`/`buildNpcSelfVocabulary`/`applyAgentDecision`. Live verification against the real compendium found a genuine gap in #934's own `selfHeal` grammar (Investigation finding 2) that this plan patches as part of Task 1, since Consume Flesh — this issue's own flagship example — is itself a `selfHeal` ability whose real formula that grammar currently rejects.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-corpse-abilities-design.md`

## Global Constraints

- **#934 is still plan-only.** Tasks 1 and 4-6 patch that plan document directly.
- All-or-nothing recognition, unchanged: an unmatched sentence makes the whole ability `null`.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The real defeat seam is a single function, simpler than the spec assumed.** The spec describes "the defeat seam... and a fallback `updateCombatant` handler... the same pairing #959 uses." Reading the real, merged code (`scripts/dungeon-combat.mjs:3619-3630`, `applyDefeatIfReducedToZero`) shows the fallback (`autoDefeatZeroHpNpcs`, registered on `updateActor`, `scripts/dungeon-combat.mjs:913-929`) itself calls `applyDefeatIfReducedToZero(combatant)` for every zero-HP NPC combatant — it does not duplicate the defeat logic. Both the module's own strike-resolution path and the system-applied-damage fallback already funnel through this one function's NPC branch (`else if (!target.isDefeated) { await target.toggleDefeated(); playCreatureDeathSound(); }`). The corpse record is written there, once, with no second hook to register.
2. **Confirmed live: #934's own `selfHeal` grammar rejects Consume Flesh's real healing formula — a gap in the plan this issue's own flagship example depends on.** The spec quotes Consume Flesh's effect as "regains `@Damage[2d6[healing]]` Hit Points" but the real item text (`pf2e-data/packs/pf2e/bestiary-family-ability-glossary/ghoul/ghoul-consume-flesh.json`) is level-scaled: `@Damage[(1+(max(0,floor(@actor.level/2))))d6[healing]]` ("regains that much Hit Points plus 1d6 for every 2 levels it has"). Running #934's own plan-only regex against this real string confirms it fails both the negative-lookahead guard and the capture group (nested parentheses from `max(0,floor(...))` break `\([^)]*\)`, which only matches up to the first inner `)`) — the ability would silently return `null` under #934's plan exactly as written. Separately, #934's own `executeSelfHeal` (`new Roll(descriptor.params.formula).evaluate()`) never passes `rollData`, so even a correctly-extracted formula containing `@actor.level` would evaluate with that path unresolved. Task 1 patches both: the parser switches from a paren-counting regex to a bracket-depth scan over `@Damage[...]`'s own `[`/`]` nesting (the formula's internal parentheses are irrelevant to that scan, however deep), and the executor passes `actor.getRollData()`.
3. **Feed (ghonhatine) matches the spec's own quoted text exactly** (`pathfinder-bestiary-2/ghonhatine.json`) — a clean, accurate `corpse` buff example needing no correction.
4. **The loot conversion really does repoint the same token document**, confirmed at `scripts/dungeon-combat.mjs:789` (`combatant.token.update({ actorId: lootActor.id, actorLink: true })`) — a token flag written before this call is read unchanged afterward, grounding the spec's "survives loot conversion" design claim directly rather than by inference.

## Review Focus

- A corpse record must never be written for a party character, even one that somehow enters the NPC defeat branch — `applyDefeatIfReducedToZero`'s own existing `target.actor?.type === "character"` branch must stay the character path's exit, untouched by the new corpse-writing code (spec's own stated rule; Task 2's test).
- Consume Flesh's real, level-scaled formula must heal a 10th-level ghoul variant for more than its flat 1-20 cap would suggest at a glance — a regression that silently truncates the formula (e.g. keeping the old paren-counting regex as a fallback) must be caught by asserting the full extracted string, not just that *a* formula was extracted (Investigation finding 2; Task 1's test).
- A corpse already consumed by a *different* eater, or by this same eater for a *different* ability, must still be offered — `oncePerCorpse` is scoped per `(eaterUuid, abilitySlug)`, not globally per corpse (spec's own stated rule; Task 3's test).
- A corpse whose age sits exactly on the boundary ("within the last hour") must be evaluated with a closed, not open, interval — an off-by-one here is the kind of boundary bug that passes every hand-written test except the one at the exact limit (Task 3's test).
- The vocabulary and executor must each independently re-read `game.time.worldTime` rather than share one cached value across a multi-corpse turn — time advances during a long agent turn (travel, multiple actions), and a corpse eligible when the vocabulary was built can age out before execution (spec's own stated rule; Task 6's test).

---

### Task 1: Patch #934's `selfHeal` grammar for dynamic formulas

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md`
- Test: that plan's own `npc-self-parse.mjs` test file and executor test file

- [ ] **Step 1: Write the failing tests**

```js
describe("selfHeal with a dynamic, level-scaled formula (#982)", () => {
  it("extracts Consume Flesh's real formula despite nested parentheses", () => {
    const item = makeSelfItem(
      "<p><strong>Requirements</strong> The ghoul is adjacent to the corpse of a creature that died within the last hour.</p><hr /><p><strong>Effect</strong> The ghoul devours a chunk of the corpse and regains @Damage[(1+(max(0,floor(@actor.level/2))))d6[healing]] Hit Points plus 1d6 for every 2 levels it has.</p><p>It can regain Hit Points from any given corpse only once.</p>"
    );
    // Task 4 recognizes the corpseNear requirement and oncePerCorpse rider;
    // this test only exercises the formula extraction, so stub those two
    // clauses as already consumed via the shared test harness's
    // `knownClauses` option (see that file's existing helpers).
    const parsed = parseSelfAbility(item, { knownClauses: ["corpseNear", "oncePerCorpse"] });
    expect(parsed.params.formula).toBe("(1+(max(0,floor(@actor.level/2))))d6");
  });
});

describe("executeSelfHeal with rollData (#982)", () => {
  it("resolves @actor.level against the acting actor's own roll data", async () => {
    const actor = { level: 7, getRollData: () => ({ actor: { level: 7 } }), applyDamage: vi.fn() };
    const combatant = { actor, token: {} };
    const descriptor = { family: "selfHeal", params: { formula: "(1+(max(0,floor(@actor.level/2))))d6" }, crossRecharge: null };
    await executeSelfHeal(combatant, { ...descriptor, itemId: "x" });
    const [[arg]] = actor.applyDamage.mock.calls;
    expect(arg.damage).toBeLessThanOrEqual(-4 * 1); // 4d6 at worst-case min roll (1+floor(7/2)=4 dice)
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "selfHeal with a dynamic"`
Expected: FAIL (current regex returns `null`/wrong formula; current executor ignores rollData)

- [ ] **Step 3: Implement.** Replace the paren-counting regex (the negative-lookahead guard and the capture group) with a bracket-depth scan: from each `@Damage[` index, walk forward counting `[`/`+1` and `]`/`-1` starting at depth 1, stop at depth 0; the enricher's full argument is the text between the brackets. Within that argument, split off the trailing `[healing]` tag (itself one `[`/`]` pair at the end) to recover the pure formula string — this never inspects the formula's own parentheses, so arbitrary nesting (`max(...)`, `floor(...)`, `@actor.level`) is irrelevant to the scan. In `executeSelfHeal`, call `new Roll(descriptor.params.formula, combatant.actor.getRollData()).evaluate()`.

- [ ] **Step 4: Run the tests to verify they pass, then run the full `selfHeal` suite for regressions**

Run: `npx vitest run docs/superpowers/plans -t "selfHeal"` *(adjust to wherever #934's own test file lives once Task 4 locates it)*, and the full `npc-self-parse` suite.
Expected: PASS, including the existing flat-formula fixtures (`2d4`, `2d8+10`, `20`) unchanged.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md
git commit -m "docs(#982): amend #934's plan -- bracket-depth formula extraction + rollData for selfHeal"
```

---

### Task 2: The corpse record

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`applyDefeatIfReducedToZero`, around line 3619)
- Test: `tests/dungeon-combat.corpse-record.test.mjs` (new)

**Interfaces:**
- Produces: `writeCorpseRecord(combatant)` (exported from `dungeon-combat.mjs`) — idempotent, no-op if `token.getFlag("pf2e-dungeon-crawl", "corpse")` already set.

- [ ] **Step 1: Write the failing tests**

```js
describe("writeCorpseRecord (#982)", () => {
  it("writes a record on a newly-defeated NPC's token with death time, position, and creature data", async () => {
    const setFlag = vi.fn();
    const combatant = {
      actor: { type: "npc", name: "Goblin Warrior", level: 1, system: { details: { level: { value: 1 } } }, traits: ["goblin", "humanoid"] },
      token: { x: 1200, y: 1500, getFlag: () => undefined, setFlag },
      isDefeated: false,
    };
    globalThis.game = { time: { worldTime: 1840 }, combat: { round: 3 } };
    await writeCorpseRecord(combatant);
    expect(setFlag).toHaveBeenCalledWith("pf2e-dungeon-crawl", "corpse", expect.objectContaining({
      diedAtWorldTime: 1840, round: 3, x: 1200, y: 1500, name: "Goblin Warrior", level: 1, consumedBy: [],
    }));
  });

  it("is idempotent -- never overwrites an existing record", async () => {
    const setFlag = vi.fn();
    const combatant = { actor: { type: "npc" }, token: { getFlag: () => ({ diedAtWorldTime: 100 }), setFlag } };
    await writeCorpseRecord(combatant);
    expect(setFlag).not.toHaveBeenCalled();
  });

  it("is never called for a party character (Review Focus)", async () => {
    const setFlag = vi.fn();
    const combatant = { actor: { type: "character" }, token: { setFlag } };
    await applyDefeatIfReducedToZero(combatant); // character branch increaseCondition('dying'), never reaches the corpse write
    expect(setFlag).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat.corpse-record.test.mjs`
Expected: FAIL (`writeCorpseRecord` not defined)

- [ ] **Step 3: Implement** `writeCorpseRecord`, called from `applyDefeatIfReducedToZero`'s existing NPC branch immediately after `await target.toggleDefeated();`, before `playCreatureDeathSound()`. Export it alongside the existing exports in that file's module-level export list.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/dungeon-combat.corpse-record.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat.corpse-record.test.mjs
git commit -m "feat(#982): write a corpse record on the single real NPC defeat seam"
```

---

### Task 3: Corpse queries

**Files:**
- Create: `scripts/corpses.mjs`
- Test: `tests/corpses.test.mjs`

**Interfaces:**
- Produces: `corpsesNear(tokens, from, { adjacent, withinFeet, maxAgeSeconds, now })`, `isConsumedBy(record, eaterUuid, abilitySlug)`, `markConsumed(record, eaterUuid, abilitySlug)`, `NON_FLESH_TRAITS` (exported `Set`).

- [ ] **Step 1: Write the failing tests**

```js
import { corpsesNear, isConsumedBy, markConsumed, NON_FLESH_TRAITS } from "../scripts/corpses.mjs";

describe("corpsesNear (#982)", () => {
  it("returns a corpse within one square (Chebyshev) and within the age window", () => {
    const corpseToken = { id: "c1", x: 100, y: 0, getFlag: () => ({ diedAtWorldTime: 1000, x: 100, y: 0 }) };
    const from = { x: 0, y: 0 };
    const result = corpsesNear([corpseToken], from, { adjacent: true, maxAgeSeconds: 3600, now: 1500 });
    expect(result.map((r) => r.tokenId)).toEqual(["c1"]);
  });

  it("excludes a corpse exactly at the age boundary's far edge, includes one exactly at the near edge (Review Focus)", () => {
    const token = (diedAt) => ({ id: "c", x: 0, y: 0, getFlag: () => ({ diedAtWorldTime: diedAt, x: 0, y: 0 }) });
    const now = 4600; // 3600s window
    expect(corpsesNear([token(1000)], { x: 0, y: 0 }, { adjacent: true, maxAgeSeconds: 3600, now }).length).toBe(1); // age exactly 3600 -> within
    expect(corpsesNear([token(999)], { x: 0, y: 0 }, { adjacent: true, maxAgeSeconds: 3600, now }).length).toBe(0); // age 3601 -> outside
  });

  it("excludes a corpse with no record and one whose traits fall in NON_FLESH_TRAITS", () => {
    const noRecord = { id: "c2", getFlag: () => undefined };
    const construct = { id: "c3", x: 0, y: 0, getFlag: () => ({ diedAtWorldTime: 0, x: 0, y: 0, traits: ["construct"] }) };
    const result = corpsesNear([noRecord, construct], { x: 0, y: 0 }, { adjacent: true, maxAgeSeconds: 3600, now: 0 });
    expect(result).toEqual([]);
    expect(NON_FLESH_TRAITS.has("construct")).toBe(true);
  });
});

describe("isConsumedBy / markConsumed (#982)", () => {
  it("scopes once-per-corpse per (eater, ability), not globally (Review Focus)", () => {
    let record = { consumedBy: [] };
    record = markConsumed(record, "Actor.ghoul1", "consume-flesh");
    expect(isConsumedBy(record, "Actor.ghoul1", "consume-flesh")).toBe(true);
    expect(isConsumedBy(record, "Actor.ghoul2", "consume-flesh")).toBe(false);
    expect(isConsumedBy(record, "Actor.ghoul1", "some-other-ability")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/corpses.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**, reusing the module's existing Chebyshev-adjacency helper (the same one movement/targeting code uses — read `scripts/dungeon-combat.mjs`'s `tokenCell`/adjacency helpers before writing a second implementation) for the `adjacent: true` case, and plain grid distance for `withinFeet`. Age is `now - record.diedAtWorldTime`, inclusive at the boundary (`age <= maxAgeSeconds`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/corpses.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/corpses.mjs tests/corpses.test.mjs
git commit -m "feat(#982): pure corpse queries -- adjacency, age window, once-per-corpse scoping"
```

---

### Task 4: Recognition — the `corpse` family

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md`
- Test: that plan's own `npc-self-parse.mjs` test file

- [ ] **Step 1: Write the failing tests**

```js
describe("corpse family (#982)", () => {
  it("recognizes Consume Flesh -- corpseNear requirement, selfHeal effect, oncePerCorpse rider", () => {
    const item = makeSelfItem(
      "<p><strong>Requirements</strong> The ghoul is adjacent to the corpse of a creature that died within the last hour.</p><hr /><p><strong>Effect</strong> The ghoul devours a chunk of the corpse and regains @Damage[(1+(max(0,floor(@actor.level/2))))d6[healing]] Hit Points plus 1d6 for every 2 levels it has.</p><p>It can regain Hit Points from any given corpse only once.</p>"
    );
    const parsed = parseSelfAbility(item);
    expect(parsed.requirements).toContainEqual({ type: "corpseNear", adjacent: true, maxAgeSeconds: 3600 });
    expect(parsed.family).toBe("selfHeal");
    expect(parsed.params.formula).toBe("(1+(max(0,floor(@actor.level/2))))d6");
    expect(parsed.oncePerCorpse).toBe(true);
  });

  it("recognizes Feed -- corpseNear requirement, a timed fast-healing + damage buff", () => {
    const item = makeSelfItem(
      "<p><strong>Requirements</strong> The ghonhatine is adjacent to the corpse of a creature that died within the last hour</p><hr /><p><strong>Effect</strong> The ghonhatine devours a chunk of the corpse. For 1 minute, the ghonhatine gains fast healing 5 and a +2 status bonus to damage rolls. It can gain these benefits from any given corpse only once.</p><p>@UUID[Compendium.pf2e.bestiary-effects.Item.Effect: Ghonhatine Feed]</p>"
    );
    const parsed = parseSelfAbility(item);
    expect(parsed.family).toBe("corpseBuff");
    expect(parsed.params).toMatchObject({ fastHealing: 5, bonuses: [{ type: "status", value: 2, selector: "damage" }], durationSeconds: 60 });
    expect(parsed.oncePerCorpse).toBe(true);
  });

  it("returns null for Collect Brain -- a multi-step Interact-gated ability, out of scope (#1062)", () => {
    const item = makeSelfItem('<p>The jah-tohl extracts the brain of a creature within its reach that has been dead for no more than 1 minute. It can then use an Interact action to secure the brain in one of its empty brain blisters and heal @Damage[20[healing]] Hit Points.</p>');
    expect(parseSelfAbility(item)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "corpse family"`
Expected: FAIL

- [ ] **Step 3: Implement** the `corpseNear` requirement predicate (parsed from "adjacent to the corpse of a creature that died within the last `<N>` `<unit>`(s)", with `round`/`minute`/`hour`/`day` converted to seconds via the ability's own stated unit — Consume Flesh and Feed both say "hour" = 3600), the `corpseBuff` effect-clause recognizer ("For `<duration>`, `<actor>` gains fast healing `<N>` and a +`<B>` `<type>` bonus to `<selector>`"), and the `oncePerCorpse` rider from "It can `<gain these benefits | regain Hit Points>` from any given corpse only once." A `selfHeal` family ability (Consume Flesh) keeps that family; a buff-shaped one gets the new `corpseBuff` family. Any other trailing sentence makes the ability `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "corpse family"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md
git commit -m "docs(#982): amend #934's plan -- corpseNear requirement, corpseBuff family, oncePerCorpse rider"
```

---

### Task 5: Vocabulary

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md`
- Test: that plan's own vocabulary-builder test file

- [ ] **Step 1: Write the failing tests**

```js
describe("corpse vocabulary (#982)", () => {
  it("offers one entry per eligible adjacent corpse, dropping already-consumed and non-flesh ones", () => {
    // 3 corpse tokens adjacent to the ghoul: one fresh, one already
    // consumed by this ghoul for Consume Flesh, one with a construct
    // trait -> exactly one vocabulary entry for the fresh one.
  });

  it("offers a heal corpse ability only when the actor is below full HP", () => {
    // ...
  });

  it("offers a buff corpse ability only when the buff is not already active from this item", () => {
    // ...
  });

  it("ranks entries by freshness, youngest corpse first", () => {
    // ...
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "corpse vocabulary"`
Expected: FAIL

- [ ] **Step 3: Implement**, gathering corpse tokens on the viewed scene via `scripts/corpses.mjs`'s `corpsesNear` called against `game.time.worldTime` read fresh at build time (never cached across the turn — Review Focus), filtering with `isConsumedBy` and `NON_FLESH_TRAITS`, and the existing full-HP / already-active-buff gates #934's plan already states for its own `selfHeal`/`linkedEffectSelf` families.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "corpse vocabulary"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md
git commit -m "docs(#982): amend #934's plan -- corpse vocabulary (eligibility, freshness ranking)"
```

---

### Task 6: Execution

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md`
- Test: that plan's own `applyAgentDecision` `npcSelf` execution test file

- [ ] **Step 1: Write the failing tests**

```js
describe("corpse execution (#982)", () => {
  it("re-checks the corpse's eligibility at execution time, reading worldTime fresh, and aborts without spending the action if it no longer qualifies (Review Focus)", async () => {
    // vocabulary-build time: worldTime=1000, corpse died at 1000 (fresh).
    // execution time: worldTime=4700 (now outside the 3600s window) ->
    // abort, cost not spent.
  });

  it("heals via #934's selfHeal path and marks the corpse consumed", async () => {
    // ...
  });

  it("creates a timed buff effect (FastHealing + FlatModifier rule elements) and marks the corpse consumed", async () => {
    // ...
  });

  it("does not remove or alter the corpse's loot actor or items", async () => {
    // ...
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "corpse execution"`
Expected: FAIL

- [ ] **Step 3: Implement**, re-resolving the corpse token and re-running `corpsesNear`/`isConsumedBy` against a freshly-read `game.time.worldTime` before spending the cost. `selfHeal` reuses #934's own `executeSelfHeal` (now rollData-aware per Task 1); `corpseBuff` creates one effect item with a `FastHealing` rule element and one `FlatModifier` per parsed bonus, `system.duration` from `durationSeconds`, tagged `agentSelfEffect`. Both call `markConsumed` on the corpse token's flag afterward and announce publicly.

- [ ] **Step 4: Run the tests to verify they pass, then run the full suite**

Run: `npx vitest run`
Expected: PASS, no regressions in #934's existing tests or the loot/defeat-seam tests Task 2 touched.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-self-buff-heal-abilities.md
git commit -m "docs(#982): amend #934's plan -- corpse execution (fresh re-check, heal/buff, markConsumed)"
```

---

### Task 7: Coverage audit and version bump

**Files:**
- Create: `tests/fixtures/npc-corpse-audit.json`
- Create: `tests/npc-corpse-coverage.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Generate the real-population fixture**, scanning the real compendium for a corpse/"recently dead" clause, recording `{creature, ability, family | notOffered, reason}` for all 38 real uses the spec's own Investigation findings counted, confirming the 2-ability first-slice count and the named follow-up exclusions (Collect Brain, Necro Puppeteer, Drain Soul, etc.) for real, not by re-citing the spec's own count unchecked.
- [ ] **Step 2: Write the ratchet test** (golden-row comparison + monotonic count, #935's pattern).
- [ ] **Step 3: Run the test suite**

Run: `npx vitest run tests/npc-corpse-coverage.test.mjs`
Expected: PASS

- [ ] **Step 4: Run the `update-architecture-docs` skill** (new file `scripts/corpses.mjs` — confirm its import edges are captured)
- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/npc-corpse-audit.json tests/npc-corpse-coverage.test.mjs module.json docs/architecture.md
git commit -m "test(#982): real-population coverage audit for corpse abilities; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** The corpse record (Task 2), queries (Task 3), recognition (Task 4), vocabulary (Task 5), execution (Task 6), and the audit/version bump (Task 7) each cover a spec section. Task 1 covers a dependency gap the spec's own design relies on without stating it (#934's `selfHeal` formula handling) — discovered, not specified, which is exactly the kind of grounding this plan is supposed to do before committing to patching #934 blind. Out-of-scope items (Collect Brain/#1062, corpse-targeting/#1063, dying-creature/#1064, party corpses/#1065, death reactions/#1019) are excluded, not silently handled.

**2. Placeholder scan:** No "TBD"/"TODO". Vocabulary/execution tests in Tasks 5-6 are sketched at the same level of detail #934's own existing plan uses for its own vocabulary/execution tests (full mock scaffolding reused from that file, not re-specified here) rather than left as empty placeholders — each names exactly what it asserts.

**3. Type consistency:** `corpseNear`/`oncePerCorpse` (Task 4) are read identically by the vocabulary builder (Task 5) and the executor (Task 6); `corpsesNear`/`isConsumedBy`/`markConsumed` (Task 3) keep the same signature everywhere they're called.

**4. Review Focus:** All five bullets (character-branch isolation, full-formula regression, per-eater-per-ability scoping, the exact age boundary, fresh-`worldTime` re-reads) are each pinned to a named test in Tasks 1-3 and 6.

**Corrections found while writing this plan:** the most consequential finding is that #934's own `selfHeal` grammar — a dependency this plan was told to simply reuse — silently rejects this issue's own flagship worked example (Consume Flesh) once checked against the real, level-scaled formula rather than the spec's simplified paraphrase. The second-most consequential is that the real defeat seam is simpler than the spec assumed (one function, not a hook pair), which this plan takes advantage of rather than building the originally-assumed second hook registration that the real code turns out not to need.
