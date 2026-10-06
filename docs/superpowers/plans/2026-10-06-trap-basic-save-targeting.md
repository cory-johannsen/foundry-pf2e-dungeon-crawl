# Trap Basic-Save Targeting And GM Guard Rails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix #839 — extend this module's trap automation to cover a hazard whose routine is a single PF2e **basic save** (Reflex/Fortitude/Will) with a structured damage formula, including the area-effect case, and give the GM an explicit, correctly-scoped guard rail (not silence) for every hazard still outside automation, so a GM resolving one manually is never left guessing who's actually affected.

**Premise correction (confirmed by direct code reading, `scripts/trap-combat.mjs`, current `main`):** #839's own title says "traps can strike the whole party." The module's existing automated trigger path (`triggerTrap`/`handleTrapTokenMove`) is **already single-target-only and already correct**: it only ever resolves against the one `{actor, token}` passed in (the triggering creature, or the disable-attempter on a critical failure), via a direct `target.actor.applyDamage(...)` call that never touches canvas token selection. The real gap is that `triggerTrap` silently no-ops (does *nothing at all*, not even a chat message beyond the generic "triggered" line) whenever a spawned hazard has no `"strike"`-type action — which happens by design: `trap-library.mjs`'s own `selectTrap` explicitly falls back to a non-automatable hazard ("GM-narrated", #134/#135's own prior decision) when no automatable candidate is in level range. A GM then has to resolve that hazard by hand in vanilla PF2e UI with zero guidance from this module about who is actually affected — the most plausible real path to a GM applying damage to the whole party by mistake.

