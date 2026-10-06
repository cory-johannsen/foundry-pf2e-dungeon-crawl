# Flanked Badge Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #769 — show a small "Flanked" badge on every flanked creature (hostile, PC or ally) during combat, as a purely visual, client-side overlay with no rules effect and no document writes.

**Supersedes:** `docs/superpowers/plans/2026-10-05-flanked-status-indicator.md` (PR #807), which toggled PF2e's real `off-guard` condition. Its first implementation was built and reviewed, and the review found the real condition is broader than PF2e's own flanking (off-guard to every attacker including ranged and non-flankers, vs. the flankers' melee Strikes only), plus a family of problems that only exist because of document writes (two-GM duplicate grants, overlapping-sync races, stale flags, cleanup gaps). The user chose a visual-only indicator instead (2026-10-05). That unmerged branch was discarded.

**Architecture:** A new `scripts/flanking-indicator.mjs` holds three small pieces: a pure `computeFlankedTokenIds(placeables)` (uses PF2e's own `Token#isFlanking`, so the geometry is exactly what attack rolls use), a `createFlankedIndicator(deps)` manager that diffs the flanked set against the badges it owns (create / keep / destroy, coalesced with a deferred scheduler), and a PIXI `createPixiBadge(placeable)` that adds a named child container to the token placeable so it follows the token's animation and is destroyed with it. `registerFlankedIndicator()` wires Foundry hooks. Every client draws its own badges from live token positions — nothing is stored, so there is no GM gating, no concurrency with other clients, and no cleanup of documents.

**Tech Stack:** Vanilla ES modules, PIXI (Foundry v14.368, already used in `scripts/module.mjs`), Vitest.

**Spec:** None — bounded; the design was presented in chat and approved by the user (visual-only badge, client-side, combat-gated).

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A new feature: **minor** bump. Take the highest of `origin/main`'s version and any open PR's version and bump its minor; never reuse a number (two collisions already happened on this repo).
- **No document writes of any kind** — no actor/token/combat updates, flags, conditions or effect items. The indicator is derived display only.
- Flanking geometry is **never reimplemented** — it calls PF2e's own `Token#isFlanking(flankee)` on the rendered placeables (confirmed live on Foundry 14.368 + the installed PF2e system: `typeof token.isFlanking === "function"`).
- The badge only exists while a started Combat on the **currently viewed scene** exists (`game.combat?.started` and `game.combat.scene.id === canvas.scene.id`); otherwise every badge is destroyed.
- The badge is a child of the token placeable (`placeable.addChild`), so a token the user cannot see (hidden / out of vision) shows no badge — this must not leak the existence of a hidden token.
- The deferred scheduler must work in a **hidden browser tab** (the foundry-rest relay tab is hidden and `requestAnimationFrame` never fires there): use `setTimeout`, not `requestAnimationFrame`.
- Locale key `PF2EDC.Dungeon.Combat.FlankedBadge` = "Flanked" (matches the existing `PF2EDC.Dungeon.Combat.*` key family in `lang/en.json`).
- `isPositionChange` is exported from `scripts/placement.mjs` (line ~127); `scripts/module.mjs` does not import it today — add the import, do not duplicate the function.

## Review Focus

- **A move by a token that is not itself flanked can change whether a different token is flanked** (flanking is a three-body relationship). The scheduler must recompute every combat token on any relevant movement, not only the mover. Task 1's tests recompute from the full placeable list; Task 2 wires every movement-relevant hook to the same `schedule()`.
- **A token redraw can discard children.** If Foundry redraws a token placeable (`redraw` render flag, texture change), the badge child may be destroyed or detached. The manager must treat a badge whose `isAttached(placeable)` is false as missing and recreate it — pinned by a Task 1 test with a badge that reports detached.
- **Combat ending by any path** (resolved, GM deletes it from the tracker, scene change, canvas teardown) must destroy every badge. Task 2 wires `deleteCombat`, `canvasTearDown` and the no-combat branch of `refresh`.
- **The badge must never appear outside a started combat or for tokens on another scene** — Task 1's no-combat test and Task 2's `getCombat` predicate.
- **Tokens that leave the combat or are deleted** must lose their badge (the manager destroys badges whose token is no longer in the placeable list), and destroying an already-destroyed badge must be harmless.
- **The feature must write nothing** — Task 1 asserts no `update` is called on any fake actor/token during a full refresh cycle.

---

### Task 1: Pure geometry check and badge manager

**Files:**
- Create: `scripts/flanking-indicator.mjs`
- Test: `tests/flanking-indicator.test.mjs`

**Interfaces:**
- Produces: `computeFlankedTokenIds(placeables): Set<string>` — ids of placeables that at least one OTHER placeable reports flanking. A placeable needs a truthy `id` and `actor` to be considered (as target or flanker); a throwing `isFlanking` counts as "not flanking".
- Produces: `createFlankedIndicator(deps): { refresh(), schedule(), clear(), badgeCount() }` where `deps = { getCombat(), getPlaceables(combat), createBadge(placeable), defer(fn), onError?(err) }` and a badge is `{ destroy(), isAttached(placeable): boolean }`.
- Consumed by: Task 2 (`createPixiBadge`, `registerFlankedIndicator` live in the same file and use these).

- [x] **Step 1: Write the failing tests**

Create `tests/flanking-indicator.test.mjs`:

```js
import { describe, it, expect, vi } from "vitest";
import {
  computeFlankedTokenIds,
  createFlankedIndicator,
} from "../scripts/flanking-indicator.mjs";

// `flanking` = ids of tokens THIS token is flanking (what Token#isFlanking
// would return true for).
function token(id, { flanking = [], actor = true } = {}) {
  return {
    id,
    actor: actor ? { id: `actor-${id}`, update: vi.fn() } : null,
    document: { update: vi.fn() },
    isFlanking: vi.fn((target) => flanking.includes(target.id)),
  };
}

describe("computeFlankedTokenIds", () => {
  it("flags a token another token reports flanking", () => {
    const a = token("a", { flanking: ["target"] });
    const target = token("target");
    expect([...computeFlankedTokenIds([a, target])]).toEqual(["target"]);
  });

  it("flags a friendly token too (any alliance, any actor)", () => {
    const enemy = token("enemy", { flanking: ["pc"] });
    const pc = token("pc");
    expect(computeFlankedTokenIds([enemy, pc]).has("pc")).toBe(true);
  });

  it("returns an empty set when nobody is flanking anybody", () => {
    expect(computeFlankedTokenIds([token("a"), token("b")]).size).toBe(0);
    expect(computeFlankedTokenIds([]).size).toBe(0);
  });

  it("a token never counts as flanking itself", () => {
    const a = token("a", { flanking: ["a"] });
    expect(computeFlankedTokenIds([a]).size).toBe(0);
  });

  it("re-evaluates every token: a different token's flanking changes who is flanked", () => {
    const flanker = token("flanker", { flanking: ["x"] });
    const x = token("x");
    const y = token("y");
    expect([...computeFlankedTokenIds([flanker, x, y])]).toEqual(["x"]);
    flanker.isFlanking.mockImplementation((t) => t.id === "y");
    expect([...computeFlankedTokenIds([flanker, x, y])]).toEqual(["y"]);
  });

  it("ignores tokens with no actor, as target and as flanker", () => {
    const ghost = token("ghost", { flanking: ["t"], actor: false });
    const t = token("t");
    const ghostTarget = token("g2", { actor: false });
    const real = token("real", { flanking: ["g2"] });
    expect(computeFlankedTokenIds([ghost, t]).size).toBe(0);
    expect(computeFlankedTokenIds([real, ghostTarget]).size).toBe(0);
  });

  it("treats a throwing isFlanking as not flanking", () => {
    const bad = token("bad");
    bad.isFlanking.mockImplementation(() => {
      throw new Error("token mid-destroy");
    });
    expect(computeFlankedTokenIds([bad, token("t")]).size).toBe(0);
  });
});

function makeDeps({ combat = { id: "c1" }, placeables = [] } = {}) {
  const state = { combat, placeables, badges: [], deferred: [] };
  const deps = {
    getCombat: vi.fn(() => state.combat),
    getPlaceables: vi.fn(() => state.placeables),
    createBadge: vi.fn((p) => {
      const badge = {
        tokenId: p.id,
        destroyed: false,
        destroy: vi.fn(() => {
          badge.destroyed = true;
        }),
        isAttached: vi.fn(() => !badge.destroyed),
      };
      state.badges.push(badge);
      return badge;
    }),
    defer: vi.fn((fn) => state.deferred.push(fn)),
    onError: vi.fn(),
  };
  return { state, deps };
}

describe("createFlankedIndicator", () => {
  it("creates one badge per flanked token", () => {
    const a = token("a", { flanking: ["t"] });
    const b = token("b", { flanking: ["t"] });
    const t = token("t");
    const { deps } = makeDeps({ placeables: [a, b, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    expect(deps.createBadge).toHaveBeenCalledTimes(1);
    expect(deps.createBadge.mock.calls[0][0].id).toBe("t");
    expect(ind.badgeCount()).toBe(1);
  });

  it("keeps a healthy badge across refreshes instead of recreating it", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    ind.refresh();
    expect(deps.createBadge).toHaveBeenCalledTimes(1);
  });

  it("destroys a badge once its token is no longer flanked", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps, state } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    a.isFlanking.mockImplementation(() => false);
    ind.refresh();
    expect(state.badges[0].destroy).toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(0);
  });

  it("recreates a badge that reports itself detached (token was redrawn)", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps, state } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    state.badges[0].isAttached.mockImplementation(() => false);
    ind.refresh();
    expect(deps.createBadge).toHaveBeenCalledTimes(2);
    expect(state.badges[0].destroy).toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(1);
  });

  it("destroys the badge of a token that left the combat or was deleted", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps, state } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    state.placeables = [a];
    ind.refresh();
    expect(state.badges[0].destroy).toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(0);
  });

  it("with no started combat: creates nothing and clears every existing badge", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps, state } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    state.combat = null;
    ind.refresh();
    expect(state.badges[0].destroy).toHaveBeenCalled();
    expect(ind.badgeCount()).toBe(0);
    expect(deps.getPlaceables).toHaveBeenCalledTimes(1); // not asked again
  });

  it("clear() destroys every badge", () => {
    const a = token("a", { flanking: ["t", "u"] });
    const t = token("t");
    const u = token("u");
    const { deps, state } = makeDeps({ placeables: [a, t, u] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    expect(ind.badgeCount()).toBe(2);
    ind.clear();
    expect(state.badges.every((b) => b.destroy.mock.calls.length === 1)).toBe(true);
    expect(ind.badgeCount()).toBe(0);
  });

  it("schedule() coalesces many calls into a single deferred refresh", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps, state } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.schedule();
    ind.schedule();
    ind.schedule();
    expect(state.deferred).toHaveLength(1);
    state.deferred[0]();
    expect(deps.getPlaceables).toHaveBeenCalledTimes(1);
    ind.schedule(); // a new pass can be scheduled after the first ran
    expect(state.deferred).toHaveLength(2);
  });

  it("reports a failing refresh through onError instead of throwing", () => {
    const { deps, state } = makeDeps();
    deps.getPlaceables.mockImplementation(() => {
      throw new Error("canvas not ready");
    });
    const ind = createFlankedIndicator(deps);
    ind.schedule();
    expect(() => state.deferred[0]()).not.toThrow();
    expect(deps.onError).toHaveBeenCalledTimes(1);
  });

  it("writes nothing: no actor or token update is ever called", () => {
    const a = token("a", { flanking: ["t"] });
    const t = token("t");
    const { deps } = makeDeps({ placeables: [a, t] });
    const ind = createFlankedIndicator(deps);
    ind.refresh();
    ind.refresh();
    ind.clear();
    for (const p of [a, t]) {
      expect(p.actor.update).not.toHaveBeenCalled();
      expect(p.document.update).not.toHaveBeenCalled();
    }
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/flanking-indicator.test.mjs`
Expected: FAIL — the module `scripts/flanking-indicator.mjs` does not exist.

- [x] **Step 3: Write the pure logic and the manager**

Create `scripts/flanking-indicator.mjs`:

```js
/**
 * Flanked badge (#769): a purely visual, client-side "Flanked" badge on
 * every flanked token during combat. It writes nothing -- no condition, no
 * flag, no effect item -- so it cannot disagree with attack rolls, race
 * with other clients, or leave stale state behind. Flanking itself is
 * decided by PF2e's own `Token#isFlanking` (the same geometry attack rolls
 * use), never reimplemented here.
 *
 * The first design toggled PF2e's real `off-guard` condition; review found
 * that applies off-guard to EVERY attacker (ranged, non-flankers), broader
 * than PF2e's flanking rule (the flankers' melee Strikes only), so the
 * user chose this visual-only version instead.
 */

