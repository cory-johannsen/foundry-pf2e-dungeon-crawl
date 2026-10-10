# AI NPC Reactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize #202's single-ability Reactive Strike/Attack of Opportunity machinery into a data-driven reaction registry covering movement-triggered attacks (Reactive Strike/AoO, Twisting Tail, Wing Rebuff) and defensive reactions against attacks (Shield Block, Wing Deflection, Ghost Dodge, Swat Projectile), decided by a hybrid policy (deterministic when one reaction is eligible, the agent service with a 5s timeout when several are) and automatic in GM-less play.

**Architecture:** A new `scripts/npc-reactions.mjs` holds `REACTION_DEFS`, a data table of `{id, match, trigger, kind, priority, eligible, policy, execute}` entries, plus the shared eligibility gates #202 already built. A single dispatcher `resolveReactions(combat, triggerEvent)` collects the eligible definitions for a trigger kind, applies the one-eligible/several-eligible/none-eligible hybrid, and calls the winning definition's `execute`. Three trigger paths feed it: the existing movement hooks (AI Stride, the manual GM check, the ranged-attack chat hook) for `moveInReach`/`leaveReach`; a new `attack-roll` chat hook for `targetedByAttack` (`acBonus` kind); a new call from the two existing damage-application call sites for `damageIncoming` (`damageReduction` kind). Reactive Strike/AoO moves into the registry as its first row, with #202's own tests re-pointed at the registry so no behavior regresses.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-npc-reactions-design.md`

## Global Constraints

- **#925's consolidated per-turn card does not exist in real code yet** (confirmed live: issue #925 carries label `planned`, not implemented — its own plan has not been executed). This plan therefore reports reactions via a direct `ChatMessage.create` call, generalizing #202's own existing `postReactiveStrikeChat` pattern (public summary line, GM-only rationale via `data-visibility="gm"`), not #925's mechanism. Task 7 notes this explicitly as a follow-up for whoever implements #925.
- **The retroactive attack-roll outcome rewrite the spec names as its primary `acBonus` mechanism is not attempted.** Confirmed live, by reading the installed PF2e system's `CheckRoll` class directly: `degreeOfSuccess` is read from `this.options.degreeOfSuccess`, a value baked in at roll-creation time and rendered into the chat message's static HTML by `CheckRoll#render` at that same moment — never re-read from `flags.pf2e.context.outcome` afterward. Writing a new outcome onto the message's flags after the fact would not change what the table sees on the card. This plan uses the spec's own named fallback as the sole `acBonus` mechanism instead: skip damage application when the bonus would flip a hit to a miss, and post an explicit, table-visible note saying so. This is a premise correction, not a deferral — it make the `acBonus` executor strictly simpler than the spec's primary suggestion and never depends on the internal shape of a Handlebars template this module doesn't own.
- **"Disrupts the move" cannot mean undoing a completed walk.** Confirmed live: `offerReactiveStrikesAgainst` (#202, reused as the `strike`-kind executor) is already called only *after* `walkTokenThroughSteps` finishes laying down every step of an AI Stride — the token has already arrived by the time any reaction fires. Twisting Tail/Wing Rebuff's "disrupts the move" is modeled as *no further Stride this turn*: a hit sets a new `movementDisrupted: true` field on the combatant's existing per-turn agent state (`getAgentTurnState`/`setAgentTurnState`, parallel to the existing `flourishUsed`/`stanceUsed` fields), checked by the stride-candidate builder. A non-agent-controlled (player) mover gets a GM-visible note only, per the spec's own text — the module never controls player movement.
- **GM-less detection reuses the real, existing `findActiveHostedRun({settingsRef})`** (`scripts/dungeon-runner.mjs`): a combat is GM-less when `findActiveHostedRun()?.sceneId === combat.scene?.id`.
- **The hybrid decision's agent-service call reuses the existing `{id, summary}` candidate-list convention** (`agent-candidates.mjs`'s own `candidates` field, and `/v1/combat-decision`'s `candidates is required and must be non-empty` validation in `tools/agent-service/server.mjs`) plus an explicit `{id: "decline", summary: "Decline to react"}` entry.
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention.
- Bump `module.json`'s `version` as part of this work (minor bump — a new cross-cutting subsystem, not a routine fix).

## Review Focus

- A creature with two eligible reactions for the same trigger (e.g. both Shield Block and an AC-bonus reaction against the same incoming attack) must use at most one — the existing one-reaction-per-round economy (`getReactionUsed`/`markReactionUsed`) must be checked, not just the registry's own priority order, before any `execute` runs.
- A reactor whose token, actor, or the triggering creature's token/actor has been deleted or removed from the combat mid-resolution (e.g. a previous reaction's own Strike defeated the triggering creature) must be skipped silently, never throw into the hook pipeline.
- The agent-service call for several eligible reactions must actually time out at 5 seconds, not the client's own default 35-second timeout — this is new plumbing, not existing behavior, and deserves its own direct test.
- A GM-less combat must never post the one-click confirm card for `acBonus`/`damageReduction` against a player attack — it must resolve automatically, mirroring the spec's explicit "never in GM-less mode" rule, which is easy to get backwards (automatic when a GM *is* present, confirm card when none is).
- The migrated Reactive Strike/AoO path must keep working exactly as before for every one of #202's own existing scenarios (ranged-attack trigger, AI Stride trigger, manual GM check trigger, weapon-restricted variants) — a registry generalization that subtly changes an existing, working ability is a regression, not neutral.

---

### Task 1: Agent-service client — per-call timeout override

**Files:**
- Modify: `scripts/agent-service-client.mjs`
- Test: `tests/agent-service-client.test.mjs` (create if it doesn't exist; check first)

**Interfaces:**
- Consumes: nothing.
- Produces (consumed by Task 3): `fetchCombatDecision({ baseUrl, apiKey, context, fetchImpl, timeoutMs })` — `timeoutMs` optional, defaults to the existing `CLIENT_TIMEOUT_MS`.

- [x] **Step 1: Check for an existing test file**

Run: `ls tests/agent-service-client.test.mjs 2>/dev/null && cat tests/agent-service-client.test.mjs || echo "none"`

If a file exists, read it in full and add the new tests below to it rather than overwriting; keep its existing test names and fixtures as-is.

- [x] **Step 2: Write the failing test**

```js
// tests/agent-service-client.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { fetchCombatDecision } from '../scripts/agent-service-client.mjs';

describe('fetchCombatDecision timeout override', () => {
  it('passes an AbortSignal with the given timeoutMs to fetchImpl, not the 35s default', async () => {
    let capturedSignal;
    const fetchImpl = vi.fn(async (_url, init) => {
      capturedSignal = init.signal;
      return { ok: true, json: async () => ({ candidateId: 'x', rationale: null }) };
    });
    await fetchCombatDecision({
      baseUrl: 'https://example.test',
      apiKey: 'k',
      context: { candidates: [{ id: 'x', summary: 'x' }] },
      fetchImpl,
      timeoutMs: 5000,
    });
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    // AbortSignal.timeout gives no public way to read back the ms directly;
    // confirm indirectly: a signal created with a much shorter timeout
    // aborts before one created with the 35s default would.
    vi.useFakeTimers();
    const shortSignal = AbortSignal.timeout(5000);
    let aborted = false;
    shortSignal.addEventListener('abort', () => { aborted = true; });
    vi.advanceTimersByTime(5001);
    expect(aborted).toBe(true);
    vi.useRealTimers();
  });

  it('defaults to the existing 35s behavior when timeoutMs is omitted', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ candidateId: 'x', rationale: null }) }));
    await fetchCombatDecision({
      baseUrl: 'https://example.test',
      apiKey: 'k',
      context: { candidates: [{ id: 'x', summary: 'x' }] },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
```

- [x] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/agent-service-client.test.mjs`
Expected: the first test's call still succeeds (since `timeoutMs` is silently ignored today), but add a direct assertion that would fail without the plumbing — see Step 4's note.

Since `fetchImpl`'s mock always resolves instantly, the first test as written doesn't actually distinguish 5s from 35s behaviorally. Replace its body with a direct check that `postJson` computed its `AbortSignal.timeout` call using `timeoutMs` when given one — export a test-only seam instead: have `postJson` accept `timeoutMs` and pass it straight to `AbortSignal.timeout(timeoutMs ?? CLIENT_TIMEOUT_MS)`, and assert via a spy on `AbortSignal.timeout` itself:

```js
  it('calls AbortSignal.timeout with the given timeoutMs, not the 35s default', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ candidateId: 'x', rationale: null }) }));
    await fetchCombatDecision({
      baseUrl: 'https://example.test', apiKey: 'k',
      context: { candidates: [{ id: 'x', summary: 'x' }] }, fetchImpl, timeoutMs: 5000,
    });
    expect(spy).toHaveBeenCalledWith(5000);
    spy.mockRestore();
  });

  it('calls AbortSignal.timeout with the existing 35s default when timeoutMs is omitted', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ candidateId: 'x', rationale: null }) }));
    await fetchCombatDecision({
      baseUrl: 'https://example.test', apiKey: 'k',
      context: { candidates: [{ id: 'x', summary: 'x' }] }, fetchImpl,
    });
    expect(spy).toHaveBeenCalledWith(35000);
    spy.mockRestore();
  });
