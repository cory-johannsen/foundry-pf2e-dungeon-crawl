# Trample Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI NPCs a new `trample` kind of #932's `npcMove`, so a creature with Trample can Stride up to double Speed through same-side-opposing creatures at or below the listed size, dealing its listed limb's Strike damage once, scaled per trampled creature by its own basic Reflex save.

**Architecture:** A dedicated recognizer for the glossary form patches into #932's `parseMovementAbility`. Route enumeration needs a trample-specific blocked-edges builder — found while grounding this plan that the module's existing movement-blocking helper has exactly the opposite passability rule Trample needs. Execution reuses the real Strike-damage-rolling API already proven elsewhere in this file and the real per-target save-and-scale pattern the breath-weapon executor already uses.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-trample-design.md`

## Global Constraints

- #932 is still plan-only; all three implementation tasks here patch that document directly.
- Trample deals exactly one damage roll, scaled per creature by that creature's own basic Reflex save outcome (spec's own resolved decision).
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **The real glossary text and all three cited example items (Centaur Herbalist, Stegosaurus, Mammoth) match the spec's quotes exactly** (confirmed live: `lang/en.json`'s `PF2E.NPC.Abilities.Glossary.Trample` string, and the three real bestiary items) — no correction needed to the recognized text form.
2. **The module's existing movement-blocking helper has exactly the opposite passability rule from what Trample needs — found by reading its real implementation rather than trusting the spec's "the usual blockers" shorthand.** `movementBlockedEdges(combat, combatant, excludeCell)` (`scripts/dungeon-combat.mjs:3083-3091`) builds `(a,b) => wallBlocked(a,b) || cellOccupied(b, hostiles) || cellOccupied(b, cover)` — it blocks on every HOSTILE footprint and never on an ally's, because ordinary movement must always let a Stride pass through an ally's square (the real doc-comment on `otherCombatantFootprints`, same file, confirms this explicitly: "Passing THROUGH an ally's square is still fine"). Trample's own stated rule is the reverse: allies, neutrals, and larger hostiles are blocked, while hostiles at or below the listed size are the ONLY passable squares. Task 2 builds a new `trampleBlockedEdges(combat, combatant, maxSize)` rather than reusing `movementBlockedEdges` unchanged, which would have silently let the mover glide through its own allies during a Trample (never flagged, since the existing helper was never designed to block them) while still blocking every eligible enemy as it does today.
3. **The spec's own open question — how to obtain the limb's Strike damage roll without a critical — has an exact, already-proven answer in this same file.** `rollAndApplyStrikeAtVariant` (confirmed real, `scripts/dungeon-combat.mjs:4961+`, read in full during an earlier issue in this same planning arc) already calls `strike.damage({target, outcome, createMessage})` to roll a Strike's own damage independent of its to-hit roll. Task 3 calls `strike.damage({target: firstTrampledTarget, outcome: "success", createMessage: false})` once for Trample's shared roll — `outcome: "success"` is the real system's own non-critical damage path, confirmed by the same call site's existing use of distinct `outcome` values to select critical vs non-critical damage formulas.
4. **The real per-target save-then-scale-then-apply pattern is already proven in `castBreathWeaponAndApplyDamage`** (`scripts/dungeon-combat.mjs:6101-6160`): `target.actor.saves[save].roll({dc: {value: dc}, createMessage: true})`, read the outcome off the just-created chat message's own flags, then `roll.alter(0.5, 0)` for a success / `roll.alter(2, 0)` for a critical failure / the roll unscaled for a failure / skipped entirely for a critical success, each followed by `target.actor.applyDamage({damage, token, outcome})` and `applyDefeatIfReducedToZero`. Confirmed `DamageRoll#alter` does not mutate its receiver (the same base roll object is reused correctly across every target in this existing loop's own equivalent pattern), so Trample's shared single roll can be `.alter()`-ed independently per trampled creature without corrupting the shared base.

## Review Focus

