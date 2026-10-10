# Prose-Only NPC Abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI NPCs a reviewed, declarative table of prose-only abilities (self state toggles, concealment, and zones/terrain), with primitive steps, a toggle mechanism, and runtime zones, so a will-o'-wisp can go dark, a slurk can grease the floor, and a dragon turtle can raise a storm.

**Architecture:** A JSON table (`data/npc-prose-abilities.json`) of primitive-step entries, schema-validated, drives a new `prose` family in #934's `npcSelf` vocabulary/execution. Zones are temporary Foundry Regions carrying an extended version of #973's Terrain behavior, following #983's lifetime pattern. Live verification against both real ability items and the real PF2e Balance action found that the spec's own stated toggle and Balance-check mechanics each have a cleaner, more-correct real counterpart than what the spec describes informally: PF2e's own `actor.toggleRollOption` already drives Go Dark's and Conjure Storm's native `GrantItem`/`Aura` rule elements, and the real Balance action's actual success table differs from the spec's own simplified "Off-Guard on failure" description.

**Tech Stack:** Vanilla JS (ESM), Foundry VTT API, PF2e system API, JSON Schema, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-ai-npc-prose-abilities-design.md`

## Global Constraints

- PF2e's own rules are the source of truth; a modeled consequence that isn't in the real rules text needs the owner's explicit, recorded approval (CLAUDE.md "Game rules") — Task 2 corrects one such case found while grounding this plan.
- No scripting escape hatch in the table: an ability not expressible with the closed primitive set is not an entry (spec's own stated rule).
- #973 and #935 are still plan-only; Tasks 1, 2, 3, and 5 patch those documents directly.
- Every merge bumps `module.json`'s version (CLAUDE.md).

## Investigation findings

1. **Go Dark and Conjure Storm already carry a native, toggleable `RollOption` rule element — a cleaner mechanism than the spec's own hand-rolled toggle bookkeeping, confirmed by reading both the real item data and the real system source.** Go Dark's real item (`pathfinder-monster-core/will-o-wisp.json`) carries `{key: "RollOption", option: "go-dark", toggleable: true}` plus an in-memory `GrantItem` that grants Invisible while the option is on; Conjure Storm's (`dragon-turtle.json`) carries `{key: "RollOption", option: "conjure-storm", toggleable: true}` plus an `Aura` rule element with `radius: 30`. Neither specifies a `domain`, so both default to `"all"` (confirmed in `RollOptionRuleElement.defineSchema()`, `pf2e.mjs:43980-43985`, `initial: "all"`). The real, confirmed system API to flip either is `actor.toggleRollOption(domain, option, itemId, value)` (`pf2e.mjs:31772`), which finds the matching `RollOption` rule element and calls its own `.toggle()` — the system then handles granting/revoking the condition or activating the aura entirely on its own, per CLAUDE.md's "prefer the PF2e system's own implementation over reimplementing it." Task 4 adds this as the preferred toggle mechanism, with the spec's own manual `applyCondition`/`removeCondition`/`activeToggles` approach kept only as the fallback for an entry whose item has no matching native `RollOption`.
2. **The spec's own stated Balance-check consequences for "uneven ground" deviate from the real Balance action rules — found by reading the real action item, not assumed from the spec's paraphrase, and corrected per CLAUDE.md's explicit "don't invent house rules" instruction.** The spec says "failure: the creature is Off-Guard until the end of its turn, a critical failure: it falls Prone and the move ends." The real Balance action (`actions/skill/balance.json`) says: the creature is **Off-Guard unconditionally** for the entire time it is on a narrow surface or uneven ground (not only on a failed check); **Critical Success** — moves up to Speed; **Success** — moves up to Speed but the uneven ground costs double (treated as difficult terrain); **Failure** — the creature either remains stationary (the move accomplishes nothing) or falls, ending its turn if it falls; **Critical Failure** — falls, turn ends. Task 2 implements this real table instead of the spec's simplified version, and the `uneven` kind's own `cellCost` contribution is a difficult-terrain multiplier (matching the real Success entry), with the Balance roll and its full outcome table run by the movement executor at the moment of stepping onto the cell, not folded into path-search cost.
3. **The spec's cited "#915/#935 timed-condition helper" is narrower than the spec implies — no generic helper for a condition that expires at a specific turn boundary actually exists in the merged code.** `actor.increaseCondition(slug, {value})` (confirmed real, used throughout `scripts/dungeon-combat.mjs`) applies a condition immediately but with no expiry tracking of its own; the only existing turn-boundary removal is `decayFrightenedAtEndOfTurn` (`scripts/dungeon-combat.mjs:6285`), which is specific to Frightened's own decay rule, not a reusable mechanism. Task 3 builds the generic primitive the spec's `applyCondition`/`"untilStartOfNextTurn"`/`"untilEndOfNextTurn"` duration kinds actually need, rather than assuming it already exists.
4. **#935's own real timed-effect helper, `applyTimedPenalty(target, penalty, originItem)` (`scripts/dungeon-combat.mjs`, per that plan's own Task 6), is module-private as currently planned.** The `applyEffect` primitive needs to call the same effect-creation shape (one `FlatModifier`/other rule per listed item, `system.duration` from `secondsToEffectDuration`), so Task 5 patches #935's plan to export a thin, reusable wrapper (`createTimedEffectFromRules(target, rules, durationSeconds, originItem)`) rather than duplicating that logic in a second file.
5. **Belly Grease's real text matches the spec's quote exactly** (`pathfinder-monster-core/slurk.json`) — a clean, accurate zone example needing no correction beyond the Balance-consequence fix in finding 2.

## Review Focus

- A toggle-off must correctly reverse whichever mechanism turned it on — an entry executed via `actor.toggleRollOption` must be turned off the same way (never by hand-removing the condition the system itself granted, which would leave the RollOption's own toggle state and the condition out of sync) — (Investigation finding 1; Task 4's test).
- Off-Guard from standing on uneven/narrow terrain must apply for the whole time a mover occupies the zone, not only as a one-time failure penalty — a mover that succeeds its Balance check but remains on the terrain (e.g., ends its move there) must still show Off-Guard (Investigation finding 2; Task 2's test).
- `excludeSourceTokenId` must exclude only the exact creature that created the zone, not every creature of its disposition — a second dragon turtle moving through another's storm must still pay the difficult-terrain cost (spec's own implied rule, confirmed by Conjure Storm's own text naming "the dragon turtle," singular; Task 1's test).
- A zone that `followsSource` must stop following and be removed, not orphaned, the instant its source token is deleted or defeated — an `updateToken` handler with no matching region left running is a real leak risk given this is the first feature creating Region documents at runtime (spec's own stated rule; Task 6's test).
- A table entry whose fixture hash no longer matches the live compendium item must be disabled for exactly that item, not for every other entry sharing the same `op`s — a broad disable-on-any-mismatch would silently stop offering unrelated abilities (spec's own stated rule; Task 5's test).

---

### Task 1: Terrain extensions — `uneven` kind, `appliesToModes`, `excludeSourceTokenId`

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-terrain-aware-movement.md` (Task 3's `MODE_RULES`/`buildCellCost`, Task 4's `TerrainRegionBehaviorType`)
- Test: that plan's own `terrain-modes`/`terrain-region-behavior` test files