const MODULE_ID = "pf2e-dungeon-crawl";
const BADGE_NAME = "pf2edc-flanked";

function safeIsFlanking(flanker, target) {
  try {
    return !!flanker.isFlanking(target);
  } catch {
    return false; // a token mid-destroy etc.: treat as not flanking
  }
}

/** Ids of the placeables that at least one OTHER placeable is flanking.
 * Both sides need an `id` and an `actor`. */
export function computeFlankedTokenIds(placeables) {
  const flanked = new Set();
  for (const target of placeables) {
    if (!target?.id || !target.actor) continue;
    const isFlanked = placeables.some(
      (other) =>
        other !== target &&
        other?.actor &&
        typeof other.isFlanking === "function" &&
        safeIsFlanking(other, target),
    );
    if (isFlanked) flanked.add(target.id);
  }
  return flanked;
}

/** Owns the badges for one client. `deps`: `getCombat()` -> the started
 * combat for the viewed scene or null; `getPlaceables(combat)` -> the
 * combat's token placeables; `createBadge(placeable)` -> `{ destroy(),
 * isAttached(placeable) }`; `defer(fn)` schedules `fn` shortly (must work
 * in a hidden tab); `onError(err)` receives a failed deferred refresh. */
export function createFlankedIndicator(deps) {
  const badges = new Map(); // tokenId -> badge

  function clear() {
    for (const badge of badges.values()) badge.destroy();
    badges.clear();
  }

  function refresh() {
    const combat = deps.getCombat();
    if (!combat) {
      clear();
      return;
    }
    const placeables = deps.getPlaceables(combat);
    const flanked = computeFlankedTokenIds(placeables);
    const present = new Set(placeables.map((p) => p.id));

    for (const [id, badge] of [...badges]) {
      if (!flanked.has(id) || !present.has(id)) {
        badge.destroy();
        badges.delete(id);
      }
    }
    for (const placeable of placeables) {
      if (!flanked.has(placeable.id)) continue;
      const existing = badges.get(placeable.id);
      if (existing?.isAttached(placeable)) continue;
      existing?.destroy(); // detached (token was redrawn): replace it
      badges.set(placeable.id, deps.createBadge(placeable));
    }
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    deps.defer(() => {
      scheduled = false;
      try {
        refresh();
      } catch (err) {
        deps.onError?.(err);
      }
    });
  }

  return { refresh, schedule, clear, badgeCount: () => badges.size };
}
```

(`MODULE_ID` and `BADGE_NAME` are used by Task 2's code in this same file; keeping the constants here now avoids a second edit to the header. If lint complains about unused constants before Task 2, leave them — Task 2 uses both.)

- [x] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/flanking-indicator.test.mjs`
Expected: PASS, all tests green.

