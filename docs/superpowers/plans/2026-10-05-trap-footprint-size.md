# Trap Footprint Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A placed trap can occupy more than a single grid cell (2×1, 1×2, or 2×2), for visual/tactical variety — today every trap is hard-coded to a 1×1 footprint, even though the detect/trigger geometry (#753) already supports any size.

**Architecture:** A new pure function picks a footprint size per trap, seeded and deterministic like every other per-room roll in this codebase. `spawnCreatures` (`scripts/foundry-api.mjs`) gains a new per-entry `tokenSize` override, mirroring its existing `img`/`imgFallback` override convention, so the spawned hazard actor's own `prototypeToken.width`/`height` reflects the chosen size — `spawnCreatures`'s own existing placement logic (`freeSpotInRect` with `tw`/`th` already read from the actor) and #753's own `classifyTrapMove` geometry both already work correctly with any footprint size, with zero further changes needed to either.

**Tech Stack:** Vanilla ES modules, Vitest.

**Spec:** None — bounded addition, no spec file. This plan implements GitHub issue #757 directly.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real new mechanic: minor bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- No real `pf2e.hazards` compendium entry has a larger-than-1×1 `prototypeToken` size (confirmed live this session, all 53 entries checked) — footprint size is a module-invented convention, not derived from PF2e data, and must be picked independently of which specific hazard got selected.
- The size distribution is fixed (user-approved, not re-litigated here): 70% stay 1×1, 20% become an elongated 2×1 or 1×2 (even split between the two orientations), 10% become 2×2.
- `#753`'s own `classifyTrapMove`/detect/trigger geometry and `spawnCreatures`'s own placement logic (`freeSpotInRect`) are **not modified** — both already handle any footprint size correctly; this plan only adds a way to actually request a larger one.

## Review Focus

- **The footprint roll must be deterministic for the same seed/room**, matching every other seeded per-room decision in this codebase (`trapRollSucceeds`, `roomKindAt`, etc.) — a non-deterministic roll would make a dungeon non-reproducible from its own seed.
- **A `tokenSize` override must only ever affect the ONE spawned entry it's attached to**, never leak into a call's own shared `img`/`imgFallback`-style call-level defaults — `spawnCreatures` is used for far more than traps (combat encounters, cover items, summons), so a careless implementation could accidentally apply a trap's footprint override to an unrelated spawn in the same batch call.
- **A trap placed in a room too small for its rolled footprint must not crash or silently vanish** — `freeSpotInRect`'s own existing fallback (confirmed current: falls back to an un-validated position when no free spot of the requested size exists) already covers this; this plan relies on that existing behavior rather than adding new robustness, but it's worth confirming live that a worst-case tiny room with a 2×2 roll still produces a placed, usable trap.
- **The 2×1 vs 1×2 orientation split must be genuinely ~50/50**, not accidentally always-one-direction due to a roll/threshold off-by-one.
- **`entry.tokenSize` must be optional** — every existing `spawnCreatures` call site (combat encounters, cover items, summons, none of which know or care about this new parameter) must continue to work completely unchanged.

---

### Task 1: `trapFootprintSize` — the pure sizing roll

**Files:**
- Modify: `scripts/trap-mechanics.mjs` (new `trapFootprintSize`, new `import` line)
- Test: `tests/trap-mechanics.test.mjs`

**Interfaces:**
- Produces: `export function trapFootprintSize(seed, roomId): {width: number, height: number}`. Consumed by Task 3.

- [x] **Step 1: Write the failing tests**

Add to `tests/trap-mechanics.test.mjs` (add `trapFootprintSize` to the existing import from `../scripts/trap-mechanics.mjs`):

```js
describe('trapFootprintSize', () => {
  it('is deterministic for the same seed and roomId', () => {
    expect(trapFootprintSize('alpha', 'room-5')).toEqual(trapFootprintSize('alpha', 'room-5'));
  });

  it('is always one of 1x1, 2x1, 1x2, or 2x2', () => {
    const valid = [
      { width: 1, height: 1 },
      { width: 2, height: 1 },
      { width: 1, height: 2 },
      { width: 2, height: 2 },
    ];
    for (let i = 0; i < 500; i += 1) {
      const size = trapFootprintSize('sweep-seed', `room-${i}`);
      expect(valid).toContainEqual(size);
    }
  });

  it('stays 1x1 at approximately 70% across a large sample', () => {
    let ones = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i += 1) {
      const size = trapFootprintSize('rate-seed', `room-${i}`);
      if (size.width === 1 && size.height === 1) ones += 1;
    }
    const rate = ones / trials;
    expect(rate).toBeGreaterThan(0.65);
    expect(rate).toBeLessThan(0.75);
  });

  it('splits the elongated case roughly evenly between 2x1 and 1x2', () => {
    let wide = 0;
    let tall = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i += 1) {
      const size = trapFootprintSize('orientation-seed', `room-${i}`);
      if (size.width === 2 && size.height === 1) wide += 1;
      if (size.width === 1 && size.height === 2) tall += 1;
    }
    expect(wide).toBeGreaterThan(0);
    expect(tall).toBeGreaterThan(0);
    const ratio = wide / (wide + tall);
    expect(ratio).toBeGreaterThan(0.35);
    expect(ratio).toBeLessThan(0.65);
  });

  it('produces 2x2 at approximately 10% across a large sample', () => {
    let squares = 0;
    const trials = 5000;
    for (let i = 0; i < trials; i += 1) {
      const size = trapFootprintSize('square-rate-seed', `room-${i}`);
      if (size.width === 2 && size.height === 2) squares += 1;
    }
    const rate = squares / trials;
    expect(rate).toBeGreaterThan(0.07);
    expect(rate).toBeLessThan(0.13);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/trap-mechanics.test.mjs -t "trapFootprintSize"`