- [ ] **Step 1: Write the failing tests**

```js
describe("TerrainRegionBehaviorType schema extensions (#984)", () => {
  it("adds uneven to the kind vocabulary plus balanceDC, appliesToModes, excludeSourceTokenId fields", () => {
    const schema = TerrainRegionBehaviorType.defineSchema();
    expect(Object.keys(schema).sort()).toEqual(["appliesToModes", "balanceDC", "excludeSourceTokenId", "kind"].sort());
    expect(schema.kind.choices).toContain("uneven");
  });
});

describe("buildCellCost with appliesToModes/excludeSourceTokenId (#984)", () => {
  it("a fly/swim-only difficult zone costs a walker nothing", () => {
    const terrain = ctx({ "0,0": { kinds: ["water"], appliesToModes: ["fly", "swim"] } });
    expect(buildCellCost(terrain, "land", {}, 0)({ x: 0, y: 0 })).toBe(1);
  });

  it("the same zone costs a flyer double, matching difficult terrain (Review Focus: only the exact source is excluded)", () => {
    const terrain = ctx({ "0,0": { kinds: ["water"], appliesToModes: ["fly"], excludeSourceTokenId: "dragonA" } });
    expect(buildCellCost(terrain, "fly", { tokenId: "dragonB" }, 10)({ x: 0, y: 0 })).toBe(2);
    expect(buildCellCost(terrain, "fly", { tokenId: "dragonA" }, 10)({ x: 0, y: 0 })).toBe(1);
  });

  it("an uneven cell costs a mover double (the real Balance Success outcome, Investigation finding 2), never Infinity", () => {
    const terrain = ctx({ "0,0": { kinds: ["uneven"], balanceDC: 18 } });
    expect(buildCellCost(terrain, "land", {}, 0)({ x: 0, y: 0 })).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "TerrainRegionBehaviorType schema extensions"` and `-t "buildCellCost with appliesToModes"`