- [x] **Step 5: Commit**

```bash
git add scripts/flanking-indicator.mjs tests/flanking-indicator.test.mjs
git commit -m "feat(#769): flanked-badge geometry check and manager

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The PIXI badge, hook wiring and locale

**Files:**
- Modify: `scripts/flanking-indicator.mjs` (add `createPixiBadge`, `registerFlankedIndicator`)
- Modify: `scripts/module.mjs` (import + one call)
- Modify: `lang/en.json` (one key)

**Interfaces:**
- Consumes: `createFlankedIndicator` (Task 1), `isPositionChange` from `./placement.mjs`.
- Produces: `registerFlankedIndicator(): indicator` — registers the hooks once and returns the indicator (useful for the live check).

No unit test: the PIXI badge and hook registration are Foundry-canvas glue with no existing test harness (same precedent as `module.mjs`'s `syncRoomFeatureControls`, which draws PIXI controls and is verified live). The decision logic they drive is covered by Task 1.

- [x] **Step 1: Add the locale key**

In `lang/en.json`, add next to the other `PF2EDC.Dungeon.Combat.*` keys (keep the file's alphabetical order):

```json
  "PF2EDC.Dungeon.Combat.FlankedBadge": "Flanked",
```

- [x] **Step 2: Add the PIXI badge and the hook registration**

Append to `scripts/flanking-indicator.mjs`, and add `import { isPositionChange } from "./placement.mjs";` at the top of the file under the header comment:

```js
/** Draws a small "Flanked" pill as a named child of the token placeable
 * (bottom-left), so it follows the token's animation, is hidden with the
 * token, and is destroyed with it. */