Expected: FAIL — `trapFootprintSize is not a function`.

- [x] **Step 3: Write `trapFootprintSize`**

Add this import to the top of `scripts/trap-mechanics.mjs` (currently has no imports at all):

```js
import { splitmix32, seedFromString } from "./prng.mjs";
```

Add the function, directly after `trapDetectionDC`:

```js
/** #757: a trap's footprint size -- PF2e's own hazard data never
 * specifies one larger than 1x1 (confirmed live against all 53
 * pf2e.hazards entries), so this is a module-invented, seeded
 * convention for visual/tactical variety: 70% stay 1x1, 20% become an
 * elongated 2x1 or 1x2 (even split), 10% become 2x2. */
export function trapFootprintSize(seed, roomId) {
  const rand = splitmix32(seedFromString(`${seed}-trap-footprint-${roomId}`));
  const roll = rand();
  if (roll < 0.7) return { width: 1, height: 1 };
  if (roll < 0.9) {
    return rand() < 0.5 ? { width: 2, height: 1 } : { width: 1, height: 2 };
  }
  return { width: 2, height: 2 };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/trap-mechanics.test.mjs -t "trapFootprintSize"`
Expected: PASS, all 5 tests green.

- [x] **Step 5: Run the full test file to confirm no regression**

Run: `npx vitest run tests/trap-mechanics.test.mjs`
Expected: PASS, every existing test in this file still green.

- [x] **Step 6: Commit**

```bash
git add scripts/trap-mechanics.mjs tests/trap-mechanics.test.mjs
git commit -m "feat(#757): add trapFootprintSize seeded sizing roll

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `spawnCreatures` gains a per-entry `tokenSize` override

**Files:**
- Modify: `scripts/foundry-api.mjs` (`spawnCreatures`)
- Test: wherever `spawnCreatures` is already unit-tested, if anywhere (check `tests/foundry-api.test.mjs` or similar before writing a new test file — re-use its existing fixture/stub pattern if one exists; if `spawnCreatures` has no existing unit-test coverage at all, this task's own change is Foundry-glue in the same category as the rest of that function, and should be verified live in Task 3 instead rather than inventing a new mocking harness for a single new parameter)

**Interfaces:**
- Consumes: nothing from Task 1 directly (this task is independent plumbing).
- Produces: `spawnCreatures(entries, options)` now also reads `entry.tokenSize` (shape `{width, height}`, optional) per entry. Consumed by Task 3.

- [ ] **Step 1: Check for existing test coverage**

```bash
grep -rln "spawnCreatures" tests/
```

If a test file covers `spawnCreatures` directly with a real stub/fixture harness, add a new test there asserting that an entry with `tokenSize: {width: 2, height: 1}` produces a created actor whose `prototypeToken.width`/`.height` match, and that an entry WITHOUT `tokenSize` is completely unaffected (still defaults to whatever the source document's own prototypeToken size already was). If no such file/harness exists, skip to Step 2 and rely on Task 3's live verification instead.

- [ ] **Step 2: Add the override**

In `scripts/foundry-api.mjs`, change:

```js
        const overrides = {
          "ownership.default": 0,
          "system.details.alliance": alliance,
          "prototypeToken.disposition": disposition,
          ...(art ? { img: art, "prototypeToken.texture.src": art } : {}),
        };
```

to:

```js
        const overrides = {
          "ownership.default": 0,
          "system.details.alliance": alliance,
          "prototypeToken.disposition": disposition,
          ...(art ? { img: art, "prototypeToken.texture.src": art } : {}),
          // #757: an entry-level footprint-size override, mirroring the
          // existing per-entry img/imgFallback convention just above --
          // entries that don't set it are completely unaffected.
          ...(entry.tokenSize
            ? {
                "prototypeToken.width": entry.tokenSize.width,
                "prototypeToken.height": entry.tokenSize.height,
              }
            : {}),
        };