Expected: FAIL (fields/behavior don't exist yet)

- [ ] **Step 3: Implement.** Add to `TerrainRegionBehaviorType.defineSchema()`: `"uneven"` to `TERRAIN_KINDS`; `balanceDC` (`NumberField`, nullable, meaningful only with `kind: "uneven"`); `appliesToModes` (`ArrayField` of `StringField`, nullable, empty/null meaning "all modes"); `excludeSourceTokenId` (`StringField`, nullable). In `buildCellCost`, before applying a kind's difficulty/passability, skip the behavior entirely when `appliesToModes` is set and doesn't include the current `mode`, or when `excludeSourceTokenId` equals the mover's own token id. `uneven` contributes the same cost-doubling `buildCellCost` already uses for PF2e/native difficult terrain (never a passability block — a Balance failure doesn't stop movement outright per the real rule, it costs the action instead, handled by Task 2's executor, not the cost function).

- [ ] **Step 4: Run the tests to verify they pass, then the full `terrain`/`terrain-modes` suites**

Run: `npx vitest run -t "TerrainRegionBehaviorType"` and `npx vitest run -t "buildCellCost"`
Expected: PASS, including #973's own existing fixtures unchanged.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-terrain-aware-movement.md
git commit -m "docs(#984): amend #973's plan -- uneven kind, appliesToModes, excludeSourceTokenId"
```

---

### Task 2: Balance-check execution on uneven terrain

**Files:**
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-terrain-aware-movement.md` (Task 5's segment-execution loop)
- Test: that plan's own `terrain-elevation`-equivalent test file (or a sibling, `terrain-balance.test.mjs`)

- [ ] **Step 1: Write the failing tests**

```js
describe("Balance-check execution on uneven terrain (#984, Investigation finding 2)", () => {
  it("applies Off-Guard for as long as the mover occupies an uneven/narrow cell, regardless of the check's outcome (Review Focus)", async () => { /* ... */ });
  it("critical success: moves at full cost, no further consequence", async () => { /* ... */ });
  it("success: the step already cost double via buildCellCost -- no additional consequence", async () => { /* ... */ });
  it("failure: the move for that step is not taken (remains stationary) and the rest of the planned path for this action is abandoned", async () => { /* ... */ });
  it("critical failure: the mover falls -- increaseCondition('prone') -- and the turn's remaining movement for this action ends", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run -t "Balance-check execution"`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, extending the same per-step segment-execution loop Task 5 already patches for Fly elevation and the trap-trigger gate: before committing a step onto a cell whose `terrainAt(...).kinds.has("uneven")`, apply Off-Guard (if not already present) via `actor.increaseCondition("off-guard")`, roll an Acrobatics Balance check against the cell's `balanceDC` through the actor's own real skill-check call (the same confirmed-live pattern #934's `selfHeal`/other executors already use for a system skill roll), and branch per the real Balance table from Investigation finding 2. Off-Guard is removed when the mover leaves every uneven cell it currently occupies (checked at the end of the full move), not tied to this one check's outcome.

- [ ] **Step 4: Run the tests to verify they pass, then the full terrain-aware-movement suite**

Run: `npx vitest run -t "Balance-check execution"` and the full terrain-movement plan's test files.
Expected: PASS, no regressions in the Fly elevation / trap-trigger tests.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-09-ai-npc-terrain-aware-movement.md
git commit -m "docs(#984): amend #973's plan -- real Balance-check outcomes for uneven terrain"
```

---

### Task 3: Generic scheduled-condition removal

**Files:**
- Create: `scripts/condition-timers.mjs`
- Test: `tests/condition-timers.test.mjs`

**Interfaces:**
- Produces: `scheduleConditionRemoval(combat, actorUuid, slug, { until: "startOfNextTurn" | "endOfNextTurn" })`; `sweepConditionTimers(combat, combatant)` (called at each turn-start/turn-end, removes any due entries); storage in `combat.getFlag(MODULE_ID, "conditionTimers")` (an array).

- [ ] **Step 1: Write the failing tests**

```js
describe("scheduleConditionRemoval / sweepConditionTimers (#984, Investigation finding 3)", () => {
  it("removes the condition at the start of the actor's own next turn when scheduled 'startOfNextTurn'", async () => { /* ... */ });
  it("removes the condition at the end of the actor's own next turn when scheduled 'endOfNextTurn'", async () => { /* ... */ });
  it("leaves an unrelated actor's condition and an unrelated slug on the same actor untouched", async () => { /* ... */ });
  it("is a no-op when the combat has no scheduled entries", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/condition-timers.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**, storing `{actorUuid, slug, dueAtCombatantTurnId, dueAtPhase: "start"|"end"}` entries on the combat flag and checking them from the same turn-advance hook `decayFrightenedAtEndOfTurn` is called from (confirm that real call site first), removing via `actor.decreaseCondition(slug)` / the real inverse of `increaseCondition` (confirm the exact removal API against the live system before finalizing — PF2e's own condition-decrement call, not a raw item delete).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/condition-timers.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/condition-timers.mjs tests/condition-timers.test.mjs
git commit -m "feat(#984): generic scheduled condition removal at a turn boundary"
```

---

### Task 4: Toggle mechanism — native `toggleRollOption` with manual fallback

**Files:**
- Create: `scripts/npc-prose-toggle.mjs`
- Test: `tests/npc-prose-toggle.test.mjs`

**Interfaces:**
- Produces: `toggleProseEntry(actor, item, entry, turnOn)` → routes to `actor.toggleRollOption(domain, option, item.id, turnOn)` when the entry's `toggleVia` is `{kind: "rollOption", domain, option}` (Investigation finding 1), or to the manual `applyCondition`/`removeCondition`/`createZone`/delete-zone steps otherwise.

- [ ] **Step 1: Write the failing tests**

```js
describe("toggleProseEntry (#984, Investigation finding 1)", () => {
  it("turns Go Dark on via actor.toggleRollOption('all', 'go-dark', item.id, true)", async () => {
    const toggleRollOption = vi.fn();
    const actor = { toggleRollOption };
    await toggleProseEntry(actor, { id: "i1" }, { toggleVia: { kind: "rollOption", domain: "all", option: "go-dark" } }, true);
    expect(toggleRollOption).toHaveBeenCalledWith("all", "go-dark", "i1", true);
  });

  it("turns it back off the same way, never by hand-removing the system-granted condition (Review Focus)", async () => {
    const toggleRollOption = vi.fn();
    const actor = { toggleRollOption, increaseCondition: vi.fn(), decreaseCondition: vi.fn() };
    await toggleProseEntry(actor, { id: "i1" }, { toggleVia: { kind: "rollOption", domain: "all", option: "go-dark" } }, false);
    expect(toggleRollOption).toHaveBeenCalledWith("all", "go-dark", "i1", false);
    expect(actor.decreaseCondition).not.toHaveBeenCalled();
  });

  it("falls back to manual applyCondition/removeCondition steps for an entry with no native rule element", async () => {
    const actor = { increaseCondition: vi.fn(), decreaseCondition: vi.fn() };
    await toggleProseEntry(actor, { id: "i2" }, { toggleVia: { kind: "manual" }, steps: [{ op: "applyCondition", slug: "concealed", duration: "untilToggledOff" }] }, true);
    expect(actor.increaseCondition).toHaveBeenCalledWith("concealed");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-prose-toggle.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**, with the table's own `toggleVia` field (added to the schema in Task 5) selecting the mechanism per entry.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-prose-toggle.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/npc-prose-toggle.mjs tests/npc-prose-toggle.test.mjs
git commit -m "feat(#984): toggle via native toggleRollOption with a manual-steps fallback"
```

---

### Task 5: The table, schema, and the first three entries

**Files:**
- Create: `data/npc-prose-abilities.json`
- Create: `data/schema/npc-prose-abilities.schema.json`
- Create: `scripts/npc-prose-table.mjs` (load + validate + fixture-hash check)
- Modify: `docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md` (export `createTimedEffectFromRules`, Investigation finding 4)
- Test: `tests/npc-prose-table.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("npc-prose-abilities schema validation (#984)", () => {
  it("accepts a well-formed entry with each closed op", () => { /* ... */ });
  it("rejects an entry with an unknown op", () => { /* ... */ });
  it("rejects an entry missing a required field for its op", () => { /* ... */ });
});

describe("the first three table entries (#984)", () => {
  it("Go Dark: toggleVia rollOption, fixture hash matches the real item text", () => { /* loads data/npc-prose-abilities.json, finds the go-dark|will-o-wisp key, asserts toggleVia and the hash against the real description string */ });
  it("Belly Grease: createZone with kind uneven, balanceDC 18, duration 600s", () => { /* ... */ });
  it("Conjure Storm: toggleVia rollOption, createZone with kind water-aura-equivalent, appliesToModes [fly, swim], excludeSourceTokenId resolved at execution time (not baked into the table)", () => { /* ... */ });
});

describe("fixture-hash mismatch disables only that entry (#984, Review Focus)", () => {
  it("a changed description text for one entry does not disable a sibling entry", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-prose-table.test.mjs`
Expected: FAIL (files/module don't exist)

- [ ] **Step 3: Implement** the JSON schema (closed `op` enum: `applyCondition`, `removeCondition`, `applyEffect`, `createZone`, `note`), the loader/validator (reusing the creature-art pack's own validation pattern per the spec's own citation), the fixture-hash check (a normalized-text hash per entry, computed the same way #935's own golden-file hashing works — confirm that exact normalization function and reuse it rather than inventing a second one), and the three entries per Investigation findings 1, 2, and 5. Export `createTimedEffectFromRules` from #935's plan's executor file (a one-line change: add it to that file's existing `export` list, no logic change) for the `applyEffect` primitive to call.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-prose-table.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add data/npc-prose-abilities.json data/schema/npc-prose-abilities.schema.json scripts/npc-prose-table.mjs tests/npc-prose-table.test.mjs docs/superpowers/plans/2026-10-09-ai-npc-save-outcome-coverage.md
git commit -m "feat(#984): the prose-ability table, schema, and the first three entries"
```

---

### Task 6: Zone runtime

**Files:**
- Create: `scripts/prose-zones.mjs`
- Test: `tests/prose-zones.test.mjs`

**Interfaces:**
- Produces: `createZone(scene, { shape, distanceFeet, center, terrain, duration, followsSource, sourceTokenId, itemKey })` → `{ regionId }`; `removeZone(scene, regionId)`; `sweepExpiredZones(scene, worldTime)`; an `updateToken` follow handler.

- [ ] **Step 1: Write the failing tests**

```js
describe("createZone / removeZone (#984)", () => {
  it("creates a circle Region sized to the emanation/burst with one Terrain behavior carrying the step's terrain params", async () => { /* ... */ });
  it("records the zone flag with itemKey, sourceTokenId, createdAtWorldTime, expiresAtWorldTime, followsSource", async () => { /* ... */ });
  it("removeZone deletes the region", async () => { /* ... */ });
});

describe("sweepExpiredZones (#984)", () => {
  it("removes a zone whose expiresAtWorldTime has passed, reading worldTime fresh", async () => { /* ... */ });
  it("leaves a zone with no expiresAtWorldTime (toggle-controlled) alone", async () => { /* ... */ });
});

describe("followsSource (#984, Review Focus)", () => {
  it("moves the region's shape when the source token moves", async () => { /* ... */ });
  it("removes the zone (not just stops following) when the source token is deleted", async () => { /* ... */ });
  it("removes the zone when the source combatant is defeated", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/prose-zones.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**, creating embedded `Region` documents via `scene.createEmbeddedDocuments("Region", ...)` with one behavior of type `"pf2e-dungeon-crawl.terrain"` (Task 1's extended schema) and following #983's own confirmed lifetime pattern (expiry checked at round/turn change against a freshly-read `game.time.worldTime`, removal on source defeat, combat-end cleanup) rather than inventing a second lifecycle mechanism.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/prose-zones.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/prose-zones.mjs tests/prose-zones.test.mjs
git commit -m "feat(#984): zone runtime -- Region creation, follow, expiry, cleanup"
```

---

### Task 7: Vocabulary

**Files:**
- Create: `scripts/npc-prose-abilities.mjs`
- Test: `tests/npc-prose-abilities-vocabulary.test.mjs`

**Interfaces:**
- Produces: `buildNpcProseVocabulary(combat, combatant)` → entries `{ type: "npcSelf", family: "prose", itemId, entryKey, name, cost, mode: "on"|"off", summary }`.

- [ ] **Step 1: Write the failing tests**

```js
describe("buildNpcProseVocabulary (#984)", () => {
  it("offers the 'on' entry for an untoggled ability and the 'off' entry once active", () => { /* ... */ });
  it("gates by cost vs actions remaining, frequency, recharge, and the entry's own requirements", () => { /* ... */ });
  it("does not offer an ability with no table entry", () => { /* ... */ });
  it("does not offer an entry whose fixture hash no longer matches the live item (Review Focus: only that entry)", () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/npc-prose-abilities-vocabulary.test.mjs`
Expected: FAIL (module does not exist)

- [ ] **Step 3: Implement**, reusing #934's gating conventions and the per-turn cap already shared across `npcSelf` families.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/npc-prose-abilities-vocabulary.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/npc-prose-abilities.mjs tests/npc-prose-abilities-vocabulary.test.mjs
git commit -m "feat(#984): npcSelf prose-family vocabulary"
```

---

### Task 8: Execution

**Files:**
- Modify: `scripts/dungeon-combat.mjs` (`applyAgentDecision`, `npcSelf`/`prose` branch)
- Test: `tests/dungeon-combat.npc-prose-execution.test.mjs`

- [ ] **Step 1: Write the failing tests**

```js
describe("prose execution (#984)", () => {
  it("runs each step in order via toggleProseEntry/createZone/createTimedEffectFromRules, a failing step logged but later steps still run", async () => { /* ... */ });
  it("records/clears the toggle state and posts a GM note step's text", async () => { /* ... */ });
  it("reports applied effects and any limitations through #925's result descriptor", async () => { /* ... */ });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/dungeon-combat.npc-prose-execution.test.mjs`
Expected: FAIL (not implemented yet)

- [ ] **Step 3: Implement**, calling Task 3's `scheduleConditionRemoval`, Task 4's `toggleProseEntry`, Task 5's `createTimedEffectFromRules`, and Task 6's `createZone`/`removeZone` per each entry's own `steps`.

- [ ] **Step 4: Run the tests to verify they pass, then the full suite**

Run: `npx vitest run`
Expected: PASS, no regressions in #934/#935/#973/#983's own tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat.npc-prose-execution.test.mjs
git commit -m "feat(#984): execute prose-family npcSelf abilities"
```

---

### Task 9: First-batch audit and version bump

**Files:**
- Create: `tests/fixtures/npc-prose-audit.json`
- Create: `tests/npc-prose-coverage.test.mjs`
- Modify: `module.json`

- [ ] **Step 1: Generate the prose-ability inventory**, scanning the real compendium for the ~190 active instances / ~100 names the spec's own Investigation findings counted, recording `{ability, creatureCount, category, expressible: "yes"|"no", missingPrimitive?}`, confirming that count for real rather than re-citing it unchecked.
- [ ] **Step 2: Propose the first batch** (the highest-count expressible abilities, per the spec's own "roughly 25" sizing) as a markdown list attached to the issue for the owner's approval, separate from and in addition to this plan's own three shipped entries (Go Dark, Belly Grease, Conjure Storm) — do not add further entries to `data/npc-prose-abilities.json` in this plan without that approval (spec's own stated decision process).
- [ ] **Step 3: Write the ratchet test** (golden-row comparison + monotonic count, #935's pattern) over the three shipped entries; the proposed-but-unapproved batch is tracked in the audit fixture as `expressible: "yes"`, not yet in the table.
- [ ] **Step 4: Run the test suite**

Run: `npx vitest run tests/npc-prose-coverage.test.mjs`
Expected: PASS

- [ ] **Step 5: Run the `update-architecture-docs` skill** (new files: `scripts/condition-timers.mjs`, `scripts/npc-prose-toggle.mjs`, `scripts/npc-prose-table.mjs`, `scripts/prose-zones.mjs`, `scripts/npc-prose-abilities.mjs`)
- [ ] **Step 6: Bump `module.json`'s version** (minor — check `main`'s current version first)
- [ ] **Step 7: Commit**

```bash
git add tests/fixtures/npc-prose-audit.json tests/npc-prose-coverage.test.mjs module.json docs/architecture.md
git commit -m "test(#984): prose-ability inventory, first-batch proposal, and ratchet; chore: bump version"
```

---

## Self-Review

**1. Spec coverage:** The table/schema (Task 5), primitives (Tasks 3, 4, 5, 6), terrain extensions (Tasks 1-2), vocabulary (Task 7), execution (Task 8), and the audit/first-batch proposal (Task 9) each cover a spec section. Transformations (#1077) and senses/communication/fire (#1078) are excluded, not silently handled. The first batch beyond the three shipped entries is explicitly deferred to owner approval per the spec's own decision process, not pre-decided by this plan.

**2. Placeholder scan:** No "TBD"/"TODO". Tasks 7-9's test lists name exactly what each asserts, at the same granularity #934's/#982's/#983's own plans use for this codebase.

**3. Type consistency:** The entry shape (`toggleVia`, `steps`, `requirements`, `limitations`) defined in Task 5 is read identically by Tasks 4 (toggle), 7 (vocabulary), and 8 (execution); `createZone`'s parameter shape (Task 6) matches what Task 5's table entries and Task 8's executor both pass.

**4. Review Focus:** All five bullets (toggle-off symmetry, Off-Guard duration, exact-source exclusion, follow-then-remove-on-delete, per-entry-only hash disabling) are each pinned to a named test in Tasks 1, 2, 4, 5, and 6.

**Corrections found while writing this plan:** the most consequential is Investigation finding 2 — the spec's own stated Balance-check consequences for uneven ground don't match the real PF2e Balance action text, a genuine rules deviation CLAUDE.md requires correcting rather than shipping as written. The second is Investigation finding 1 — Go Dark and Conjure Storm, two of the spec's own three worked examples, already carry a native toggle mechanism in the real system data that makes the spec's own hand-rolled toggle design unnecessary for them, caught by reading the real item rule elements rather than trusting the spec's "RollOption/Aura markers" note as just descriptive color.