export function createPixiBadge(placeable) {
  const container = new PIXI.Container();
  container.name = BADGE_NAME;
  container.eventMode = "none";

  const style = CONFIG.canvasTextStyle.clone();
  style.fontSize = Math.max(14, Math.round(canvas.grid.size / 6));
  style.fill = 0xffffff;
  style.stroke = 0x000000;
  const label = new foundry.canvas.containers.PreciseText(
    game.i18n.localize("PF2EDC.Dungeon.Combat.FlankedBadge"),
    style,
  );
  const padX = 6;
  const padY = 3;
  label.anchor.set(0, 0);
  label.position.set(padX, padY);

  const pill = new PIXI.Graphics();
  pill.beginFill(0xb3261e, 0.92);
  pill.lineStyle(2, 0xffffff, 0.9);
  pill.drawRoundedRect(0, 0, label.width + padX * 2, label.height + padY * 2, 6);
  pill.endFill();

  container.addChild(pill);
  container.addChild(label);

  const tokenHeight =
    placeable.h ?? (placeable.document?.height ?? 1) * canvas.grid.size;
  container.position.set(2, tokenHeight - (label.height + padY * 2) - 2);
  placeable.addChild(container);

  return {
    destroy() {
      if (!container.destroyed) container.destroy({ children: true });
    },
    isAttached(p) {
      return !container.destroyed && container.parent === p;
    },
  };
}