```

- [ ] **Step 3: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS, every test in the repo green — in particular, every existing `spawnCreatures` call site (combat encounters, cover items, summons) passes no `tokenSize` on any entry, so this change is additive-only for them.

- [ ] **Step 4: Commit**

```bash
git add scripts/foundry-api.mjs
git commit -m "feat(#757): add entry-level tokenSize override to spawnCreatures

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the footprint roll into trap placement, live-verify, version bump

**Files:**
- Modify: `scripts/dungeon-scene.mjs` (`populateSlotTrap`)
- Modify: `module.json`

**Interfaces:**
- Consumes: `trapFootprintSize(seed, roomId)` (Task 1), `spawnCreatures`'s new `tokenSize` entry field (Task 2).
- Produces: nothing further in this plan consumes it — this is the feature's final wiring.

No unit test: `populateSlotTrap` is Foundry-glue with no existing unit-test harness (confirmed by this codebase's own established precedent for this exact function). Verified live in Step 2.

- [ ] **Step 1: Wire the roll into `populateSlotTrap`**

Add `trapFootprintSize` to the existing import from `./trap-mechanics.mjs` in `scripts/dungeon-scene.mjs` (check the current import list first; add a new import line if none exists yet from that file).

Change:

```js
  const [spawned] = await api.spawnCreatures(
    [{ pack: trap.pack, id: trap.id }],
    {
      originArea: {
        x: toPixels(rect.gx),
        y: toPixels(rect.gy),
        width: toPixels(rect.gw),
        height: toPixels(rect.gh),
      },
      disposition: 0,
      hidden: true,
      extraFlags: { [MODULE_ID]: { dungeonSlot: slot, trapHazard: true } },
    },
  );
```

to:

```js
  const tokenSize = trapFootprintSize(seed, roomId);
  const [spawned] = await api.spawnCreatures(
    [{ pack: trap.pack, id: trap.id, tokenSize }],
    {
      originArea: {
        x: toPixels(rect.gx),
        y: toPixels(rect.gy),
        width: toPixels(rect.gw),
        height: toPixels(rect.gh),
      },
      disposition: 0,
      hidden: true,
      extraFlags: { [MODULE_ID]: { dungeonSlot: slot, trapHazard: true } },
    },
  );
```

- [ ] **Step 2: Live-verify with `foundry-rest`**

Generate several real dungeon runs (varying seeds) and, for each, read back every trap hazard token's own size:

```bash
echo 'const sizes = canvas.scene.tokens.filter(t => t.getFlag("pf2e-dungeon-crawl", "trapHazard")).map(t => ({width: t.width, height: t.height})); return sizes;' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected, across several real runs: a mix of `{1,1}`/`{2,1}`/`{1,2}`/`{2,2}` sizes in roughly the 70/20/10 proportions over enough samples, and every reported token actually exists on the scene at a real, sane position (no overlap with room geometry/walls — spot-check at least one 2×2 trap visually or via its own `x`/`y` against the room's own rect bounds). Confirm a trap placed in a visibly small/cramped room still produces a usable (even if awkwardly positioned) trap rather than erroring.

- [ ] **Step 3: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real new mechanic), using whatever the fetch above shows as current.

- [ ] **Step 4: Commit**

```bash
git add scripts/dungeon-scene.mjs module.json
git commit -m "feat(#757): place traps with a variable, seeded footprint size

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #757's own ask — "extend trap placement to support a configurable footprint size (not just 1x1)" — is fully covered: Task 1 decides the size, Task 2 lets `spawnCreatures` apply it, Task 3 wires it into the one real call site (`populateSlotTrap`). The issue's own note that this "likely depends on the tile-based visual representation sub-issue" was investigated and found moot (#758 closed as superseded by #753's already-shipped token-based reveal) — this plan correctly designs against the existing Token representation. No gaps found.

**2. Placeholder scan:** No TBD/TODO, no "add appropriate handling" steps. Task 2's Step 1 gives an explicit, real contingency (check for existing test coverage, use it if present, defer to live verification if not) rather than assuming either way.

**3. Type consistency:** `trapFootprintSize(seed, roomId): {width, height}` (Task 1) is invoked with the identical argument order and consumed with the identical field names (`width`/`height`) in Task 3's wiring and Task 2's own `entry.tokenSize` shape. `spawnCreatures`'s new `entry.tokenSize` field name is defined once (Task 2) and used identically at its one real call site (Task 3).

**4. Review Focus:** All five items (seeded determinism, no cross-entry leakage, too-small-room fallback, genuine ~50/50 orientation split, optional/backward-compatible parameter) each have a dedicated test or explicit verification step. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-trap-footprint-size.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Native**, because this is a small, well-isolated addition (one new pure function, one additive parameter on a shared function, one call-site wiring) with no design surface for independent subagents to diverge on, and the live verification in Task 3 is the only genuinely novel risk, best done once carefully. Does the plan capture what you want, and which approach should we use?