**Scope decisions (resolved this session via two rounds of AskUserQuestion, grounded in a live survey of all 24 real trap-tagged hazards in `pf2e.hazards`):**
1. The module never auto-raises anything or auto-resolves full hazard initiative/reactions — true multi-round/complex hazards stay GM-narrated (unchanged from #134/#135).
2. Extend automation to cover a hazard whose action item's description embeds a **basic** save (`@Check[reflex|dc:N|basic|...]`) plus a structured **damage** formula (`@Damage[...]`) — whether single-target (no area language at all) or area (`"creatures within N feet"`). This is a narrow, bounded parse of PF2e's own well-defined inline-enricher micro-syntax (every hazard in the compendium is authored with it), not open prose parsing.
3. Everything else (no "basic" keyword, no `@Damage[...]`, a non-damage effect like a condition or banishment, or an explicit `"rolls initiative"` hazard) gets the guard-rail fallback: a GM whisper surfacing the hazard's own raw description text plus which party members are actually within a generous range of it — never silence.

**Live survey (this session, `pf2e.hazards`, all 24 trap-tagged entries, confirmed via `getDocument` on every non-strike one):**
- 9 have a `"strike"`-type action (already automated, unchanged by this plan).
- Of the remaining 15: **3 cleanly match the basic-save-plus-damage shape** this plan automates — *Electric Latch Rune* (`@Check[reflex|dc:22|basic]` + `@Damage[3d12[electricity]]`, single-target, no area language), *Insistent Privacy Fence* (same shape, single-target), *Steam Vents* (`@Check[reflex|dc:24|basic|...]` + `@Damage[3d6[bludgeoning],3d6[fire]]`, **area**: `"all creatures within 15 feet"`).
- The other 12 stay guard-railed: no `@Check[...]` at all (*Hidden Pit*, *Bottomless Pit* — falling/Climb, no save), a save with no `"basic"` keyword (*Polymorph Trap*, *Pharaoh's Ward*, *Hallucination Powder Trap*, *Planar Rift*, *Slamming Door*), an effect that isn't damage (*Pharaoh's Ward*'s curse, *Hallucination Powder Trap*'s condition, *Planar Rift*'s banishment), an area only resolvable by cross-referencing a *referenced spell's* own stated area rather than this hazard's own text (*Fireball Rune* — explicitly excluded as a known limitation, not silently mis-parsed), or an explicit `"rolls initiative"`/complex multi-stage routine (*Wheel of Misery*, *Drowning Pit*, *Summoning Rune*, *Lava Flume Tube*).

**Architecture:** A new pure parser in `scripts/trap-mechanics.mjs` (`parseBasicSaveAction`/`basicSaveDamageMultiplier`, Foundry-free, unit-testable against the real description strings surveyed above) plus Foundry glue added to `triggerTrap` in `scripts/trap-combat.mjs`: the existing strike path is unchanged; when no strike exists, look for a qualifying basic-save action item among the hazard's own embedded Items, and either run it (rolling the save via PF2e's own `actor.saves[slug].roll(...)`, same calling convention `rollTrapDetection`/`rollTrapDisableAttempt` already use for Perception/skill rolls, then applying `Roll(formula)` damage scaled by the PF2e basic-save multiplier through the same `target.actor.applyDamage(...)` the strike path already uses) or, if nothing qualifies, whisper the GM a guard-rail message instead of silently returning `null`.

**Tech Stack:** Vanilla ES modules, Vitest, Foundry VTT / PF2e system APIs.

**Spec:** None — bounded by two resolved AskUserQuestion rounds and a real data survey; no further design ambiguity remains.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). A real new mechanic (basic-save trap automation): minor bump.
- Per CLAUDE.md's own "Game rules" section (PF2e rules are the source of truth, prefer the system's own implementation over reimplementing it): the save roll itself goes through PF2e's own `actor.saves[slug].roll(...)`, never a hand-rolled check; only the basic-save degree-of-success **damage multiplier** (0 / 0.5 / 1 / 2 — unambiguous PF2e RAW, not an invented simplification) is computed directly, because no `game.pf2e.Damage` helper is exposed on this install's API surface (confirmed live this session: `Object.keys(game.pf2e.Damage ?? {})` is `[]`).
- The parser (`parseBasicSaveAction`) must return `null` — never guess — for any shape outside its narrow, confirmed scope (no `"basic"` keyword, no `@Damage[...]`, an unrecognized damage-formula shape). A hazard it can't confidently parse falls through to the guard-rail path, never a best-effort partial resolution.
- Area-effect scanning reuses `withinSearchRange`/`footprint` (confirmed current, `scripts/trap-mechanics.mjs:139`, `scripts/placement.mjs:26`) — the exact same grid-distance primitive `handleTrapTokenMove`'s own detection-range check already uses. No new geometry code.
- Area/guard-rail scanning is scoped to **party members only**, matching `handleTrapTokenMove`'s own existing party-only trigger gate (`isPartyActor`, confirmed current) — a hostile creature also inside a blast radius per strict RAW is a known, deliberate, pre-existing scope limit (the trigger mechanism itself only ever reacts to a party token's movement), not a new gap this plan introduces.
- `triggerTrap`'s own existing strike-path behavior (confirmed current, `scripts/trap-combat.mjs:165-193`) is **byte-for-byte unchanged** — this plan only adds a new branch for when no strike action exists.

## Review Focus

- **A single-target basic-save hazard (Electric Latch Rune/Insistent Privacy Fence shape) must resolve against the triggering creature only** — the same single-target guarantee the existing strike path already has, now extended to saves.
- **An area basic-save hazard (Steam Vents shape) must resolve against every party member within the parsed radius, including the triggering creature itself** — not just the one who stepped on it, since that's the entire point of a real area effect.
- **The basic-save damage multiplier must be exactly 0/0.5/1/2 for critical success/success/failure/critical failure respectively**, roundestanding a half-damage result per PF2e's own rounding-down rule.
- **A hazard with a save but no `"basic"` keyword, or a save with no parseable `@Damage[...]`, must never be guessed at** — it falls through to the guard-rail whisper, not a partial or wrong automation.
- **The guard-rail whisper must name the real, current party members within range** (not the whole party unconditionally) alongside the hazard's own raw description, so even an un-automated hazard steers the GM away from an accidental party-wide application.