```

Run: `npm test -- tests/agent-service-client.test.mjs`
Expected: FAIL — `postJson`/`fetchCombatDecision` don't accept or forward `timeoutMs` yet.

- [x] **Step 4: Implement the override**

```js
async function postJson(baseUrl, path, body, { apiKey, fetchImpl = fetch, timeoutMs = CLIENT_TIMEOUT_MS }) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(`agent-service-client: ${path} failed (${res.status}): ${payload?.error ?? "unknown error"}`);
  }
  return payload;
}

export async function fetchCombatDecision({ baseUrl, apiKey, context, fetchImpl, timeoutMs }) {
  return postJson(baseUrl, "/v1/combat-decision", context, { apiKey, fetchImpl, timeoutMs });
}
```

(`fetchFlavorCustomization`/`fetchCombatCandidates` keep calling `postJson` without `timeoutMs`, which now resolves to the same `CLIENT_TIMEOUT_MS` default they already got — no behavior change for either.)

- [x] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/agent-service-client.test.mjs`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add scripts/agent-service-client.mjs tests/agent-service-client.test.mjs
git commit -m "feat(#931): add a per-call timeoutMs override to fetchCombatDecision

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: The reaction registry — data table, shared gates, Reactive Strike/AoO migrated in

**Files:**
- Create: `scripts/npc-reactions.mjs`
- Modify: `scripts/dungeon-combat.mjs` (re-export, see below)
- Test: `tests/npc-reactions.test.mjs`