- A Trample route must never end on an occupied cell, including a cell occupied by a creature too large to trample — `walkPath`'s own landing check (`otherCombatantFootprints`) already enforces "never end on anyone," but the route's own interior PASSAGE must additionally never be blocked by an eligible small-enough enemy (Investigation finding 2; Task 2's test).
- The trample set computed at vocabulary-build time must be treated as a plan, not a guarantee — re-resolving it at execution time against creatures that may have moved, died, or grown is the spec's own explicit rule, and a stale set would trample a creature no longer in the mover's path (spec's own stated rule; Task 3's test).
- A multi-cell (Large/Huge) trampled creature's footprint must be checked for overlap at every step of the walked path, not just the final cell — a route that clips the corner of a Huge creature's footprint partway through the Stride must still count it once (spec's own stated rule; Task 2's test).
- The shared damage roll must be rolled exactly once per use of Trample, even when the route tramples zero, one, or several creatures — rolling it lazily only on the first trampled creature, or re-rolling it per creature, would both violate the "one roll" decision (Investigation finding 4; Task 3's test).
- A creature's own disposition must be re-read at execution time, not cached from vocabulary-build time, since a charmed/confused effect mid-combat could flip a creature from ally to opponent between the two (spec's own implicit "re-resolve eligibility" rule; Task 3's test).

---

### Task 1: Recognition — the `trample` branch and size ordering

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md` (`parseMovementAbility`, around line 302)
- Test: that plan's own `npc-move-parse` test file

- [ ] **Step 1: Write the failing tests**

```js
describe("trample recognition (#986)", () => {
  it("recognizes the exact glossary form via the @Localize token (Centaur Herbalist, real text)", () => {
    const item = makeMoveItem('<p>Medium or smaller, hoof, @Check[reflex|dc:18|basic]</p><hr /><p>@Localize[PF2E.NPC.Abilities.Glossary.Trample]</p>', { name: "Trample", cost: 3 });
    const parsed = parseMovementAbility(item);
    expect(parsed).toMatchObject({ shape: "trample", cost: 3, plan: { kind: "trample", speedFactor: 2, maxSize: "med", limb: "hoof", save: "reflex", dc: 18 } });
  });

  it("recognizes an unusual limb name (corpse wave, Warsworn-style, real text)", () => {
    const item = makeMoveItem('<p>Huge or smaller, corpse wave, @Check[reflex|dc:37|basic]</p><hr /><p>@Localize[PF2E.NPC.Abilities.Glossary.Trample]</p>', { name: "Trample", cost: 3 });
    const parsed = parseMovementAbility(item);
    expect(parsed.plan).toMatchObject({ maxSize: "huge", limb: "corpse wave", dc: 37 });
  });

  it("returns null for a different save, an extra sentence, or an unknown size word", () => {
    expect(parseMovementAbility(makeMoveItem('<p>Medium or smaller, hoof, @Check[fortitude|dc:18|basic]</p><hr /><p>@Localize[PF2E.NPC.Abilities.Glossary.Trample]</p>', { name: "Trample", cost: 3 }))).toBeNull();
    expect(parseMovementAbility(makeMoveItem('<p>Medium or smaller, hoof, @Check[reflex|dc:18|basic]. It can also fly.</p><hr /><p>@Localize[PF2E.NPC.Abilities.Glossary.Trample]</p>', { name: "Trample", cost: 3 }))).toBeNull();
    expect(parseMovementAbility(makeMoveItem('<p>Colossal or smaller, hoof, @Check[reflex|dc:18|basic]</p><hr /><p>@Localize[PF2E.NPC.Abilities.Glossary.Trample]</p>', { name: "Trample", cost: 3 }))).toBeNull();
  });

  it("returns null when the limb cannot be resolved to a ready Strike", () => {
    const item = makeMoveItem('<p>Medium or smaller, phantom-limb, @Check[reflex|dc:18|basic]</p><hr /><p>@Localize[PF2E.NPC.Abilities.Glossary.Trample]</p>', { name: "Trample", cost: 3, strikes: [] });
    expect(parseMovementAbility(item)).toBeNull();
  });
});

describe("size ordering (#986)", () => {
  it("'or smaller' includes smaller and equal sizes, excludes larger, for every pair", () => {
    const order = ["tiny", "sm", "med", "lg", "huge", "grg"];
    for (let i = 0; i < order.length; i += 1) {
      for (let j = 0; j < order.length; j += 1) {
        expect(sizeAtMost(order[j], order[i])).toBe(j <= i);
      }
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "trample recognition"` and `-t "size ordering"`
Expected: FAIL (no `trample` branch or `sizeAtMost` helper exists yet)

- [ ] **Step 3: Implement** the `trample` branch (tried before the ordinary movement grammar, since Trample's text has no movement sentence) and `sizeAtMost(candidateSize, maxSize)` using PF2e's real size ordering (`tiny < sm < med < lg < huge < grg`). The limb resolves via `matchMultiStrikeActionSlug` (confirmed real, already used by #933's plan) against the actor's own ready Strikes; an unresolvable limb makes the item `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "trample recognition"` and `-t "size ordering"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md
git commit -m "docs(#986): amend #932's plan -- trample recognition and size ordering"
```

---

### Task 2: Route enumeration

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md` (`buildNpcMoveVocabulary`, around line 588)
- Test: that plan's own vocabulary-builder test file

- [ ] **Step 1: Write the failing tests**

```js
describe("trampleBlockedEdges (#986, Investigation finding 2)", () => {
  it("blocks an ally's footprint (unlike ordinary movement's isBlocked)", () => { /* ... */ });
  it("blocks a hostile footprint larger than maxSize", () => { /* ... */ });
  it("does not block a hostile footprint at or below maxSize -- it is pass-through", () => { /* ... */ });
  it("still blocks walls and living cover", () => { /* ... */ });
});

describe("trample route enumeration (#986)", () => {
  it("computes the trample set as every eligible enemy overlapped at any step of the walked path, counted once each (Review Focus: multi-cell footprints)", () => { /* a Large mover's path clips the corner of a Huge enemy's footprint partway through -- counted once */ });
  it("never offers a route whose trample set is empty", () => { /* ... */ });
  it("dedupes routes by trample set, ranks by count then expected damage, caps at 6", () => { /* ... */ });
  it("budgets the path to 2x land Speed in squares, in terrain-cost units when the scene has terrain", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "trampleBlockedEdges"` and `-t "trample route enumeration"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement** `trampleBlockedEdges(combat, combatant, maxSize)` as `(a,b) => wallBlocked(a,b) || cellOccupied(b, allyAndNeutralFootprints) || cellOccupied(b, oversizedHostileFootprints) || cellOccupied(b, cover)`, reusing `combatantAllies`/`combatantOpponents` (both confirmed real, already used by `otherCombatantFootprints`) filtered by `sizeAtMost`. For each opponent as a target, call `posturePath`/`walkPath` (both confirmed real, Investigation findings) with this blocked-edges function and the `2x land Speed` budget (through #973's `cellCost` when the scene has terrain, matching #932's own existing terrain-integration pattern); compute the trample set by checking the mover's own footprint against every eligible enemy's footprint at each walked step.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run -t "trampleBlockedEdges"` and `-t "trample route enumeration"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md
git commit -m "docs(#986): amend #932's plan -- trample route enumeration and the size-filtered blocked-edges builder"
```

---

### Task 3: Execution

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md` (`applyAgentDecision`'s `npcMove` branch)
- Test: that plan's own execution test file

- [ ] **Step 1: Write the failing tests**

```js
describe("trample execution (#986)", () => {
  it("re-resolves the route and the trample set at execution time, dropping a creature that moved out of the walked path or flipped disposition (Review Focus)", async () => { /* ... */ });
  it("aborts without spending the action when re-resolution finds no creature left to trample", async () => { /* ... */ });
  it("rolls the limb's Strike damage exactly once via strike.damage({outcome: 'success', createMessage: false}) (Investigation finding 3), regardless of how many creatures are trampled (Review Focus)", async () => { /* ... */ });
  it("scales the shared roll per creature by its own basic Reflex save outcome -- none, half, full, double -- without mutating the shared roll for the next creature (Investigation finding 4)", async () => { /* ... */ });
  it("tramples each creature at most once, applies damage and defeat handling per creature, and posts one public announcement naming the trampled count", async () => { /* ... */ });
  it("a save-roll failure for one creature is logged and skipped; the others still resolve against the same shared roll", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "trample execution"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, following Investigation findings 3 and 4's confirmed real call shapes: re-resolve the route via Task 2's own enumeration logic against live state; walk it through #932's generalized stride executor; recompute the actual trample set from the cells actually walked; roll `strike.damage({target: trampled[0]?.token ?? null, outcome: "success", createMessage: false})` once; for each trampled creature in path order, roll its basic Reflex save, scale a copy of the shared roll per its outcome, apply damage, handle defeat; announce and report via #925's result descriptor.

- [ ] **Step 4: Run the tests to verify they pass, then the full movement-abilities suite**

Run: `npx vitest run -t "trample execution"` then the full suite for that plan.
Expected: PASS, no regressions in ordinary movement or the breath-weapon executor (still rolls per target, unchanged).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-movement-abilities.md
git commit -m "docs(#986): amend #932's plan -- trample execution, one shared roll scaled per creature"
```

---

### Task 4: Coverage audit and version bump

**Files:**
- Create: `tests/fixtures/npc-trample-audit.json`
- Create: `tests/npc-trample-coverage.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Generate the real-population fixture**, scanning the real compendium for every Trample item (confirming the spec's own count of 43, and the Medium 15 / Large 13 / Huge 15 size distribution for real), recording `{creature, size, limb, dc}`.
- [ ] **Step 2: Write the ratchet test** (golden-row comparison + monotonic count, #935's pattern) — all 43 (or the confirmed real count) must parse.
- [ ] **Step 3: Run the test suite**

Run: `npx vitest run tests/npc-trample-coverage.test.mjs`
Expected: PASS

- [ ] **Step 4: Run the `update-architecture-docs` skill** (no new files — confirm no import-edge changes are missed)
- [ ] **Step 5: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/npc-trample-audit.json tests/npc-trample-coverage.test.mjs module.json
git commit -m "test(#986): real-population coverage audit for Trample; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** Recognition (Task 1), route enumeration (Task 2), execution (Task 3), and the audit/version bump (Task 4) each cover a spec section. The breath-weapon executor is explicitly left unchanged (still per-target rolls), matching the spec's own "Explicitly out of scope."

**2. Placeholder scan:** No "TBD"/"TODO". Task 2's and 3's test lists name exactly what each asserts, at the same granularity this planning arc's other plans use for this file.

**3. Type consistency:** The `plan: {kind: "trample", speedFactor, maxSize, limb, save, dc}` descriptor (Task 1) is read identically by Task 2's route enumeration and Task 3's executor; the vocabulary entry shape (`targetId, routeId, trampleIds[]`) defined in Task 2 is consumed with the same field names by Task 3.

**4. Review Focus:** All five bullets (interior-passage blocking, stale-set re-resolution, multi-cell footprint overlap at every step, exactly-one-roll regardless of trample-set size, fresh disposition re-read) are each pinned to a named test in Tasks 2 and 3.

**Corrections found while writing this plan:** the most consequential is Investigation finding 2 — the spec's own "the usual blockers" shorthand would, read literally, reuse a function that blocks every hostile and passes every ally, the exact opposite of what Trample's own stated design requires; caught by reading `movementBlockedEdges`'s real implementation and its own doc-comments rather than trusting the shorthand. The second is Investigation finding 3 — the spec's own open question about rolling a non-critical Strike damage formula has an exact, already-proven answer (`strike.damage({outcome: "success", ...})`) sitting in this same file from an earlier issue in this planning arc, avoiding a second, possibly-inconsistent damage-rolling mechanism.