---

### Task 1: Pure basic-save action parser

**Files:**
- Modify: `scripts/trap-mechanics.mjs` (new `parseBasicSaveAction`, `basicSaveDamageMultiplier`)
- Test: `tests/trap-mechanics-basic-save.test.mjs`

**Interfaces:**
- Produces: `parseBasicSaveAction(descriptionHtml): {save, dc, damage: [{formula, type}], areaFeet} | null`; `basicSaveDamageMultiplier(outcome): number`.

- [ ] **Step 1: Write the failing tests, using the real surveyed description strings verbatim**

```js
import { describe, it, expect } from "vitest";
import { parseBasicSaveAction, basicSaveDamageMultiplier } from "../scripts/trap-mechanics.mjs";

// Real description HTML from pf2e.hazards, confirmed live this session (2026-10-06).
const ELECTRIC_LATCH_RUNE = `<p><strong>Trigger</strong> A creature grasps the door latch directly or with a tool</p><hr /><p><strong>Effect</strong> The trap deals @Damage[3d12[electricity]] damage to the triggering creature (@Check[reflex|dc:22|basic] save).</p>`;
const INSISTENT_PRIVACY_FENCE = `<p><strong>Trigger</strong> A creature touches the fence directly or with a tool or weapon</p><hr /><p><strong>Effect</strong> The fence deals @Damage[7d12[electricity]] damage to the triggering creature (@Check[reflex|dc:26|basic|traits:electricity,mechanical,trap,hazard] save).</p>`;
const STEAM_VENTS = `<p><strong>Trigger</strong> The trip wire is pulled or severed, typically because a creature walked through the square with the trip wire</p><hr /><p><strong>Effect</strong> Steam erupts from the pipes, dealing @Damage[3d6[bludgeoning],3d6[fire]]{3d6 bludgeoning damage and 3d6 fire damage} (@Check[reflex|dc:24|basic|name:Avoid the erupting steam|traits:mechanical,trap,hazard]) to all creatures within 15 feet. Creatures that critically fail their save are knocked prone.</p>`;
const SLAMMING_DOOR = `<p><strong>Effect</strong> The stone slab deals @Damage[3d8[bludgeoning]] damage to anyone beneath or adjacent to the slab (@Check[reflex|dc:17|traits:damaging-effect] save).</p>`;
const PHARAOHS_WARD = `<p><strong>Effect</strong> Each living creature within 60 feet must succeed at a @Check[will|dc:23] save or be subjected to the pharaoh's curse.</p>`;
const WHEEL_OF_MISERY = `<p><strong>Effect</strong> The wheel begins to spin and rolls initiative.</p>`;
const HIDDEN_PIT = `<p><strong>Effect</strong> The triggering creature falls in and takes falling damage (typically @Damage[10[bludgeoning]|options:fall-damage] damage).</p>`;

describe("#839 parseBasicSaveAction", () => {
  it("parses a single-target basic save with one damage term, no area", () => {
    expect(parseBasicSaveAction(ELECTRIC_LATCH_RUNE)).toEqual({
      save: "reflex", dc: 22, damage: [{ formula: "3d12", type: "electricity" }], areaFeet: null,
    });
  });

  it("parses a single-target basic save even with extra trailing segments", () => {
    expect(parseBasicSaveAction(INSISTENT_PRIVACY_FENCE)).toEqual({
      save: "reflex", dc: 26, damage: [{ formula: "7d12", type: "electricity" }], areaFeet: null,
    });
  });

  it("parses an area basic save with two damage terms and a labeled {..} suffix", () => {
    expect(parseBasicSaveAction(STEAM_VENTS)).toEqual({
      save: "reflex", dc: 24,
      damage: [{ formula: "3d6", type: "bludgeoning" }, { formula: "3d6", type: "fire" }],
      areaFeet: 15,
    });
  });

  it("returns null for a save with no \"basic\" keyword (Slamming Door, Pharaoh's Ward)", () => {
    expect(parseBasicSaveAction(SLAMMING_DOOR)).toBeNull();
    expect(parseBasicSaveAction(PHARAOHS_WARD)).toBeNull();
  });

  it("returns null for a hazard with no @Check at all (rolls initiative, or no save)", () => {
    expect(parseBasicSaveAction(WHEEL_OF_MISERY)).toBeNull();
  });

  it("returns null for a damage term this parser doesn't recognize (fall damage, no dice-die shape)", () => {
    expect(parseBasicSaveAction(HIDDEN_PIT)).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(parseBasicSaveAction(undefined)).toBeNull();
    expect(parseBasicSaveAction(null)).toBeNull();
  });
});