/** Registers the hooks that keep each client's badges in sync. Every client
 * runs its own indicator: nothing is written, so there is no GM gating. */
export function registerFlankedIndicator() {
  const indicator = createFlankedIndicator({
    getCombat: () => {
      const combat = game.combat;
      return combat?.started && combat.scene?.id === canvas?.scene?.id
        ? combat
        : null;
    },
    getPlaceables: (combat) =>
      combat.combatants.map((c) => c.token?.object).filter(Boolean),
    createBadge: createPixiBadge,
    // setTimeout, not requestAnimationFrame: rAF never fires in a hidden
    // browser tab (e.g. the foundry-rest relay tab).
    defer: (fn) => setTimeout(fn, 50),
    onError: (err) =>
      console.error(`${MODULE_ID} | flanked indicator refresh failed`, err),
  });

  // Flanking is a three-body relationship: any token's move/visibility/size
  // change can change a DIFFERENT token's state, so every one of these
  // schedules a recompute of the whole combat.
  Hooks.on("updateToken", (doc, changes) => {
    if (doc.parent?.id !== canvas?.scene?.id) return;
    if (
      isPositionChange(changes) ||
      changes.hidden !== undefined ||
      changes.width !== undefined ||
      changes.height !== undefined ||
      changes.elevation !== undefined
    )
      indicator.schedule();
  });
  // A redraw can discard our child; the manager re-creates a detached badge.
  Hooks.on("refreshToken", (_token, flags) => {
    if (flags?.redraw || flags?.refreshVisibility) indicator.schedule();
  });
  for (const hook of ["updateCombat", "createCombatant", "deleteCombatant"])
    Hooks.on(hook, () => indicator.schedule());
  Hooks.on("canvasReady", () => indicator.schedule());
  // Combat deleted by ANY path, or the canvas going away: drop every badge now.
  Hooks.on("deleteCombat", () => indicator.clear());
  Hooks.on("canvasTearDown", () => indicator.clear());

  return indicator;
}
```

- [x] **Step 3: Wire it into `scripts/module.mjs`**

Add to `scripts/module.mjs`'s imports:

```js
import { registerFlankedIndicator } from "./flanking-indicator.mjs";
```

and call it once at top level, next to the other top-level `Hooks.on(...)` registrations (for example right after the `#753` trap hook / near the `canvasReady`/`canvasTearDown` room-feature registrations):

```js
registerFlankedIndicator();
```

(Check the current file for the right neighbourhood by content, not line number. `Hooks`, `game`, `canvas` and `PIXI` are only touched inside callbacks, so calling this at module load is safe, same as the neighbouring registrations.)

- [x] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS. `module.mjs` is never imported by the test suite, and `tests/flanking-indicator.test.mjs` only imports the pure functions (PIXI/`foundry`/`Hooks` are referenced only inside `createPixiBadge`/`registerFlankedIndicator`, which no test calls).

- [x] **Step 5: Commit**