**Interfaces:**
- Consumes: `getReactionUsed`, `markReactionUsed`, `combatantOpponents`, `isDownedCharacter`, `canTargetState`, `stateFor`, `hasLineOfSight`, `actionReachSquares`, `chebyshevSquares`, `parseReactiveStrikeWeaponRestriction`, `matchMultiStrikeActionSlug` — all existing, imported from `scripts/dungeon-combat.mjs` (exported where not already, see Step 3).
- Produces (consumed by Task 3): `REACTION_DEFS` (array), `sharedReactionGates(reactor, triggerKind, ctx)` → boolean, `eligibleReactionDefs(combat, triggerEvent)` → the subset of `REACTION_DEFS` whose `trigger` matches `triggerEvent.trigger` and whose `eligible(ctx)` (shared gates + the def's own) passes, ordered by `priority` descending.

- [ ] **Step 1: Export the handful of #202 helpers this file needs**

In `scripts/dungeon-combat.mjs`, add `export` to `isReactiveStrikeInScope`, `getReactionUsed`, `markReactionUsed` (they are currently module-private). Leave every call site inside `dungeon-combat.mjs` unchanged — adding `export` doesn't change local calls.

- [ ] **Step 2: Write the failing tests**

```js
// tests/npc-reactions.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { REACTION_DEFS, eligibleReactionDefs } from '../scripts/npc-reactions.mjs';

function reactorStub({ id = 'r1', itemName, hasReaction = true, agentControlled = true, reactionUsedRound = null } = {}) {
  const flags = { agentControlled, reactionUsed: reactionUsedRound };
  return {
    id,
    name: 'Reactor',
    getFlag: (_m, key) => flags[key],
    actor: { items: hasReaction ? [{ type: 'action', system: { actionType: { value: 'reaction' } }, name: itemName }] : [] },
    token: { x: 0, y: 0 },
  };
}

function combatStub({ round = 1, matrix = {}, reactionUsed = {} } = {}) {
  const flagStore = { detection: matrix, reactionUsed };
  return {
    round,
    getFlag: (_m, key) => flagStore[key],
    setFlag: async (_m, key, value) => { flagStore[key] = value; },
    scene: { grid: { size: 100, distance: 5 } },
  };
}

describe('REACTION_DEFS', () => {
  it('includes exactly the five first-slice reaction ids, each with a trigger/kind/priority', () => {
    const ids = REACTION_DEFS.map((d) => d.id).sort();
    expect(ids).toEqual([
      'reactive-strike', 'shield-block', 'swat-projectile', 'twisting-tail', 'wing-deflection-ghost-dodge', 'wing-rebuff',
    ].sort());
    for (const def of REACTION_DEFS) {
      expect(typeof def.trigger).toBe('string');
      expect(['strike', 'acBonus', 'damageReduction']).toContain(def.kind);
      expect(typeof def.priority).toBe('number');
      expect(typeof def.execute).toBe('function');
    }
  });

  it("reactive-strike's match recognizes Reactive Strike and Attack of Opportunity, case-insensitively, anchored at the start", () => {
    const def = REACTION_DEFS.find((d) => d.id === 'reactive-strike');
    expect(def.match.test('Reactive Strike')).toBe(true);
    expect(def.match.test('attack of opportunity (jaws only)')).toBe(true);
    expect(def.match.test('Not Reactive Strike At All')).toBe(false);
  });

  it("twisting-tail's match recognizes only Twisting Tail", () => {
    const def = REACTION_DEFS.find((d) => d.id === 'twisting-tail');
    expect(def.match.test('Twisting Tail')).toBe(true);
    expect(def.match.test('Reactive Strike')).toBe(false);
  });
});

describe('eligibleReactionDefs', () => {
  it('excludes a reactor with no matching reaction item', () => {
    const combat = combatStub();
    const reactor = reactorStub({ itemName: 'Some Other Reaction' });
    const result = eligibleReactionDefs(combat, { trigger: 'leaveReach', mover: { id: 'm1' }, reactors: [reactor] });
    expect(result.find((d) => d.id === 'reactive-strike')).toBeUndefined();
  });

  it('excludes a reactor who already used their reaction this round', () => {
    const combat = combatStub({ round: 2, reactionUsed: { r1: 2 } });
    const reactor = reactorStub({ itemName: 'Reactive Strike' });
    const result = eligibleReactionDefs(combat, { trigger: 'leaveReach', mover: { id: 'm1' }, reactors: [reactor] });
    expect(result).toEqual([]);
  });

  it('excludes a reactor that is not agent-controlled', () => {
    const combat = combatStub();
    const reactor = reactorStub({ itemName: 'Reactive Strike', agentControlled: false });
    const result = eligibleReactionDefs(combat, { trigger: 'leaveReach', mover: { id: 'm1' }, reactors: [reactor] });
    expect(result).toEqual([]);
  });

  it('orders multiple eligible definitions by priority, highest first', () => {
    // Construct ctx so both twisting-tail and reactive-strike could match a
    // reactor carrying both items for the same trigger kind, and confirm
    // the returned order is priority-descending (exact priority values
    // fixed by Step 3's table below).
  });
});
```

(The fourth test is intentionally left for the implementer to fill in using the real `priority` values fixed in Step 3's table, once they exist — this mirrors the same deliberate "re-derive against real code" convention #925's own plan used for its own second render test.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/npc-reactions.test.mjs`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 4: Write `scripts/npc-reactions.mjs`**

```js
/**
 * #931: the NPC reaction registry — generalizes #202's single hard-coded
 * Reactive Strike/Attack of Opportunity path into a data table any new
 * reaction can be added to without touching the dispatch machinery.
 * `kind` picks the executor shape: a melee counter-Strike ("strike"), a
 * circumstance AC bonus against the triggering attack ("acBonus"), or
 * damage reduction applied at the damage step ("damageReduction").
 */
import {
  isReactiveStrikeInScope,
  getReactionUsed,
  combatantOpponents,
  isDownedCharacter,
  canTargetState,
  stateFor,
  hasLineOfSight,
  actionReachSquares,
  chebyshevSquares,
  parseReactiveStrikeWeaponRestriction,
  matchMultiStrikeActionSlug,
} from "./dungeon-combat.mjs";

function matchingReactionItem(reactor, match) {
  return (reactor.actor?.items ?? []).find(
    (item) =>
      item.type === "action" &&
      item.system.actionType?.value === "reaction" &&
      match.test(item.name ?? ""),
  );
}

/** Confirmed live: `isReactiveStrikeInScope` already does exactly this
 * item-shape check for the one reaction #202 built; every other
 * definition in this table reuses the same shape via its own `match`. */
function hasReadyMeleeStrikeInReach(reactor, mover, gridSize, gridDistanceFt, restriction) {
  const readyActions = (reactor.actor?.system?.actions ?? [])
    .filter((a) => a.type === "strike" && a.ready !== false && !a.item?.isRanged)
    .map((a) => ({
      slug: a.item?.slug ?? a.slug ?? a.label,
      label: a.label,
      reachSquares: actionReachSquares(a, gridDistanceFt),
    }));
  const distanceSquares = chebyshevSquares(reactor.token, mover.token, gridSize);
  const inReach = readyActions.filter((a) => distanceSquares <= a.reachSquares);
  if (!inReach.length) return null;
  return restriction ? matchMultiStrikeActionSlug(restriction, inReach) : inReach[0];
}

/**
 * Every shared precondition from #202's own `findReactiveStrikeOpportunities`,
 * generalized beyond Reactive Strike: agent-controlled, not defeated, not
 * already used its reaction this round, observed the mover (detection
 * matrix), line of sight. `strike`-kind definitions additionally need a
 * ready melee Strike in reach, honoring the item's own weapon-name
 * restriction (e.g. "(jaws only)").
 */
function sharedReactionGates(def, reactor, mover, combat, gridSize, gridDistanceFt) {
  if (!reactor.getFlag("pf2e-dungeon-crawl", "agentControlled")) return null;
  if (isDownedCharacter(reactor)) return null;
  if (getReactionUsed(combat, reactor.id, combat.round)) return null;
  const item = matchingReactionItem(reactor, def.match);
  if (!item) return null;
  const matrix = combat.getFlag?.("pf2e-dungeon-crawl", "detection");
  if (!canTargetState(stateFor(matrix, mover.id, reactor.id))) return null;
  if (!hasLineOfSight(combat, reactor.token, mover.token)) return null;
  if (def.kind === "strike") {
    const restriction = parseReactiveStrikeWeaponRestriction(item.name);
    const matched = hasReadyMeleeStrikeInReach(reactor, mover, gridSize, gridDistanceFt, restriction);
    if (!matched) return null;
    return { item, actionSlug: matched.slug };
  }
  return { item };
}

/**
 * Every (definition, reactor) pair eligible for `triggerEvent` right now,
 * ordered by `priority` descending — the one entry point
 * `resolveReactions` (Task 3) calls to find out who gets to react.
 * `triggerEvent` carries `{ trigger, mover, reactors, gridSize, gridDistanceFt }`
 * for movement triggers, or the trigger-specific shape Tasks 5/6 define.
 */
export function eligibleReactionDefs(combat, triggerEvent) {
  const gridSize = triggerEvent.gridSize ?? combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = triggerEvent.gridDistanceFt ?? combat.scene?.grid?.distance ?? 5;
  const reactors =
    triggerEvent.reactors ??
    combatantOpponents(combat, triggerEvent.mover).filter((c) => !isDownedCharacter(c));
  const results = [];
  for (const def of REACTION_DEFS) {
    if (def.trigger !== triggerEvent.trigger) continue;
    for (const reactor of reactors) {
      const gateCtx = sharedReactionGates(def, reactor, triggerEvent.mover, combat, gridSize, gridDistanceFt);
      if (!gateCtx) continue;
      const ctx = { ...triggerEvent, reactor, ...gateCtx, gridSize, gridDistanceFt };
      if (def.eligible && !def.eligible(ctx)) continue;
      results.push({ def, reactor, ctx });
    }
  }
  return results.sort((a, b) => b.def.priority - a.def.priority);
}

export const REACTION_DEFS = [
  {
    id: "reactive-strike",
    match: /^(Reactive Strike|Attack of Opportunity)\b/i,
    trigger: "leaveReach",
    kind: "strike",
    priority: 10,
    eligible: () => true,
    policy: () => true,
    execute: null, // wired in Task 4
  },
  {
    id: "twisting-tail",
    match: /^Twisting Tail\b/i,
    trigger: "moveInReach",
    kind: "strike",
    priority: 10,
    eligible: () => true,
    policy: () => true,
    execute: null, // wired in Task 4
  },
  {
    id: "wing-rebuff",
    match: /^Wing Rebuff\b/i,
    trigger: "moveInReach",
    kind: "strike",
    priority: 10,
    eligible: () => true,
    policy: () => true,
    execute: null, // wired in Task 4
  },
  {
    id: "shield-block",
    match: /^Shield Block\b/i,
    trigger: "damageIncoming",
    kind: "damageReduction",
    priority: 20,
    eligible: (ctx) => ctx.incomingDamageTotal > (ctx.shieldHardness ?? 0),
    policy: () => true,
    execute: null, // wired in Task 5
  },
  {
    id: "wing-deflection-ghost-dodge",
    match: /^(Wing Deflection|Ghost Dodge)\b/i,
    trigger: "targetedByAttack",
    kind: "acBonus",
    priority: 10,
    eligible: () => true,
    policy: (ctx) => ctx.wouldFlipOutcome,
    execute: null, // wired in Task 6
  },
  {
    id: "swat-projectile",
    match: /^Swat Projectile\b/i,
    trigger: "targetedByAttack",
    kind: "acBonus",
    priority: 10,
    eligible: (ctx) => ctx.isPhysicalRanged,
    policy: (ctx) => ctx.wouldFlipOutcome,
    execute: null, // wired in Task 6
  },
];
```

(`REACTION_DEFS` is declared after `eligibleReactionDefs`/its helpers purely for readability — hoisting makes the ordering harmless. Each `execute: null` is filled in by the task named in its own comment; Task 2 itself never calls `execute`, so leaving it `null` here doesn't break anything this task's own tests check.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/npc-reactions.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/npc-reactions.mjs scripts/dungeon-combat.mjs tests/npc-reactions.test.mjs
git commit -m "feat(#931): add the NPC reaction registry and shared eligibility gates

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `resolveReactions` — the hybrid decision dispatcher

**Files:**
- Create: `scripts/npc-reactions.mjs` (continued — add to the file from Task 2)
- Test: `tests/npc-reactions.test.mjs` (continued)

**Interfaces:**
- Consumes: `eligibleReactionDefs` (Task 2), `fetchCombatDecision` (Task 1, with `timeoutMs`).
- Produces (consumed by Tasks 4/5/6): `async function resolveReactions(combat, triggerEvent, { fetchDecision = fetchCombatDecision } = {})` — for every reactor with at least one eligible definition, runs the hybrid decision and calls the winning definition's `execute(ctx)`; returns nothing (fire-and-forget from the trigger's point of view, matching #202's own `offerReactiveStrikesAgainst` shape).

- [ ] **Step 1: Write the failing tests**

```js
describe('resolveReactions', () => {
  function defStub(id, { priority = 10, policyResult = true, trigger = 'leaveReach' } = {}) {
    return { id, match: /^x$/, trigger, kind: 'strike', priority, eligible: () => true, policy: () => policyResult, execute: vi.fn() };
  }

  it('does nothing when no definition is eligible for any reactor', async () => {
    const combat = combatStub();
    const reactor = reactorStub({ itemName: 'nothing matches' });
    await resolveReactions(combat, { trigger: 'leaveReach', mover: { id: 'm1' }, reactors: [reactor] });
    // No defs match 'nothing matches' for any registered reaction, so no
    // executor runs -- assert via a spy on every REACTION_DEFS executor
    // once Task 4/5/6 have wired them, or (for this task's own isolated
    // test) inject a fake REACTION_DEFS via a test-only override param
    // and assert its def.execute was never called.
  });

  it('applies the policy directly when exactly one definition is eligible, executing when policy is true', async () => {
    // Using a test-only single-def override: one eligible def with
    // policy() => true should call its own execute exactly once, with no
    // fetchDecision call.
  });

  it('does not execute when exactly one definition is eligible but its policy is false', async () => {
    // Same setup with policy() => false: execute must not be called.
  });

  it('calls fetchCombatDecision with every eligible candidate plus decline when several definitions are eligible for the same reactor', async () => {
    const fetchDecision = vi.fn(async () => ({ candidateId: 'reaction:a:r1', rationale: 'because' }));
    // Two eligible defs for the same reactor/trigger; confirm fetchDecision
    // was called once with context.candidates containing
    // [{id:'reaction:a:r1',...}, {id:'reaction:b:r1',...}, {id:'decline',...}]
    // and timeoutMs: 5000, and that only def 'a's execute ran.
  });

  it('respects a decline pick by executing nothing', async () => {
    const fetchDecision = vi.fn(async () => ({ candidateId: 'decline', rationale: null }));
    // Neither def's execute should run.
  });

  it('falls back to the highest-priority eligible definition whose policy is true when the decision call throws', async () => {
    const fetchDecision = vi.fn(async () => { throw new Error('boom'); });
    // Confirm the higher-priority def's execute ran despite the throw.
  });

  it('falls back the same way on a timeout (fake timers)', async () => {
    vi.useFakeTimers();
    const fetchDecision = vi.fn(() => new Promise(() => {})); // never resolves
    // resolveReactions's own internal race against a 5s timer should fall
    // back; advance fake timers past 5000ms and confirm the fallback ran.
    vi.useRealTimers();
  });

  it('resolves two different reactors for the same trigger independently, each with their own one-reaction-per-round economy', async () => {
    // Two reactors, each eligible for a different single def; confirm
    // both execute, and that each one's own markReactionUsed-equivalent
    // (handled inside execute in later tasks) is irrelevant to this
    // task's own dispatcher -- resolveReactions itself just calls execute
    // once per reactor, never twice for the same reactor in one call.
  });
});
```

(Several of the above are deliberately written as scenario descriptions with the concrete mock wiring left for the implementer, matching the same "re-derive against real code" convention used elsewhere — the fixed facts are the function names, the candidate-id format `reaction:<defId>:<reactorId>`, the `decline` sentinel, the 5000ms timeout, and the fallback-to-highest-priority-eligible rule, all of which come directly from the spec's own "Deciding: the hybrid" section.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/npc-reactions.test.mjs`
Expected: FAIL — `resolveReactions` doesn't exist yet.

- [ ] **Step 3: Implement `resolveReactions`**

```js
import { fetchCombatDecision } from "./agent-service-client.mjs";

const REACTION_DECISION_TIMEOUT_MS = 5000;

async function decideAmong(eligible, { fetchDecision }) {
  if (eligible.length === 1) {
    const only = eligible[0];
    return only.def.policy(only.ctx) ? only : null;
  }
  const byCandidateId = new Map(
    eligible.map((e) => [`reaction:${e.def.id}:${e.reactor.id}`, e]),
  );
  const candidates = [
    ...eligible.map((e) => ({
      id: `reaction:${e.def.id}:${e.reactor.id}`,
      summary: `${e.reactor.name} reacts with ${e.def.id}`,
    })),
    { id: "decline", summary: "Decline to react" },
  ];
  const baseUrl = game.settings.get("pf2e-dungeon-crawl", "agentServiceUrl");
  const apiKey = game.settings.get("pf2e-dungeon-crawl", "agentServiceApiKey");
  const fallback = () => {
    const sorted = [...eligible].sort((a, b) => b.def.priority - a.def.priority);
    return sorted.find((e) => e.def.policy(e.ctx)) ?? null;
  };
  if (!baseUrl) return fallback();
  try {
    const decision = await fetchDecision({
      baseUrl,
      apiKey,
      context: { candidates },
      timeoutMs: REACTION_DECISION_TIMEOUT_MS,
    });
    if (decision.candidateId === "decline") return null;
    return byCandidateId.get(decision.candidateId) ?? fallback();
  } catch (err) {
    console.error("npc-reactions: combat-decision call failed, falling back to priority order:", err.message);
    return fallback();
  }
}

/**
 * The one entry point every trigger source calls: finds every eligible
 * (definition, reactor) pair for `triggerEvent`, groups them by reactor
 * (one reaction per creature per round, so two reactors never compete for
 * the same slot), decides each reactor's pick via the hybrid policy, and
 * executes the winners. Never throws — a failing executor or decision
 * call is logged and the remaining reactors still resolve.
 */
export async function resolveReactions(
  combat,
  triggerEvent,
  { fetchDecision = fetchCombatDecision } = {},
) {
  const all = eligibleReactionDefs(combat, triggerEvent);
  const byReactor = new Map();
  for (const entry of all) {
    const list = byReactor.get(entry.reactor.id) ?? [];
    list.push(entry);
    byReactor.set(entry.reactor.id, list);
  }
  for (const eligible of byReactor.values()) {
    try {
      const winner = await decideAmong(eligible, { fetchDecision });
      if (winner) await winner.def.execute(winner.ctx);
    } catch (err) {
      console.error(`npc-reactions: executing a reaction failed:`, err.message);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/npc-reactions.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/npc-reactions.mjs tests/npc-reactions.test.mjs
git commit -m "feat(#931): add the hybrid reaction-decision dispatcher

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Movement triggers — strike-kind executors, migrating Reactive Strike/AoO in

**Files:**
- Modify: `scripts/npc-reactions.mjs` (fill in the three `strike`-kind `execute` fields)
- Modify: `scripts/dungeon-combat.mjs` (replace `offerReactiveStrikesAgainst`'s body with a call into the registry; add the `movementDisrupted` turn-state field; add `moveInReach` detection for Twisting Tail/Wing Rebuff)
- Test: `tests/dungeon-combat-reactive-strike.test.mjs` (existing — re-point at the registry, confirm it still passes), `tests/npc-reactions.test.mjs` (continued, new executor tests)

**Interfaces:**
- Consumes: `resolveReactions` (Task 3), `markReactionUsed`, `rollAndApplyStrikeAtVariant`, `getAgentTurnState`, `setAgentTurnState` (all existing).
- Produces (consumed by Task 7): a public chat line per executed strike reaction, matching #202's existing `postReactiveStrikeChat` shape generalized to any `strike`-kind def; `getAgentTurnState`'s returned shape grows a `movementDisrupted` boolean field, read by the stride-candidate builder (patched in Step 5 below) to stop offering further Stride candidates this turn.

- [ ] **Step 1: Read the existing regression test in full**

Read `tests/dungeon-combat-reactive-strike.test.mjs` completely before changing anything — it is the regression suite this task must keep green. Note its exact fixture shapes for `combat`/`reactor`/`mover` so the registry-backed path matches them.

- [ ] **Step 2: Write the new failing tests**

```js
// Added to tests/npc-reactions.test.mjs
describe('strike-kind executors', () => {
  it('reactive-strike marks the reaction used, rolls a Strike against the mover, and posts a public chat line', async () => {
    // Mock rollAndApplyStrikeAtVariant and ChatMessage.create (module-level
    // vi.mock of '../scripts/dungeon-combat.mjs' for the roll function,
    // globalThis.ChatMessage for the chat call). Confirm execute(ctx) calls
    // markReactionUsed(combat, reactor.id, combat.round),
    // rollAndApplyStrikeAtVariant(combat, reactor, mover, ctx.actionSlug, 0),
    // and ChatMessage.create with content mentioning both names.
  });

  it("twisting-tail's strike applies a -2 modifier and, on a hit, sets movementDisrupted on the mover's turn state", async () => {
    // Stub rollAndApplyStrikeAtVariant to resolve 'success'; confirm the
    // modifier array passed includes a -2 circumstance/untyped penalty,
    // and that setAgentTurnState was called with movementDisrupted: true
    // for the mover's combatant id when the mover is agent-controlled.
  });

  it("twisting-tail does not set movementDisrupted on a miss", async () => {
    // Stub rollAndApplyStrikeAtVariant to resolve 'failure'; confirm
    // setAgentTurnState was not called with movementDisrupted: true.
  });

  it("twisting-tail posts a GM-visible note instead of setting turn state when the mover is not agent-controlled", async () => {
    // mover.getFlag('pf2e-dungeon-crawl', 'agentControlled') === false;
    // confirm a whispered ChatMessage.create call happens instead of any
    // setAgentTurnState call.
  });

  it("wing-rebuff's strike disrupts the move only when the Strike's own damage outcome includes a Push (per the spec's own 'if the roc Pushes the creature' text)", async () => {
    // Stub rollAndApplyStrikeAtVariant's resolved value/shape per however
    // Task 4's own real rollAndApplyStrikeAtVariant return is read (confirm
    // its real return shape live before writing this test's final mock --
    // #925's plan already confirmed every executor returns *something*
    // meaningful; re-check this one specifically for a push/outcome
    // signal before asserting on it).
  });
});
```

- [ ] **Step 3: Confirm `rollAndApplyStrikeAtVariant`'s real return shape before finalizing Wing Rebuff's test**

Run: `grep -n "async function rollAndApplyStrikeAtVariant" -A 40 scripts/dungeon-combat.mjs`

Read the full function. If it returns a plain outcome string (as #925's own investigation already confirmed for the sibling `rollAndApplyStrikeAtVariant` calls used by Strike candidates), Wing Rebuff's "Pushes the creature" check cannot be derived from that string alone — a Push is a weapon trait effect, not a degree of success. If the real function has no seam that reports whether a Push rider actually fired, treat this as a genuine open implementation question and resolve it the same way `applyManeuverOutcome` resolves an unclear modifier shape elsewhere in this codebase: check whether the roc's Wing Rebuff item or its Strike action has a `Push` rule element/trait the module can read directly off the item rather than off the roll's outcome, and condition the disruption on "the Strike hit AND the action has a Push trait" instead of trying to detect the push's own resolution. Document whichever real mechanism is found in the code's own comment, not in this plan — this plan's own obligation is to flag the question, not guess at an unverified mechanism.

- [ ] **Step 4: Implement the three strike executors in `scripts/npc-reactions.mjs`**

```js
import { rollAndApplyStrikeAtVariant, getAgentTurnState, setAgentTurnState } from "./dungeon-combat.mjs";

const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);

async function postReactionChat(reactor, mover, label) {
  const content = `<p><strong>${esc(reactor.name)}</strong> reacts with ${esc(label)} against ${esc(mover.name)}!</p>`;
  await ChatMessage.create({ content });
}

async function postGmNote(text) {
  const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
  await ChatMessage.create({ content: `<p>${esc(text)}</p>`, whisper: gmIds });
}

async function disruptMovement(combat, mover, text) {
  if (mover.getFlag("pf2e-dungeon-crawl", "agentControlled")) {
    const turnState = getAgentTurnState(combat, mover.id);
    await setAgentTurnState(combat, mover.id, { ...turnState, movementDisrupted: true });
  } else {
    await postGmNote(text);
  }
}

async function executeReactiveStrike(ctx) {
  const { combat, reactor, mover, actionSlug } = ctx;
  await markReactionUsed(combat, reactor.id, combat.round);
  await rollAndApplyStrikeAtVariant(combat, reactor, mover, actionSlug, 0);
  await postReactionChat(reactor, mover, "a Reactive Strike");
}

async function executeTwistingTail(ctx) {
  const { combat, reactor, mover, actionSlug } = ctx;
  await markReactionUsed(combat, reactor.id, combat.round);
  const outcome = await rollAndApplyStrikeAtVariant(combat, reactor, mover, actionSlug, 0, {
    modifiers: [{ label: "Twisting Tail", modifier: -2 }],
  });
  await postReactionChat(reactor, mover, "Twisting Tail");
  if (outcome === "success" || outcome === "criticalSuccess") {
    await disruptMovement(combat, mover, `${mover.name}'s move was disrupted by ${reactor.name}'s Twisting Tail.`);
  }
}

async function executeWingRebuff(ctx) {
  const { combat, reactor, mover, actionSlug } = ctx;
  await markReactionUsed(combat, reactor.id, combat.round);
  const outcome = await rollAndApplyStrikeAtVariant(combat, reactor, mover, actionSlug, 0);
  await postReactionChat(reactor, mover, "Wing Rebuff");
  // See this task's own Step 3: the Push-specific disruption condition is
  // confirmed against the real rollAndApplyStrikeAtVariant/item data
  // during implementation, not guessed here.
  if (outcome === "success" || outcome === "criticalSuccess") {
    await disruptMovement(combat, mover, `${mover.name}'s move was disrupted by ${reactor.name}'s Wing Rebuff.`);
  }
}
```

Wire these into `REACTION_DEFS`' three `strike`-kind rows (`execute: executeReactiveStrike`, `execute: executeTwistingTail`, `execute: executeWingRebuff`), and add `markReactionUsed` to the existing import list from `./dungeon-combat.mjs`.

Add `rollAndApplyStrikeAtVariant`'s optional fourth-argument `modifiers` parameter if it doesn't already accept one — check its real signature first (`grep -n "async function rollAndApplyStrikeAtVariant" -A 5 scripts/dungeon-combat.mjs`); if it doesn't, add `modifiers = []` as an additional parameter threaded into whatever modifier array the function already builds for the roll, defaulting to `[]` so every existing call site is unaffected.

- [ ] **Step 5: Replace `offerReactiveStrikesAgainst`'s body and wire `moveInReach` detection**

In `scripts/dungeon-combat.mjs`:

```js
export async function offerReactiveStrikesAgainst(combat, mover) {
  if (!isModuleCombat(combat)) return;
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  await resolveReactions(combat, { trigger: "leaveReach", mover, gridSize, gridDistanceFt, combat });
  await resolveReactions(combat, { trigger: "moveInReach", mover, gridSize, gridDistanceFt, combat });
}
```

(Both trigger kinds share the same "mover just finished moving" moment — `leaveReach` for Reactive Strike/AoO's "left a threatened square", `moveInReach` for Twisting Tail/Wing Rebuff's "moved into or within reach". `ctx.combat` is included explicitly since `eligibleReactionDefs`/`decideAmong`'s executors need it and `resolveReactions`'s own signature already threads it through as the first positional argument, not part of `triggerEvent` — confirm `executeReactiveStrike`/`executeTwistingTail`/`executeWingRebuff` read `ctx.combat` consistently with however Task 2/3's own `ctx` shape actually spreads `combat` in; adjust the spread in `eligibleReactionDefs` to include `combat` in `ctx` if it doesn't already, since Task 2's draft above did not.)

Add the `import { resolveReactions } from "./npc-reactions.mjs";` line near the top of `dungeon-combat.mjs`, alongside the existing imports. This is a one-directional dependency (`npc-reactions.mjs` imports helpers from `dungeon-combat.mjs`, and `dungeon-combat.mjs` imports `resolveReactions` back) — confirm this doesn't create a circular-import failure under the project's real ES-module resolution before committing; if it does, move the shared helpers `isReactiveStrikeInScope`/`getReactionUsed`/`markReactionUsed`/etc. out of `dungeon-combat.mjs` into a small shared `scripts/reaction-shared.mjs` instead, imported by both files, and update Task 2's own import list accordingly. Run `npm test` after this step specifically to catch any circular-import error early, before writing further code on top of it.

- [ ] **Step 6: Add `movementDisrupted` to the turn-state shape and gate Stride candidates on it**

In `getAgentTurnState`/`setAgentTurnState` (`scripts/dungeon-combat.mjs`), add `movementDisrupted: stored.movementDisrupted ?? false` / `turnState.movementDisrupted ?? false` alongside the existing `flourishUsed`/`stanceUsed` fields, and to `initAgentTurnState()`'s own default object.

Find the Stride candidate builder (`grep -n "type: \"stride\"" scripts/dungeon-combat.mjs` — read the surrounding function) and add an early return/filter so no `stride`-type candidate is produced when `getAgentTurnState(combat, combatant.id).movementDisrupted` is true.

- [ ] **Step 7: Run both test files to verify everything passes**

Run: `npm test -- tests/dungeon-combat-reactive-strike.test.mjs tests/npc-reactions.test.mjs`
Expected: PASS — the existing regression suite unchanged in behavior, the new executor tests green.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures) — confirm nothing else referencing `offerReactiveStrikesAgainst`'s old internals broke.

- [ ] **Step 9: Commit**

```bash
git add scripts/npc-reactions.mjs scripts/dungeon-combat.mjs tests/npc-reactions.test.mjs
git commit -m "feat(#931): wire movement-triggered reactions through the registry

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Damage-incoming trigger — Shield Block

**Files:**
- Modify: `scripts/npc-reactions.mjs` (fill in `shield-block`'s `execute`)
- Modify: `scripts/dungeon-combat.mjs` (call `resolveReactions` with a `damageIncoming` event at both existing damage-application call sites)
- Test: `tests/npc-reactions.test.mjs` (continued)

**Interfaces:**
- Consumes: `resolveReactions` (Task 3), `markReactionUsed`, the real `Actor#applyDamage({ shieldBlockRequest })` call shape (confirmed live in the installed PF2e system).
- Produces: nothing further downstream — terminal for this trigger kind.

- [ ] **Step 1: Confirm where damage is actually applied for an agent-controlled reactor**

Run: `grep -n "applyDamage(" scripts/dungeon-combat.mjs`

Read each call site. One is `handleManualStrikeDamage` (#47, for human-controlled attackers' targets); confirm the other(s) are inside `rollAndApplyStrike`/`rollAndApplyStrikeAtVariant` or wherever an AI Strike applies damage to its target. Shield Block only matters when the **reactor being hit** is agent-controlled (an NPC with a shield reacting to an incoming hit, whether the attacker is a player or another AI actor) — both call sites can be the trigger source, since both can name an agent-controlled target.

- [ ] **Step 2: Write the failing test**

```js
describe('shield-block executor', () => {
  it('passes shieldBlockRequest: true through applyDamage when eligible', async () => {
    // ctx carries { reactor, incomingDamageTotal, shieldHardness, applyDamageArgs }
    // per however Step 4 below actually threads the pending applyDamage
    // call through -- confirm execute mutates/returns something the
    // caller then uses to add shieldBlockRequest: true to its own
    // applyDamage({...}) call, rather than calling applyDamage itself a
    // second time (which would double-apply damage).
  });
});
```

(Deliberately left for the implementer to finalize the exact mechanism once Step 1's investigation into the real call sites' control flow is done — the one hard constraint, stated here explicitly, is **never call `applyDamage` twice for the same hit**: the reaction must modify the single pending `applyDamage` call's own `shieldBlockRequest` argument, not add a second, separate damage-application call.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/npc-reactions.test.mjs`
Expected: FAIL.

- [ ] **Step 4: Implement the damage-incoming trigger and Shield Block's executor**

At each of the call site(s) found in Step 1, immediately before the existing `await target.actor.applyDamage({ ... })` call, insert:

```js
let shieldBlockRequest = false;
await resolveReactions(combat, {
  trigger: "damageIncoming",
  mover: attacker, // the existing "triggerEvent.mover" naming from Tasks 2/3 is reused for "the creature whose action is triggering this" regardless of trigger kind
  reactors: [target],
  incomingDamageTotal: damageRoll.total,
  shieldHardness: target.actor.heldShield?.system?.hardness?.value ?? 0,
  onShieldBlock: () => { shieldBlockRequest = true; },
});
```

and change the existing `applyDamage({ ... })` call to include `shieldBlockRequest`.

In `scripts/npc-reactions.mjs`:

```js
async function executeShieldBlock(ctx) {
  const { combat, reactor } = ctx;
  await markReactionUsed(combat, reactor.id, combat.round);
  ctx.onShieldBlock?.();
}
```

Confirm `target.actor.heldShield` is the real accessor for the actor's currently-raised/equipped shield in the installed PF2e system (`grep -n "get heldShield" /srv/foundry/data/Data/systems/pf2e/pf2e.mjs`) before finalizing this read — if the real accessor differs, use the real one and note the correction in the commit message, the same way every other premise correction this session has been handled.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/npc-reactions.test.mjs`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/npc-reactions.mjs scripts/dungeon-combat.mjs tests/npc-reactions.test.mjs
git commit -m "feat(#931): wire Shield Block through the damage-incoming trigger

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Attack-roll trigger — AC-bonus reactions (the documented fallback)

**Files:**
- Modify: `scripts/npc-reactions.mjs` (fill in the `acBonus` kind's shared `execute`)
- Modify: `scripts/dungeon-combat.mjs` (new `createChatMessage` handler for `attack-roll` messages)
- Modify: `scripts/module.mjs` (register the new hook)
- Test: `tests/npc-reactions.test.mjs`, `tests/dungeon-combat-npc-reactions-acbonus.test.mjs`

**Interfaces:**
- Consumes: `resolveReactions` (Task 3).
- Produces: nothing further downstream — terminal for this trigger kind. The paired `damage-roll` message for a hit this reaction flips to a miss must be recognized and skipped by `handleManualStrikeDamage`/the AI damage path — see Step 4.

- [ ] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-npc-reactions-acbonus.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { handleAttackRollForAcBonusReactions } from '../scripts/dungeon-combat.mjs';

describe('handleAttackRollForAcBonusReactions', () => {
  it('ignores a message that is not an attack-roll', async () => {
    // context.type !== 'attack-roll' -> no resolveReactions call.
  });

  it('ignores an attack-roll whose target is not an agent-controlled NPC reactor', async () => {
    // context.target names a combatant without agentControlled -> no call.
  });

  it('calls resolveReactions with trigger "targetedByAttack" and the attack roll total/dc for an in-scope message', async () => {
    // Confirm the triggerEvent carries whatever wouldFlipOutcome needs:
    // the roll total and context.dc.value, so the policy function in
    // Task 2's REACTION_DEFS table can compute wouldFlipOutcome itself.
  });
});

describe('acBonus executor (wouldFlipOutcome gate + fallback reporting)', () => {
  it('marks the reaction used and posts a table-visible note when the policy already confirmed the bonus flips the degree of success', async () => {
    // ctx.wouldFlipOutcome is computed by the policy before execute ever
    // runs (per REACTION_DEFS' own policy: (ctx) => ctx.wouldFlipOutcome),
    // so execute's own job is just: mark the reaction used, flag the
    // paired damage-roll message to be skipped, and post the note.
  });

  it('flags the attack message so the paired damage-roll skip (Step 4) recognizes it', async () => {
    // Confirm execute sets a flag Step 4's own damage-application code
    // checks for -- e.g. a module flag on the attack message itself, or
    // an entry in a short-lived combat flag keyed by the message id.
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-npc-reactions-acbonus.test.mjs tests/npc-reactions.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement the trigger handler in `scripts/dungeon-combat.mjs`**

```js
/**
 * #931: an attack-roll chat message whose target is an agent-controlled
 * reactor may have an AC-bonus reaction (Wing Deflection, Ghost Dodge,
 * Swat Projectile) available against it. Fires after the roll already
 * exists (the module doesn't own the roll itself, see #931's own spec),
 * so this is a retroactive check: the policy only triggers the reaction
 * when adding its bonus would have changed a hit into a miss. Confirmed
 * live that rewriting the message's own stored outcome would not change
 * the rendered card (CheckRoll#degreeOfSuccess is baked in at roll-render
 * time), so the executor never attempts that -- it only marks the
 * reaction used, flags the paired damage roll to be skipped, and posts an
 * explicit note instead of touching the original card.
 */
export async function handleAttackRollForAcBonusReactions(message) {
  if (!game.user.isGM) return;
  const context = message.flags?.pf2e?.context;
  if (context?.type !== "attack-roll") return;
  const sceneId = message.speaker?.scene;
  if (!sceneId) return;
  const combat = game.combats.contents.find(
    (c) => c.scene?.id === sceneId && isModuleCombat(c),
  );
  if (!combat) return;
  const targetTokenUuid = context.target?.token;
  if (!targetTokenUuid) return;
  const targetTokenId = targetTokenUuid.split(".").pop();
  const reactor = combat.combatants.find((c) => c.tokenId === targetTokenId);
  if (!reactor || !reactor.getFlag(MODULE_ID, "agentControlled")) return;
  const attackerTokenId = message.speaker?.token;
  const attacker = combat.combatants.find((c) => c.tokenId === attackerTokenId);
  if (!attacker) return;

  await resolveReactions(combat, {
    trigger: "targetedByAttack",
    mover: attacker,
    reactors: [reactor],
    rollTotal: message.rolls?.[0]?.total ?? 0,
    dcValue: context.dc?.value ?? null,
    isPhysicalRanged: context.options?.includes("ranged") && !context.options?.includes("spell-attack-roll"),
    messageId: message.id,
  });
}
```

Confirm `context.options` really does carry a `"ranged"` tag for a physical ranged Strike the same way `handleRangedAttackForReactiveStrike` already reads it (it does, per that function's own existing code) — Swat Projectile's own `isPhysicalRanged` gate reuses exactly that convention rather than inventing a new one, and explicitly excludes a ranged spell attack (which is not "physical").

- [ ] **Step 4: Implement `wouldFlipOutcome` and the shared `acBonus` executor in `scripts/npc-reactions.mjs`**

Add `eligible`/`policy` bodies to the `wing-deflection-ghost-dodge` and `swat-projectile` rows that compute `wouldFlipOutcome` once, from `ctx.rollTotal`/`ctx.dcValue` and the definition's own bonus (+2 for Wing Deflection/Ghost Dodge, +4 for Swat Projectile):

```js
function degreeFor(total, dc) {
  if (total >= dc + 10) return "criticalSuccess";
  if (total >= dc) return "success";
  if (total <= dc - 10) return "criticalFailure";
  return "failure";
}

function wouldFlipToMiss(ctx, bonus) {
  if (ctx.dcValue == null) return false;
  const before = degreeFor(ctx.rollTotal, ctx.dcValue);
  const after = degreeFor(ctx.rollTotal, ctx.dcValue + bonus);
  const isHit = (d) => d === "success" || d === "criticalSuccess";
  return isHit(before) && !isHit(after);
}
```

(This reimplements PF2e's own simple degree-of-success arithmetic rather than calling the system's own `DegreeOfSuccess` class, which needs a live `CheckRoll` instance this handler doesn't have — only the stored `total`/`dc.value` numbers survive onto the chat message. Confirm this matches the real `DegreeOfSuccess` constructor's own rule (`grep -n "class DegreeOfSuccess" -A 30 /srv/foundry/data/Data/systems/pf2e/pf2e.mjs`) before finalizing — it is a well-known, stable PF2e rule (±10 for critical) but verify the installed system hasn't special-cased something this plan isn't aware of, such as a roll-twice or fortune/misfortune adjustment already baked into `total`.)

Set each row's `eligible`/`policy`:

```js
// wing-deflection-ghost-dodge row:
eligible: (ctx) => true,
policy: (ctx) => { ctx.wouldFlipOutcome = wouldFlipToMiss(ctx, 2); return ctx.wouldFlipOutcome; },
// swat-projectile row:
eligible: (ctx) => ctx.isPhysicalRanged,
policy: (ctx) => { ctx.wouldFlipOutcome = wouldFlipToMiss(ctx, 4); return ctx.wouldFlipOutcome; },
```

Shared executor:

```js
async function executeAcBonusReaction(ctx) {
  const { combat, reactor, mover, messageId } = ctx;
  await markReactionUsed(combat, reactor.id, combat.round);
  const skipped = combat.getFlag(MODULE_ID, "acBonusSkipDamage") ?? {};
  await combat.setFlag(MODULE_ID, "acBonusSkipDamage", { ...skipped, [messageId]: true });
  await postGmNote(
    `${reactor.name}'s reaction would have turned ${mover.name}'s hit into a miss -- damage is being skipped for this attack. (The original roll's chat card still shows the pre-reaction result; this is a known, approved limitation -- see #931.)`,
  );
}
```

Wire both `wing-deflection-ghost-dodge` and `swat-projectile` rows' `execute` to `executeAcBonusReaction`.

- [ ] **Step 5: Make the paired damage-roll skip the flagged attack**

In `handleManualStrikeDamage` and the AI damage-application path (the same call sites touched in Task 5), after resolving `context.target`/before calling `applyDamage`, check:

```js
const skipped = combat.getFlag(MODULE_ID, "acBonusSkipDamage") ?? {};
if (message.flags?.pf2e?.context?.sourceId && skipped[message.flags.pf2e.context.sourceId]) return;
```

Confirm the real field name linking a `damage-roll` message back to its originating `attack-roll` message (`grep -n "sourceId\|associatedAttackRoll\|flags.pf2e.context" /srv/foundry/data/Data/systems/pf2e/pf2e.mjs | grep -i "damage"` or inspect a real paired attack-roll/damage-roll message pair live) before finalizing this lookup key — PF2e's own linkage field name is confirmed during implementation, not assumed here; if no such field exists on the message, use the attacker+target+round combination already available (`message.speaker.token`, `context.target.token`, `combat.round`) as the matching key instead, storing `acBonusSkipDamage` keyed by that tuple rather than by message id.

- [ ] **Step 6: Register the new hook in `scripts/module.mjs`**

```js
import { handleAttackRollForAcBonusReactions } from "./dungeon-combat.mjs";
```

```js
/** #931: a retroactive AC-bonus reaction (Wing Deflection, Ghost Dodge,
 * Swat Projectile) against an attack targeting an agent-controlled
 * reactor. */
Hooks.on("createChatMessage", handleAttackRollForAcBonusReactions);
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-npc-reactions-acbonus.test.mjs tests/npc-reactions.test.mjs`
Expected: PASS.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/npc-reactions.mjs scripts/dungeon-combat.mjs scripts/module.mjs tests/npc-reactions.test.mjs tests/dungeon-combat-npc-reactions-acbonus.test.mjs
git commit -m "feat(#931): wire AC-bonus reactions through the attack-roll trigger

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: GM-less vs GM-present mode switching, confirm card, version bump

**Files:**
- Modify: `scripts/npc-reactions.mjs` (gate `acBonus`/`damageReduction` executors on mode when the attacker is player-driven)
- Modify: `module.json`
- Test: `tests/npc-reactions.test.mjs`

**Interfaces:**
- Consumes: `findActiveHostedRun` (`scripts/dungeon-runner.mjs`, existing).
- Produces: nothing further — terminal task.

- [ ] **Step 1: Write the failing tests**

```js
import { findActiveHostedRun } from '../scripts/dungeon-runner.mjs';
vi.mock('../scripts/dungeon-runner.mjs', () => ({ findActiveHostedRun: vi.fn() }));

describe('mode switching for acBonus/damageReduction against a player-driven attack', () => {
  it('executes automatically with no confirm card when a GM-less run is active for this combat\'s scene', async () => {
    findActiveHostedRun.mockReturnValue({ sceneId: 'scene1', hostUserId: 'u1' });
    // combat.scene.id === 'scene1', attacker is player-driven (not
    // agentControlled) -> execute runs immediately, no confirm-card
    // ChatMessage is posted.
  });

  it('posts a one-click GM-confirm card instead of executing when a human GM is present and the attacker is player-driven', async () => {
    findActiveHostedRun.mockReturnValue(null);
    // Confirm a ChatMessage.create call with a button/flag the GM can
    // click, and that markReactionUsed/the executor's own side effects
    // have NOT yet happened.
  });

  it('executes automatically regardless of mode when the attacker is itself agent-controlled (monster-vs-monster)', async () => {
    // Mode switching only applies to a player-driven attacker, per the
    // spec's own "Player-driven attacks, GM present vs GM-less" section --
    // confirm this case bypasses the mode check entirely.
  });

  it('clicking the confirm card\'s button runs the same executor the automatic path would have run', async () => {
    // Simulate the card's own click handler invocation directly (calling
    // whatever function it's wired to) and confirm it produces the same
    // markReactionUsed + effect as the GM-less automatic path.
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/npc-reactions.test.mjs`
Expected: FAIL.

- [ ] **Step 3: Implement mode switching**

```js
import { findActiveHostedRun } from "./dungeon-runner.mjs";

function isGmLess(combat) {
  return findActiveHostedRun()?.sceneId === combat.scene?.id;
}

function isPlayerDriven(mover) {
  return !mover?.getFlag?.("pf2e-dungeon-crawl", "agentControlled");
}

/** Wraps an acBonus/damageReduction executor so a player-driven attacker
 * (never an agent-controlled one -- monster-vs-monster is always
 * automatic, per #931's own spec) gets a one-click GM-confirm card
 * instead of immediate execution whenever a human GM is actually present
 * at the table. */
function withModeGate(rawExecute) {
  return async function gatedExecute(ctx) {
    if (isGmLess(ctx.combat) || !isPlayerDriven(ctx.mover)) {
      return rawExecute(ctx);
    }
    const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
    await ChatMessage.create({
      content: `<p><strong>${esc(ctx.reactor.name)}</strong> can react against ${esc(ctx.mover.name)}'s attack. <button data-action="pf2e-dungeon-crawl-confirm-reaction">Confirm</button></p>`,
      whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id),
      flags: { "pf2e-dungeon-crawl": { pendingReactionConfirm: { ctxId: ctx.confirmId } } },
    });
  };
}
```

Apply `withModeGate` when wiring the `wing-deflection-ghost-dodge`, `swat-projectile`, and `shield-block` rows' `execute` fields in `REACTION_DEFS` (`execute: withModeGate(executeAcBonusReaction)`, etc.) — movement-triggered `strike` reactions (Reactive Strike/AoO, Twisting Tail, Wing Rebuff) are never gated, since the spec's mode-switching section only names `acBonus`/`damageReduction` against attacks.

For the confirm card's own click handler, follow this repo's existing convention for a chat-card button (find one via `grep -rn "data-action=" scripts/*.mjs module.mjs 2>/dev/null` or `grep -rn "renderChatMessage\|getChatLogEntryContext\|chat-card" scripts/module.mjs` to locate the real existing click-wiring pattern this codebase already uses elsewhere, and match it exactly — do not invent a new click-binding convention when one already exists in this codebase). The handler must re-run the exact same `rawExecute(ctx)` the automatic path would have run, keyed by whatever identifier (`ctx.confirmId`) the card's own flag stores; the `ctx` object itself (being non-serializable — it carries live Foundry documents) cannot be stored in the message flag directly, so store enough primitive identifiers (combat id, reactor id, mover id, trigger kind, def id, and the specific scalar fields each policy/executor reads: `rollTotal`, `dcValue`, `incomingDamageTotal`, `shieldHardness`, `messageId`) to reconstruct an equivalent `ctx` when the button is clicked, resolving the live documents fresh from `game.combats`/`combat.combatants` at click time rather than trusting anything cached from creation time (a combatant could have been removed in between).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/npc-reactions.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Version bump**

Run: `grep '"version"' module.json`

Minor bump per `CLAUDE.md`'s versioning rule (a new cross-cutting subsystem spanning registry, three trigger paths, and mode switching — not a routine fix).

- [ ] **Step 7: Commit**

```bash
git add scripts/npc-reactions.mjs module.json
git commit -m "feat(#931): gate acBonus/damageReduction reactions by GM presence

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- "The reaction registry" / shared gates / initial table — Task 2, matching every row and every shared gate the spec names.
- "Trigger sources" (movement, attack roll resolved, damage resolved) — Tasks 4/5/6 respectively.
- "Deciding: the hybrid" (none/one/several, 5s timeout, fallback to priority order) — Task 3, with a dedicated timeout test and a dedicated fallback-on-throw test.
- "Executing" — strike kinds (Task 4), damageReduction/Shield Block (Task 5), the retroactive acBonus adjustment (Task 6, using the spec's own named fallback as the sole mechanism rather than its primary suggestion — a premise correction documented in Global Constraints, not a silent scope cut).
- "Player-driven attacks, GM present vs GM-less" — Task 7, with the explicit monster-vs-monster bypass and the GM-less-always-automatic rule each getting their own test.
- "Error handling" section — a failing trigger hook never throwing (Task 3's `resolveReactions` wraps every executor call in try/catch; Task 6/4's hook handlers each check for a missing combat/reactor/attacker before acting); the decision timeout/failure being the normal fallback path, not an error (Task 3); a reaction skipped rather than executed-unrecorded when the used-flag write fails (inherent to `markReactionUsed`'s own existing `await`-before-anything-else ordering, reused as-is); a missing/defeated/removed token or actor being skipped (`isDownedCharacter`/combatant-lookup guards throughout).
- "Testing" section's enumerated cases — each has a direct task-owned test; "Live verification" (a monster with Twisting Tail and one with Shield Block, in both GM and GM-less runs, including a player's Strike against the shield-blocker) is named here as the one item this plan cannot itself automate, matching every prior plan's own treatment of live verification.
- "Explicitly out of scope" (death/save/other-trigger reactions, PC feat reactions, pre-roll interception, Ghost Dodge resistances/Swat Projectile throw-back) — none of these appear anywhere in this plan's own task list, confirmed by re-reading Tasks 1–7 against this list line by line.

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X". Several steps (Task 4 Step 3's Wing Rebuff Push mechanism, Task 5 Step 1's exact call-site mechanics, Task 6 Step 5's message-linkage field name, Task 7 Step 3's click-binding convention) are deliberately left as "confirm the real mechanism before finalizing, using method X" rather than a guessed implementation — each names exactly what to check and how, which is this session's established convention for a genuinely unverified implementation detail, not a vague instruction standing in for real code. Every other step contains complete, concrete code.

**3. Type consistency:** `REACTION_DEFS` row shape (`id, match, trigger, kind, priority, eligible, policy, execute`) is defined once in Task 2 and every later task fills in existing rows' `execute` fields without changing the shape. `ctx`'s growing field set (`reactor, mover, combat, actionSlug, incomingDamageTotal, shieldHardness, rollTotal, dcValue, isPhysicalRanged, wouldFlipOutcome, messageId, confirmId, onShieldBlock`) is introduced incrementally by the task that first needs each field, and every later task's executor reads exactly the field name the earlier task wrote (e.g. `wouldFlipOutcome` set by `policy` in Task 6, read by nothing outside that same task's own executor — confirmed no naming drift against `wouldFlipToMiss`'s own return).

**4. Review Focus:** all five items have a direct test — the one-reaction-per-round economy checked ahead of registry priority (Task 2's "excludes a reactor who already used their reaction this round" test, which runs before any priority-ordering logic even applies); a mid-resolution deleted/missing token or actor skipped without throwing (Task 3's `resolveReactions` try/catch per reactor, Task 6's attack-roll handler's own `if (!reactor...) return`/`if (!attacker) return` guards); the 5-second timeout actually differing from the client's 35-second default (Task 1's dedicated `AbortSignal.timeout` spy tests, Task 3's fake-timer fallback test); GM-less mode never posting the confirm card (Task 7's first and third tests, phrased to catch the exact backwards-logic risk named in this section); the migrated Reactive Strike/AoO path matching #202's own existing test suite unchanged (Task 4 Step 1's explicit "read the existing regression test first" step and Step 7's explicit re-run of that same file).