describe("#839 basicSaveDamageMultiplier", () => {
  it("is the exact PF2e basic-save scaling", () => {
    expect(basicSaveDamageMultiplier("criticalSuccess")).toBe(0);
    expect(basicSaveDamageMultiplier("success")).toBe(0.5);
    expect(basicSaveDamageMultiplier("failure")).toBe(1);
    expect(basicSaveDamageMultiplier("criticalFailure")).toBe(2);
  });

  it("is 0 for an unrecognized outcome rather than throwing", () => {
    expect(basicSaveDamageMultiplier(undefined)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/trap-mechanics-basic-save.test.mjs`
Expected: FAIL — neither function exists yet.

- [ ] **Step 3: Implement the parser**

Add to `scripts/trap-mechanics.mjs`:

```js
const SAVE_SLUGS = new Set(["reflex", "fortitude", "will"]);

/**
 * #839: parses a hazard action item's own description HTML for PF2e's own
 * inline-enricher syntax -- `@Check[<save>|dc:<n>|basic|...]` plus
 * `@Damage[<dice>d<faces>[<type>],...]`, optionally with an area phrase
 * ("creatures within N feet"). Returns null for anything outside this
 * narrow, confirmed shape -- no "basic" keyword, no parseable @Damage, or
 * no @Check at all -- rather than guessing at a hazard whose effect isn't
 * simple damage (a condition, banishment, initiative-rolling routine).
 * Deliberately does NOT resolve an area stated only via a referenced
 * spell's own stats (e.g. a hazard whose effect "casts Fireball" without
 * restating Fireball's own 20-foot burst in its own text) -- a known,
 * excluded case (#839's own plan), not a silent mis-parse.
 */
export function parseBasicSaveAction(descriptionHtml) {
  if (typeof descriptionHtml !== "string") return null;
  const checkMatch = /@Check\[([a-z]+)((?:\|[^\]]*)?)\]/i.exec(descriptionHtml);
  if (!checkMatch) return null;
  const save = checkMatch[1].toLowerCase();
  if (!SAVE_SLUGS.has(save)) return null;
  const segments = checkMatch[2].split("|").filter(Boolean);
  if (!segments.includes("basic")) return null;
  const dcSegment = segments.find((s) => s.startsWith("dc:"));
  const dc = dcSegment ? Number(dcSegment.slice(3)) : NaN;
  if (!Number.isFinite(dc)) return null;

  const damageMatch = /@Damage\[([^\]]+)\]/i.exec(descriptionHtml);
  if (!damageMatch) return null;
  const damage = [];
  for (const part of damageMatch[1].split(",")) {
    const termMatch = /^\s*(\d+d\d+)\[([a-z-]+)\]\s*$/i.exec(part);
    if (!termMatch) return null; // an unrecognized damage shape -- stay conservative
    damage.push({ formula: termMatch[1], type: termMatch[2].toLowerCase() });
  }

  const areaMatch = /creatures?\s+within\s+(\d+)\s+feet/i.exec(descriptionHtml);
  const areaFeet = areaMatch ? Number(areaMatch[1]) : null;

  return { save, dc, damage, areaFeet };
}

/** PF2e RAW basic-save degree-of-success damage scaling. */
export function basicSaveDamageMultiplier(outcome) {
  return { criticalSuccess: 0, success: 0.5, failure: 1, criticalFailure: 2 }[outcome] ?? 0;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/trap-mechanics-basic-save.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/trap-mechanics.mjs tests/trap-mechanics-basic-save.test.mjs
git commit -m "feat(#839): parse a hazard's own basic-save-plus-damage description

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Wire basic-save triggering into `triggerTrap`, with a guard-rail fallback

**Files:**
- Modify: `scripts/trap-combat.mjs` (`triggerTrap`, both call sites)
- Modify: `lang/en.json` (new i18n keys)
- Test: `tests/trap-combat-basic-save-trigger.test.mjs`

**Interfaces:**
- Consumes: `parseBasicSaveAction`, `basicSaveDamageMultiplier` (Task 1); `withinSearchRange`, `footprint` (confirmed current).
- Produces: `triggerTrap(hazardActor, target, deps = {})` — new third parameter, optional, defaulting every lookup to real Foundry globals exactly like `handleTrapTokenMove`'s own existing `deps` pattern. Both existing call sites (`handleTrapTokenMove`, `attemptTrapDisableForScene`) are updated to pass the hazard's own token/scene through.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect, vi } from "vitest";
import { triggerTrap } from "../scripts/trap-combat.mjs";

function hazardActor({ flags = {}, actions = [], items = [] } = {}) {
  return {
    id: "hazard1",
    name: "Steam Vents",
    system: { actions },
    items,
    getFlag: (_m, k) => flags[k],
    setFlag: vi.fn(async (_m, k, v) => { flags[k] = v; }),
  };
}

function actionItem(name, description) {
  return { type: "action", name, system: { description: { value: description } } };
}

function partyActor(id, name, saveOutcome) {
  return {
    id, name, type: "character",
    saves: { reflex: { roll: vi.fn(async () => { lastOutcome = saveOutcome; }) } },
    applyDamage: vi.fn(async () => {}),
  };
}

let lastOutcome;
function install({ messages = [] } = {}) {
  globalThis.game = {
    user: { update: vi.fn(async () => {}), flags: {} },
    messages: { contents: [{ flags: { pf2e: { context: { get outcome() { return lastOutcome; } } } } }] },
    i18n: { format: (k, d) => `${k}|${JSON.stringify(d)}` },
  };
  globalThis.ChatMessage = { create: vi.fn(async () => {}), getWhisperRecipients: () => [] };
}

const STEAM_VENTS_DESC = `Steam erupts from the pipes, dealing @Damage[3d6[bludgeoning],3d6[fire]] (@Check[reflex|dc:24|basic]) to all creatures within 15 feet.`;
const ELECTRIC_LATCH_DESC = `The trap deals @Damage[3d12[electricity]] damage to the triggering creature (@Check[reflex|dc:22|basic] save).`;
const INITIATIVE_DESC = `The wheel begins to spin and rolls initiative.`;

describe("#839 triggerTrap basic-save branch", () => {
  it("resolves a single-target basic-save hazard against only the triggering creature", async () => {
    install();
    const a = hazardActor({ items: [actionItem("Electrocution", ELECTRIC_LATCH_DESC)] });
    const trigger = partyActor("p1", "Alice", "failure");
    const token = { document: { parent: { tokens: [] } } };
    await triggerTrap(a, { actor: trigger, token });
    expect(trigger.saves.reflex.roll).toHaveBeenCalled();
    expect(trigger.applyDamage).toHaveBeenCalled();
  });

  it("resolves an area basic-save hazard against every party member within range, including the triggerer", async () => {
    install();
    const a = hazardActor({ items: [actionItem("Steam Blast", STEAM_VENTS_DESC)] });
    const trigger = partyActor("p1", "Alice", "failure");
    const nearby = partyActor("p2", "Bob", "success");
    const far = partyActor("p3", "Cora", "criticalSuccess");
    const hazardToken = { x: 0, y: 0, width: 100, height: 100 };
    const triggerToken = { x: 0, y: 0, width: 100, height: 100 };
    const nearbyToken = { x: 100, y: 0, width: 100, height: 100 };
    const farToken = { x: 10000, y: 0, width: 100, height: 100 };
    const scene = {
      grid: { size: 100, distance: 5 },
      tokens: [
        { actor: trigger, ...triggerToken },
        { actor: nearby, ...nearbyToken },
        { actor: far, ...farToken },
      ],
    };
    const token = { document: { parent: scene } };
    await triggerTrap(a, { actor: trigger, token }, { hazardToken: { ...hazardToken, parent: scene }, scene });
    expect(trigger.saves.reflex.roll).toHaveBeenCalled();
    expect(nearby.applyDamage).toHaveBeenCalled();
    expect(far.saves.reflex.roll).not.toHaveBeenCalled();
  });

  it("whispers a GM guard rail instead of silently no-op'ing for an unparseable hazard", async () => {
    install();
    const a = hazardActor({ items: [actionItem("Wheel Spin", INITIATIVE_DESC)] });
    const trigger = partyActor("p1", "Alice", "failure");
    const token = { document: { parent: { tokens: [] } } };
    const result = await triggerTrap(a, { actor: trigger, token });
    expect(result).toBeNull();
    expect(globalThis.ChatMessage.create).toHaveBeenCalled();
    const call = globalThis.ChatMessage.create.mock.calls[0][0];
    expect(call.content).toContain("PF2EDC.Dungeon.Trap.UnautomatedChat");
  });
});
```

Adjust the test fixtures' exact shapes once written against the real `footprint`/`withinSearchRange` signatures (confirmed current, `scripts/placement.mjs:26`, `scripts/trap-mechanics.mjs:139`) if a mock's token shape doesn't line up — the intent (single-target vs. area vs. guard-rail) is what matters, not the exact mock plumbing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/trap-combat-basic-save-trigger.test.mjs`
Expected: FAIL — `triggerTrap` has no basic-save branch yet.

- [ ] **Step 3: Add the i18n keys**

In `lang/en.json`, alongside the existing `PF2EDC.Dungeon.Trap.*` keys:

```json
  "PF2EDC.Dungeon.Trap.UnautomatedChat": "{trap} triggered but needs manual GM resolution: {description} Within range: {names}.",
```

- [ ] **Step 4: Implement the basic-save branch and guard rail**

Change (confirmed current, `scripts/trap-combat.mjs:165-193`):

```js
export async function triggerTrap(hazardActor, target) {
  if (hazardActor.getFlag(MODULE_ID, "trapDisabled")) return null;
  const strike = (hazardActor.system?.actions ?? []).find(
    (a) => a.type === "strike" && a.ready !== false,
  );
  if (!strike) return null;

  return withDialogsSuppressed(async () => {
    const targetRef = { document: target.token };
    await strike.variants[0].roll({ target: targetRef, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    if (outcome === "success" || outcome === "criticalSuccess") {
      const damageRoll = await strike.damage({
        target: targetRef,
        outcome,
        createMessage: true,
      });
      if (damageRoll) {
        await target.actor.applyDamage({
          damage: damageRoll,
          token: target.token,
          outcome,
        });
      }
    }
    return outcome;
  });
}
```

to:

```js
export async function triggerTrap(hazardActor, target, deps = {}) {
  if (hazardActor.getFlag(MODULE_ID, "trapDisabled")) return null;
  const strike = (hazardActor.system?.actions ?? []).find(
    (a) => a.type === "strike" && a.ready !== false,
  );
  if (strike) {
    return withDialogsSuppressed(async () => {
      const targetRef = { document: target.token };
      await strike.variants[0].roll({ target: targetRef, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      if (outcome === "success" || outcome === "criticalSuccess") {
        const damageRoll = await strike.damage({
          target: targetRef,
          outcome,
          createMessage: true,
        });
        if (damageRoll) {
          await target.actor.applyDamage({
            damage: damageRoll,
            token: target.token,
            outcome,
          });
        }
      }
      return outcome;
    });
  }

  // #839: no strike -- look for a hazard action item whose own description
  // is a basic save + structured damage (parseBasicSaveAction). Resolved
  // against the triggering creature alone, or every party member within
  // the parsed area, per whichever the hazard's own text describes.
  const actionItem = Array.from(hazardActor.items ?? []).find(
    (i) => i.type === "action" && parseBasicSaveAction(i.system?.description?.value),
  );
  const parsed = actionItem && parseBasicSaveAction(actionItem.system.description.value);
  if (parsed) {
    return withDialogsSuppressed(async () => {
      const affected = resolveBasicSaveTargets(parsed, target, deps);
      const outcomes = [];
      for (const { actor, token } of affected) {
        await actor.saves?.[parsed.save]?.roll?.({ dc: { value: parsed.dc }, createMessage: true });
        const outcome = game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
        const multiplier = basicSaveDamageMultiplier(outcome);
        if (multiplier > 0) {
          let total = 0;
          for (const term of parsed.damage) {
            const roll = await new Roll(term.formula).evaluate();
            total += roll.total;
          }
          await actor.applyDamage({
            damage: Math.floor(total * multiplier),
            token,
            outcome,
          });
        }
        outcomes.push(outcome);
      }
      return outcomes[0] ?? null;
    });
  }

  // Nothing automatable -- guard rail, never silence (#839).
  const description = (actionItem?.system?.description?.value ?? hazardActor.name)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const names = resolveBasicSaveTargets({ areaFeet: 15 }, target, deps)
    .map(({ actor }) => actor.name)
    .join(", ") || target.actor.name;
  await whisperGMChat("PF2EDC.Dungeon.Trap.UnautomatedChat", {
    trap: hazardActor.name,
    description,
    names,
  });
  return null;
}

/**
 * #839: `{actor, token}` pairs a parsed basic-save action affects --
 * the triggering creature alone when `parsed.areaFeet` is null, or every
 * PARTY member (matching handleTrapTokenMove's own party-only trigger
 * gate) within that radius of the hazard, via the same grid-distance
 * primitive the detection-range check already uses. `deps.hazardToken`/
 * `deps.scene` let a caller that already has them in scope (both real
 * call sites do) pass them directly; falls back to deriving the scene
 * from `target.token.document.parent` when omitted.
 */
function resolveBasicSaveTargets(parsed, target, deps = {}) {
  if (!parsed.areaFeet) return [{ actor: target.actor, token: target.token }];
  const scene = deps.scene ?? target.token?.document?.parent;
  const hazardToken = deps.hazardToken;
  if (!scene || !hazardToken) return [{ actor: target.actor, token: target.token }];
  const rangeSquares = parsed.areaFeet / (scene.grid?.distance || 5);
  const hazardFootprint = footprint(hazardToken, scene.grid.size);
  return scene.tokens
    .filter((t) => isPartyActor(t.actor))
    .filter((t) => withinSearchRange(hazardFootprint, footprint(t, scene.grid.size), rangeSquares))
    .map((t) => ({ actor: t.actor, token: t }));
}
```

Add `parseBasicSaveAction`/`basicSaveDamageMultiplier` to this file's existing import from `./trap-mechanics.mjs` (confirmed current, `scripts/trap-combat.mjs:9-17`).

- [ ] **Step 5: Thread the hazard's own token through both call sites**

In `handleTrapTokenMove` (confirmed current, `scripts/trap-combat.mjs:331-334`), change:

```js
          await trigger(hazardActor, {
            actor: tokenDoc.actor,
            token: tokenDoc.object,
          });
```

to:

```js
          await trigger(hazardActor, {
            actor: tokenDoc.actor,
            token: tokenDoc.object,
          }, { hazardToken: hazardToken.object, scene });
```

In `attemptTrapDisableForScene` (confirmed current, `scripts/trap-combat.mjs:430-432`), change:

```js
      if (attempterToken?.object) {
        await trigger(hazardActor, { actor, token: attempterToken.object });
      }
```

to:

```js
      if (attempterToken?.object) {
        await trigger(hazardActor, { actor, token: attempterToken.object }, { hazardToken: hazardToken.object, scene: trapScene });
      }
```

(matching this function's own already-in-scope `hazardToken`/`trapScene` variables, confirmed current).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/trap-combat-basic-save-trigger.test.mjs`
Expected: PASS. Adjust `resolveBasicSaveTargets`'s own `footprint`-input shape to match whatever `footprint` (confirmed current, `scripts/placement.mjs:26`) actually expects from a token object if a test reveals a mismatch — read that function's real signature before finalizing this step.

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — in particular every existing `trap-combat.mjs` test (the strike path is untouched) and every `trap-mechanics.mjs` test stay green.

- [ ] **Step 8: Commit**

```bash
git add scripts/trap-combat.mjs lang/en.json tests/trap-combat-basic-save-trigger.test.mjs
git commit -m "feat(#839): automate basic-save traps (single-target and area), guard-rail the rest

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Live verification

- [ ] **Step 1: Verify against a real spawned hazard of each shape**

Using `foundry-rest`, spawn (or find, if already present in a test world) an instance of Electric Latch Rune (single-target) and Steam Vents (area) via this module's own trap-population path, move a party token onto each, and confirm: the single-target one damages only the mover; the area one damages every party token actually within 15 feet (and none further), each via a real PF2e save roll card in chat (not a silent no-op). Then trigger a genuinely non-automatable hazard (e.g. Wheel of Misery, if available in range) and confirm the GM guard-rail whisper appears with the right names, not silence.

- [ ] **Step 2: Report findings on the issue**

Record what was actually observed (chat cards, applied damage, guard-rail whisper content) as a comment on #839 before closing it.

---

### Task 4: Version bump

**Files:**
- Modify: `module.json`

- [ ] **Step 1: Re-check the current version and bump**

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **minor** bump (a real new mechanic — basic-save trap automation — not a trivial fix), using whatever the fetch above shows as current.

- [ ] **Step 2: Commit**

```bash
git add module.json
git commit -m "chore(#839): bump version for basic-save trap targeting

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #839's own "Expected" list is addressed with real, measured grounding rather than guesses: single-target-only strikes were already correct (confirmed, not re-touched); area-effect scoping and save-based evasion are now automated for the narrow, real shape the compendium actually contains (3 of 24 hazards); hazard reactions/initiative stay explicitly GM-narrated (the user's own second-round decision, after the true cost of full area/prose automation surfaced); everything still unautomated gets a correctly-scoped guard rail instead of silence, directly closing the real "GM resolves manually and over-applies" gap this session's own investigation found.

**2. Placeholder scan:** No TBD. Every parser rule and every "stays GM-narrated" exclusion is backed by a real hazard description surveyed this session, not an invented example.

**3. Type consistency:** `triggerTrap(hazardActor, target, deps)`'s new third parameter is additive and optional — both existing call sites are updated in the same task that changes the signature, and the pre-existing strike branch's own code is moved, not rewritten, preserving its exact prior behavior byte-for-byte.

**4. Review Focus:** All five items (single-target basic save, area basic save including the triggerer, the exact 0/0.5/1/2 multiplier, never guessing on an unparseable hazard, a correctly-scoped guard-rail whisper) each map to a specific test in Task 1 or Task 2. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-06-trap-basic-save-targeting.md`.