```bash
git add scripts/flanking-indicator.mjs scripts/module.mjs lang/en.json
git commit -m "feat(#769): draw a Flanked badge on flanked tokens during combat

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Docs, version, retire the old plan, live-verify

**Files:**
- Modify: `docs/architecture.md`, `tools/generate-architecture-graph.mjs` (if needed)
- Modify: `module.json` (minor bump)
- Modify: `docs/superpowers/plans/2026-10-05-flanked-status-indicator.md` (add a superseded note)

- [x] **Step 1: Architecture docs**

Run the `update-architecture-docs` skill (`.claude/skills/update-architecture-docs/SKILL.md`): regenerate the mermaid block with `node tools/generate-architecture-graph.mjs`. The new file `scripts/flanking-indicator.mjs` imports `placement.mjs` and is imported by `module.mjs`. If it lands in the generated "Other" group, add `"scripts/flanking-indicator.mjs"` to the most fitting group in `GROUPS` (the "Combat automation (in-module heuristic)" group is the closest), and add one sentence to that subsystem's prose in `docs/architecture.md`: a client-side, write-nothing flanked badge (#769). Check the "Two intentional circular imports" section is unaffected.

- [x] **Step 2: Mark the old plan superseded**

At the very top of `docs/superpowers/plans/2026-10-05-flanked-status-indicator.md`, above its title, add:

```markdown
> **SUPERSEDED (2026-10-05):** replaced by `2026-10-05-flanked-badge-indicator.md`. This plan toggled PF2e's real `off-guard` condition; review found that applies off-guard to every attacker (broader than PF2e's own flanking) and introduced multi-client write races and cleanup gaps, so the user chose a visual-only badge instead. Do not implement this plan.
```

- [x] **Step 3: Bump `module.json`'s version (minor)**

```bash
git fetch origin main -q && git show origin/main:module.json | grep '"version"'
for pr in $(gh pr list --json number -q '.[].number'); do gh pr diff $pr | grep -E '^\+\s+"version"'; done
```

Take the highest version seen, bump its minor (e.g. `0.65.3` -> `0.66.0`), never reuse a number. Re-check immediately before committing and after any rebase.

- [x] **Step 4: Run the full suite and commit**

Run: `npx vitest run` (a known wall-clock flake `tests/dungeon-reseed-sweep.test.mjs`, issue #787, can fail under load; if it is the only failure, re-run it alone).

```bash
git add docs/architecture.md tools/generate-architecture-graph.mjs module.json docs/superpowers/plans/2026-10-05-flanked-status-indicator.md
git commit -m "docs(#769): architecture, version bump, supersede the condition-toggle plan

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Live-verify (controller + user, after the world updates)**

With a started combat where two opposing tokens flank a third, read what the canvas actually has (this works even in the hidden relay tab, because the display objects exist regardless of rendering):

```bash
echo 'const c = game.combat; if (!c?.started) return "no started combat"; const toks = c.combatants.map(cb => cb.token?.object).filter(Boolean); return toks.map(t => ({ name: t.name, badge: t.children.some(ch => ch.name === "pf2edc-flanked"), flankedByAnyone: toks.some(o => o !== t && o.actor && o.isFlanking(t)) }));' | .claude/skills/foundry-rest/foundry-exec.sh
```

Expected: `badge === flankedByAnyone` for every combatant. Also confirm the user sees the red "Flanked" pill at the bottom-left of a flanked token on their own screen, that it disappears when a flanker moves away, that it follows the token while it moves, and that no badges remain after the combat is deleted from the tracker. Confirm nothing was written: no flanked token gained an `off-guard` condition from this module (`game.combat.combatants.map(cb => cb.actor?.hasCondition?.("off-guard"))` is unchanged by flanking alone).

---

## Self-Review

**1. Spec coverage:** The approved design (client-side badge, no stored state, PF2e's own `isFlanking`, three-body recompute on movement/visibility/size/combat events, combat-gated to a started combat on the viewed scene, destroyed on combat end by any path, hidden-token safe, minor bump, discard the condition-toggle branch) maps to Tasks 1-3: pure check + manager (Task 1), PIXI badge + hooks + locale (Task 2), docs/version/supersede/live verification (Task 3).

**2. Placeholder scan:** No TBD/TODO. Every code block is the complete real text.

**3. Type consistency:** `createFlankedIndicator(deps)` returns `{ refresh, schedule, clear, badgeCount }`; Task 2's `registerFlankedIndicator` uses `schedule`/`clear` only. A badge is `{ destroy(), isAttached(placeable) }` in the manager, Task 1's test fake, and `createPixiBadge`'s return value. `computeFlankedTokenIds(placeables)` takes placeables with `{ id, actor, isFlanking }`, matching both the tests' fake tokens and the real `Token` placeables.

**4. Review Focus:** Each of the six items has an owner: three-body recompute (Task 1 test + Task 2 hooks), redraw/detached badge (Task 1 test), combat ending by any path (Task 2 hooks + Task 1 no-combat test), never outside a started combat/viewed scene (Task 1 test + `getCombat` predicate), tokens leaving the combat (Task 1 test), writes nothing (Task 1 test). No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-flanked-badge-indicator.md`.
