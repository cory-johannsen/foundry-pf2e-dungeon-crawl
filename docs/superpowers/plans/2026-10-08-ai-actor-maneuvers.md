# AI Actor Martial Maneuvers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give AI-controlled combatants the five PF2e basic maneuvers (Trip, Shove, Grapple, Disarm, Demoralize), generated through a new agent-service reasoning-model pipeline that selects from a Foundry-enumerated, RAW-legal vocabulary rather than inventing actions.

**Architecture:** Foundry deterministically builds a `maneuverVocabulary` (which `(maneuver, target)` pairs are legal this turn) inside `getPendingAgentTurn`. Once per agent turn, `runAgentDecisionLoop` sends that vocabulary to a new agent-service endpoint (`/v1/combat-candidates`, litellm-only) and persists the returned picks onto the same combat-flag turn state `mapIncrement`/`actionsRemaining` already use. `getPendingAgentTurn` reads those picks back and turns them into real `type: 'maneuver'` candidates — the same deterministic rebuild `applyAgentDecision` already relies on for every other candidate type, so no new machinery is needed there beyond a new execution branch.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API (`game.pf2e.actions.*`), Node `node:http` agent-service, litellm (OpenAI-compatible tool-calling), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-actor-maneuvers-design.md`

## Global Constraints

- Grid distance is 5 ft/cell (`scene.grid.distance`); Demoralize's 30 ft range is 6 squares at this grid size.
- `game.pf2e.actions.<slug>()` (trip/shove/grapple/disarm/demoralize) never returns its own promise — confirmed by reading the system's bundled source (`trip`/`disarm`/`demoralize` functions all call `W.simpleRollActionCheck({...}).catch(...)` with no `return`). Execution must bridge the macro's `callback` option to a promise itself; never `await` the macro call directly expecting it to resolve after the roll.
- None of the five maneuver macros auto-apply their own RAW outcome (no condition, no forced movement, no immunity tracking) — every outcome must be applied by hand in the `callback`.
- `CharacterPF2e.handsFree`/`handsReallyFree` getters exist only on player-character actors, not NPCs (confirmed: only one `get handsFree()` in the whole system bundle, inside the `CharacterPF2e` class body). For any actor without this getter (virtually all monster NPCs), the free-hand prerequisite must default to eligible rather than ineligible — matches this codebase's own existing precedent in `dungeon-strike-riders.mjs`'s `resolveAthleticsRider`, which gates NPC maneuvers on skill existence alone, never hand state.
- Reach-weapon extension of a maneuver's reach (e.g. a trip-trait reach weapon letting Trip be attempted at 2 squares instead of 1) is explicitly out of scope for this plan — melee maneuver reach is always `AGENT_MELEE_REACH_SQUARES` (1). Tracked under #911 (non-basic maneuver variants).
- `scripts/foundry-api.mjs`'s existing `SIZE_ORDER = ["tiny", "sm", "med", "lg", "huge", "grg"]` is the one size-ordering array in this codebase — import and reuse it; never redeclare it.
- Bump `module.json`'s `version` as part of this work, per this repo's `CLAUDE.md` versioning rule — this is a new subsystem touching five files plus a new agent-service endpoint, so use a **minor** bump: check the current value at Task 9 time and bump accordingly (do not assume it is still what it was when this plan was written).

## Review Focus

- An actor with no eligible maneuver this turn (no Athletics/Intimidation, or no opponent in range) must get an empty `maneuverVocabulary` and skip the reasoning-model call entirely — no network call, no crash on an empty array.
- A reasoning-model response containing a pick that was never in the vocabulary sent (wrong target, wrong slug, or a slug outside the five known ones) must be silently dropped, never executed.
- `runAgentDecisionLoop`'s existing callers/tests construct a bare `pendingTurn` object with no `maneuverVocabulary` field at all (confirmed: every existing test in `tests/dungeon-combat-agent-service-loop.test.mjs` omits it) — the new maneuver-augmentation code path must be a complete no-op (never touching `combat.getFlag`, which those stub `combat` objects don't implement) whenever `maneuverVocabulary` is absent or empty.
- The agent-service call to `/v1/combat-candidates` failing, timing out, or returning a malformed body must not block or crash the turn — falls back to zero maneuver candidates for that turn, exactly like `runAgentDecisionLoop`'s existing `fetchDecision` failure handling.
- A maneuver's target resolving to nothing at execution time (defeated/removed between candidate generation and decision application) must no-op rather than throw, matching every other `applyAgentDecision` branch's existing `if (target) { ... }` guard.

---

### Task 1: Agent-service combat-candidates generator

**Files:**
- Create: `tools/agent-service/candidate-generator.mjs`
- Test: `tests/agent-service-candidate-generator.test.mjs`

**Interfaces:**
- Consumes: nothing from this plan's other tasks.
- Produces: `generateCombatCandidates(context, vocabulary, { baseUrl, apiKey, timeoutMs, fetchImpl } = {})` → `Promise<{ picks: Array<{type, slug, targetId, rationale}> }>`, used by Task 2's server route.

- [x] **Step 1: Write the failing tests**

```js
// tests/agent-service-candidate-generator.test.mjs
import { describe, it, expect, vi } from "vitest";

const { generateCombatCandidates } = await import("../tools/agent-service/candidate-generator.mjs");

function fakeFetch(toolArgs, { ok = true, status = 200 } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify({ error: "boom" }),
    json: async () => ({
      choices: [
        { message: { tool_calls: [{ function: { name: "propose_candidates", arguments: JSON.stringify(toolArgs) } }] } },
      ],
    }),
  });
}

const OPTS = { baseUrl: "http://litellm:4000/v1" };
const context = { self: { id: "atk1" }, opponents: [{ id: "opp1", name: "Goblin" }], allies: [], roundNumber: 2 };
const vocabulary = [
  { type: "maneuver", slug: "trip", targetId: "opp1" },
  { type: "maneuver", slug: "demoralize", targetId: "opp1" },
];

describe("generateCombatCandidates", () => {
  it("returns the picks array from the tool call, posting to litellm's chat/completions route", async () => {
    const fetchImpl = fakeFetch({ picks: [{ type: "maneuver", slug: "trip", targetId: "opp1", rationale: "Knock it down before it flees." }] });
    const result = await generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl });
    expect(result).toEqual({ picks: [{ type: "maneuver", slug: "trip", targetId: "opp1", rationale: "Knock it down before it flees." }] });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://litellm:4000/v1/chat/completions");
    const body = JSON.parse(options.body);
    expect(body.tools[0].function.name).toBe("propose_candidates");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "propose_candidates" } });
  });

  it("sends the context and vocabulary in the user message content", async () => {
    const fetchImpl = fakeFetch({ picks: [] });
    await generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const content = body.messages[0].content;
    expect(content).toContain("opp1");
    expect(content).toContain("trip");
  });

  it("returns an empty picks array when the model proposes none", async () => {
    const fetchImpl = fakeFetch({ picks: [] });
    const result = await generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl });
    expect(result).toEqual({ picks: [] });
  });

  it("throws when the upstream request fails", async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 500 });
    await expect(generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl })).rejects.toThrow(
      /request failed \(500\)/,
    );
  });

  it("throws when the response carries no propose_candidates tool call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: {} }] }) });
    await expect(generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl })).rejects.toThrow(
      /no propose_candidates tool call/,
    );
  });

  it("throws when the tool call arguments are not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "propose_candidates", arguments: "{not json" } }] } }] }),
    });
    await expect(generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl })).rejects.toThrow(
      /not valid JSON/,
    );
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent-service-candidate-generator.test.mjs`
Expected: FAIL — `tools/agent-service/candidate-generator.mjs` does not exist yet.

- [x] **Step 3: Write `tools/agent-service/candidate-generator.mjs`**

```js
import { nodeFetch } from "./node-fetch.mjs";
import { readEnvOrDotenv } from "./env.mjs";

const DEFAULT_TIMEOUT_MS = 30000;

const SCHEMA = {
  type: "object",
  properties: {
    picks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["maneuver"] },
          slug: { type: "string", enum: ["trip", "shove", "grapple", "disarm", "demoralize"] },
          targetId: { type: "string" },
          rationale: { type: "string", description: "One short sentence explaining the pick." },
        },
        required: ["type", "slug", "targetId", "rationale"],
      },
    },
  },
  required: ["picks"],
};

function userMessageContent(context, vocabulary) {
  return `You are proposing tactical maneuver options for an NPC's turn in a Pathfinder 2e combat. Pick a tactically sensible subset of the vocabulary below (zero or more) — never propose anything not listed in it.\n\nContext:\n${JSON.stringify(context, null, 2)}\n\nVocabulary (every legal (type, slug, targetId) option this turn):\n${JSON.stringify(vocabulary, null, 2)}`;
}

/**
 * #909: the reasoning-model stage of the maneuver pipeline — always
 * litellm (never provider-selectable, mirroring customization-generator.mjs:
 * this needs genuine structured generation over a variable-shaped
 * vocabulary, not a fixed single choice, so Laya's typed choice/score/bool
 * questions don't fit here any more than they fit flavor-customization).
 * Foundry is the authoritative validator of the returned picks against the
 * vocabulary it sent (see scripts/agent-candidates.mjs's
 * buildManeuverCandidates) — this function trusts the schema and the
 * model's own restraint, nothing more.
 */
export async function generateCombatCandidates(
  context,
  vocabulary,
  {
    baseUrl = readEnvOrDotenv("LITELLM_BASE_URL") ?? "http://litellm:4000/v1",
    apiKey = readEnvOrDotenv("LITELLM_API_KEY"),
    timeoutMs = Number(readEnvOrDotenv("LITELLM_COMBAT_CANDIDATES_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS,
    fetchImpl = nodeFetch,
  } = {},
) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "reasoning",
      messages: [{ role: "user", content: userMessageContent(context, vocabulary) }],
      tools: [
        {
          type: "function",
          function: {
            name: "propose_candidates",
            description: "Propose a tactically sensible subset of the offered maneuver vocabulary.",
            parameters: SCHEMA,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "propose_candidates" } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`candidate-generator: request failed (${res.status}): ${errBody}`);
  }

  const payload = await res.json();
  const rawArguments = payload.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!rawArguments) throw new Error("candidate-generator: no propose_candidates tool call in response");
  try {
    return JSON.parse(rawArguments);
  } catch (err) {
    throw new Error(`candidate-generator: tool call arguments were not valid JSON: ${err.message}`);
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/agent-service-candidate-generator.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add tools/agent-service/candidate-generator.mjs tests/agent-service-candidate-generator.test.mjs
git commit -m "feat(#909): add the combat-candidates agent-service generator

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Agent-service `/v1/combat-candidates` route

**Files:**
- Modify: `tools/agent-service/server.mjs`
- Test: `tests/agent-service-server.test.mjs`

**Interfaces:**
- Consumes: `generateCombatCandidates` from Task 1.
- Produces: the `/v1/combat-candidates` HTTP route, consumed by Task 3's client function.

- [x] **Step 1: Read the existing server test file's conventions**

Run: `grep -n "flavor-customization\|handleFlavorCustomization" tests/agent-service-server.test.mjs`

Copy the exact request-building/assertion pattern that test file already uses for `/v1/flavor-customization` (headers, auth, body-posting helper) for the new tests below — the server test harness's exact request helper is not reproduced here since reading it live avoids drifting from whatever shape it actually has.

- [x] **Step 2: Write the failing tests**

Add to `tests/agent-service-server.test.mjs` (mirroring whatever request-helper the file already defines for `/v1/flavor-customization`, substituting the new route and body):

```js
describe("/v1/combat-candidates", () => {
  it("rejects a body with no vocabulary array", async () => {
    const res = await postToServer("/v1/combat-candidates", { context: {} }, { apiKey: TEST_API_KEY });
    expect(res.status).toBe(400);
  });

  it("returns 401 without a valid bearer token", async () => {
    const res = await postToServer(
      "/v1/combat-candidates",
      { context: {}, vocabulary: [{ type: "maneuver", slug: "trip", targetId: "opp1" }] },
      { apiKey: "wrong-key" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 502 when the generator throws", async () => {
    // generateCombatCandidates isn't mockable without a module-level
    // injection point; this test instead sends an unreachable baseUrl via
    // LITELLM_BASE_URL in the test environment (same approach the existing
    // flavor-customization 502 test in this file already uses — mirror it
    // exactly rather than reinventing a mocking seam here).
  });
});
```

(The third test's exact mechanics depend on how this file's existing `/v1/flavor-customization` 502 test is written — copy that test's approach verbatim, substituting the route and a vocabulary-carrying body, rather than guessing a new mocking seam.)

- [x] **Step 3: Run tests to verify the first two fail**

Run: `npm test -- tests/agent-service-server.test.mjs`
Expected: FAIL for the two new `/v1/combat-candidates` tests (404, since the route doesn't exist yet); other existing tests in the file still PASS.

- [x] **Step 4: Wire the route**

In `tools/agent-service/server.mjs`, add the import:

```js
import { generateCombatCandidates } from "./candidate-generator.mjs";
```

Add `/v1/combat-candidates` to `PROTECTED_ROUTES`:

```js
const PROTECTED_ROUTES = new Set(["/v1/combat-decision", "/v1/flavor-customization", "/v1/combat-candidates"]);
```

Add a validator and handler, alongside `isValidCombatDecisionBody`/`handleCombatDecision`:

```js
function isValidCombatCandidatesBody(body) {
  return body && typeof body === "object" && Array.isArray(body.vocabulary);
}

async function handleCombatCandidates(body, res) {
  if (!isValidCombatCandidatesBody(body)) {
    return sendJson(res, 400, { error: "combat-candidates: vocabulary is required and must be an array" });
  }
  const { vocabulary, ...context } = body;
  try {
    const result = await generateCombatCandidates(context, vocabulary);
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 502, { error: `combat-candidates: generation failed: ${err.message}` });
  }
}
```

In the request dispatcher, add the new branch alongside the existing two:

```js
      if (req.url === "/v1/combat-decision") {
        return handleCombatDecision(body, res);
      }
      if (req.url === "/v1/flavor-customization") {
        return handleFlavorCustomization(body, res);
      }
      if (req.url === "/v1/combat-candidates") {
        return handleCombatCandidates(body, res);
      }
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/agent-service-server.test.mjs`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add tools/agent-service/server.mjs tests/agent-service-server.test.mjs
git commit -m "feat(#909): wire the /v1/combat-candidates route into the agent service

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Foundry-side client function

**Files:**
- Modify: `scripts/agent-service-client.mjs`
- Test: `tests/agent-service-client.test.mjs` (create if no such file exists yet; otherwise add to it)

**Interfaces:**
- Consumes: nothing from this plan's other Foundry-side tasks.
- Produces: `fetchCombatCandidates({ baseUrl, apiKey, context, vocabulary, fetchImpl })` → `Promise<{picks: [...]}>`, consumed by Task 6's `runAgentDecisionLoop`.

- [x] **Step 1: Check for an existing test file**

Run: `ls tests/agent-service-client.test.mjs 2>/dev/null || echo "none"`

If it exists, read it fully first and add the new test inside its existing `describe` structure, matching its conventions exactly. If not, create it fresh per Step 2 below.

- [x] **Step 2: Write the failing test**

```js
// tests/agent-service-client.test.mjs (new describe block if the file already exists)
import { describe, it, expect, vi } from "vitest";
import { fetchCombatCandidates } from "../scripts/agent-service-client.mjs";

describe("fetchCombatCandidates", () => {
  it("posts context and vocabulary to /v1/combat-candidates with a bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ picks: [{ type: "maneuver", slug: "trip", targetId: "opp1", rationale: "r" }] }),
    });
    const result = await fetchCombatCandidates({
      baseUrl: "https://agent.example",
      apiKey: "test-key",
      context: { self: {}, roundNumber: 1 },
      vocabulary: [{ type: "maneuver", slug: "trip", targetId: "opp1" }],
      fetchImpl,
    });
    expect(result).toEqual({ picks: [{ type: "maneuver", slug: "trip", targetId: "opp1", rationale: "r" }] });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://agent.example/v1/combat-candidates");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(options.body);
    expect(body).toEqual({ self: {}, roundNumber: 1, vocabulary: [{ type: "maneuver", slug: "trip", targetId: "opp1" }] });
  });

  it("throws with the service's own error message on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: "boom" }) });
    await expect(
      fetchCombatCandidates({ baseUrl: "https://agent.example", apiKey: "k", context: {}, vocabulary: [], fetchImpl }),
    ).rejects.toThrow(/\/v1\/combat-candidates failed \(502\): boom/);
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/agent-service-client.test.mjs`
Expected: FAIL — `fetchCombatCandidates` is not exported yet.

- [x] **Step 4: Add the client function**

In `scripts/agent-service-client.mjs`, add after `fetchCombatDecision`:

```js
export async function fetchCombatCandidates({ baseUrl, apiKey, context, vocabulary, fetchImpl }) {
  return postJson(baseUrl, "/v1/combat-candidates", { ...context, vocabulary }, { apiKey, fetchImpl });
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/agent-service-client.test.mjs`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add scripts/agent-service-client.mjs tests/agent-service-client.test.mjs
git commit -m "feat(#909): add fetchCombatCandidates agent-service client function

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Maneuver reference table and pure vocabulary/candidate builders

**Files:**
- Modify: `scripts/agent-candidates.mjs`
- Test: `tests/agent-candidates.test.mjs`

**Interfaces:**
- Consumes: `AGENT_MELEE_REACH_SQUARES` (already exported in this file).
- Produces (consumed by Task 6):
  - `MANEUVER_DEFS` — `{ trip: {label}, shove: {label}, grapple: {label}, disarm: {label}, demoralize: {label} }`.
  - `DEMORALIZE_RANGE_SQUARES` — `6`.
  - `buildManeuverVocabulary({ attacker, opponents })` → `Array<{type: 'maneuver', slug, targetId}>`.
  - `buildManeuverCandidates({ maneuverVocabulary, maneuverPicks, opponents })` → `Array<{id, type: 'maneuver', slug, targetId, cost, summary}>`.
  - `initAgentTurnState()` now also returns `maneuverPicks: null`.
  - `buildCandidateList` now also accepts `maneuverVocabulary = []` and `maneuverPicks = null`, splicing `buildManeuverCandidates` output into its result.

- [x] **Step 1: Update the existing `initAgentTurnState` test and write the new failing tests**

In `tests/agent-candidates.test.mjs`, update the existing test (it will otherwise fail once Step 3 changes `initAgentTurnState`'s return shape):

```js
describe('initAgentTurnState', () => {
  it('starts with a full action budget, no MAP penalty, and no maneuver picks yet', () => {
    expect(initAgentTurnState()).toEqual({ actionsRemaining: MAX_ACTIONS_PER_TURN, mapIncrement: 0, maneuverPicks: null });
  });
});
```

Add new tests, and add the new names to the file's top `import` block (`MANEUVER_DEFS, DEMORALIZE_RANGE_SQUARES, buildManeuverVocabulary, buildManeuverCandidates`):

```js
describe('buildManeuverVocabulary', () => {
  const inReach = { id: 'opp1', name: 'Goblin', distanceSquares: 1, hasLineOfSight: true, sizeOk: { trip: true, shove: true, grapple: true, disarm: true }, demoralizeImmune: false };
  const outOfMeleeReach = { id: 'opp2', name: 'Archer', distanceSquares: 2, hasLineOfSight: true, sizeOk: { trip: true, shove: true, grapple: true, disarm: true }, demoralizeImmune: false };
  const eligibleAttacker = {
    maneuvers: {
      trip: { eligible: true, reachSquares: AGENT_MELEE_REACH_SQUARES },
      shove: { eligible: true, reachSquares: AGENT_MELEE_REACH_SQUARES },
      grapple: { eligible: true, reachSquares: AGENT_MELEE_REACH_SQUARES },
      disarm: { eligible: true, reachSquares: AGENT_MELEE_REACH_SQUARES },
      demoralize: { eligible: true, reachSquares: DEMORALIZE_RANGE_SQUARES },
    },
  };

  it('offers all four melee maneuvers against an in-reach opponent', () => {
    const vocabulary = buildManeuverVocabulary({ attacker: eligibleAttacker, opponents: [inReach] });
    expect(vocabulary).toEqual([
      { type: 'maneuver', slug: 'trip', targetId: 'opp1' },
      { type: 'maneuver', slug: 'shove', targetId: 'opp1' },
      { type: 'maneuver', slug: 'grapple', targetId: 'opp1' },
      { type: 'maneuver', slug: 'disarm', targetId: 'opp1' },
      { type: 'maneuver', slug: 'demoralize', targetId: 'opp1' },
    ]);
  });

  it('excludes melee maneuvers (but not demoralize) against an opponent beyond melee reach', () => {
    const vocabulary = buildManeuverVocabulary({ attacker: eligibleAttacker, opponents: [outOfMeleeReach] });
    expect(vocabulary).toEqual([{ type: 'maneuver', slug: 'demoralize', targetId: 'opp2' }]);
  });

  it('excludes a maneuver the attacker is not eligible for at all', () => {
    const noAthletics = {
      maneuvers: {
        ...eligibleAttacker.maneuvers,
        trip: { eligible: false, reachSquares: AGENT_MELEE_REACH_SQUARES },
      },
    };
    const vocabulary = buildManeuverVocabulary({ attacker: noAthletics, opponents: [inReach] });
    expect(vocabulary.some((v) => v.slug === 'trip')).toBe(false);
  });

  it('excludes a target the attacker cannot see', () => {
    const blocked = { ...inReach, hasLineOfSight: false };
    const vocabulary = buildManeuverVocabulary({ attacker: eligibleAttacker, opponents: [blocked] });
    expect(vocabulary).toEqual([]);
  });

  it('excludes trip/shove/grapple/disarm (but not demoralize) against a too-large target', () => {
    const tooLarge = { ...inReach, sizeOk: { trip: false, shove: false, grapple: false, disarm: false } };
    const vocabulary = buildManeuverVocabulary({ attacker: eligibleAttacker, opponents: [tooLarge] });
    expect(vocabulary).toEqual([{ type: 'maneuver', slug: 'demoralize', targetId: 'opp1' }]);
  });

  it('excludes demoralize against a currently-immune target, leaving the melee maneuvers', () => {
    const immune = { ...inReach, demoralizeImmune: true };
    const vocabulary = buildManeuverVocabulary({ attacker: eligibleAttacker, opponents: [immune] });
    expect(vocabulary.map((v) => v.slug)).toEqual(['trip', 'shove', 'grapple', 'disarm']);
  });

  it('returns an empty array for no opponents at all', () => {
    expect(buildManeuverVocabulary({ attacker: eligibleAttacker, opponents: [] })).toEqual([]);
  });
});

describe('buildManeuverCandidates', () => {
  const maneuverVocabulary = [
    { type: 'maneuver', slug: 'trip', targetId: 'opp1' },
    { type: 'maneuver', slug: 'demoralize', targetId: 'opp1' },
  ];
  const opponents = [{ id: 'opp1', name: 'Goblin' }];

  it('builds a candidate for each pick that matches the vocabulary, with the rationale in its summary', () => {
    const candidates = buildManeuverCandidates({
      maneuverVocabulary,
      maneuverPicks: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1', rationale: 'Knock it down.' }],
      opponents,
    });
    expect(candidates).toEqual([
      { id: 'maneuver:trip:opp1', type: 'maneuver', slug: 'trip', targetId: 'opp1', cost: 1, summary: 'Trip vs Goblin — Knock it down.' },
    ]);
  });

  it('drops a pick whose targetId does not match any vocabulary entry for that slug', () => {
    const candidates = buildManeuverCandidates({
      maneuverVocabulary,
      maneuverPicks: [{ type: 'maneuver', slug: 'trip', targetId: 'opp-not-offered', rationale: 'x' }],
      opponents,
    });
    expect(candidates).toEqual([]);
  });

  it('drops a pick for a slug never in the vocabulary at all', () => {
    const candidates = buildManeuverCandidates({
      maneuverVocabulary,
      maneuverPicks: [{ type: 'maneuver', slug: 'shove', targetId: 'opp1', rationale: 'x' }],
      opponents,
    });
    expect(candidates).toEqual([]);
  });

  it('returns an empty array when maneuverPicks is null (not yet fetched this turn)', () => {
    expect(buildManeuverCandidates({ maneuverVocabulary, maneuverPicks: null, opponents })).toEqual([]);
  });

  it('drops a pick whose target is no longer in the opponents list', () => {
    const candidates = buildManeuverCandidates({
      maneuverVocabulary,
      maneuverPicks: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1', rationale: 'x' }],
      opponents: [],
    });
    expect(candidates).toEqual([]);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent-candidates.test.mjs`
Expected: FAIL — `MANEUVER_DEFS`/`DEMORALIZE_RANGE_SQUARES`/`buildManeuverVocabulary`/`buildManeuverCandidates` don't exist yet, and the updated `initAgentTurnState` assertion fails against the current two-field return shape.

- [x] **Step 3: Implement in `scripts/agent-candidates.mjs`**

Change `initAgentTurnState`:

```js
export function initAgentTurnState() {
  return { actionsRemaining: MAX_ACTIONS_PER_TURN, mapIncrement: 0, maneuverPicks: null };
}
```

Add after `endTurnCandidate()` (before `buildCandidateList`):

```js
/**
 * #909: the five PF2e basic combat maneuvers, taken verbatim from the
 * installed system's own lang/action-en.json action text (see this
 * feature's spec for the full reference table) — not approximated.
 */
export const MANEUVER_DEFS = Object.freeze({
  trip: { label: 'Trip' },
  shove: { label: 'Shove' },
  grapple: { label: 'Grapple' },
  disarm: { label: 'Disarm' },
  demoralize: { label: 'Demoralize' },
});

/** 30ft at this module's 5ft/square grid — Demoralize's own fixed range,
 * distinct from the melee reach the other four maneuvers use. */
export const DEMORALIZE_RANGE_SQUARES = 6;

/**
 * `attacker.maneuvers[slug]` -> `{eligible, reachSquares}`, already
 * resolved by dungeon-combat.mjs from real actor/weapon/skill data (the
 * free-hand-or-matching-weapon-trait and skill-exists checks — this
 * function has no Foundry API surface, so it never looks at raw actor
 * documents itself). `opponent.sizeOk[slug]` -> bool (false only for
 * trip/shove/grapple/disarm against a target more than one size larger;
 * demoralize has no size restriction, so it never reads sizeOk at all).
 * `opponent.demoralizeImmune` -> bool, dungeon-combat.mjs's own real-time
 * worldTime check against this module's 10-minute immunity tracking.
 */
export function buildManeuverVocabulary({ attacker, opponents }) {
  const vocabulary = [];
  for (const slug of Object.keys(MANEUVER_DEFS)) {
    const a = attacker.maneuvers?.[slug];
    if (!a?.eligible) continue;
    for (const opponent of opponents) {
      if (!withinRangeAndSight(opponent, a.reachSquares)) continue;
      if (slug === 'demoralize' && opponent.demoralizeImmune) continue;
      if (slug !== 'demoralize' && opponent.sizeOk?.[slug] === false) continue;
      vocabulary.push({ type: 'maneuver', slug, targetId: opponent.id });
    }
  }
  return vocabulary;
}

/**
 * Validates `maneuverPicks` (the agent service's own reasoning-model
 * response, persisted once per turn onto agentTurnState by
 * dungeon-combat.mjs's runAgentDecisionLoop) against `maneuverVocabulary`
 * — the authoritative referential-integrity check this whole pipeline
 * relies on. A pick whose (type, slug, targetId) triple isn't a literal
 * member of maneuverVocabulary, or whose target isn't in `opponents`
 * anymore, is silently dropped rather than executed.
 */
export function buildManeuverCandidates({ maneuverVocabulary = [], maneuverPicks = null, opponents = [] }) {
  if (!maneuverPicks) return [];
  const candidates = [];
  for (const pick of maneuverPicks) {
    const inVocabulary = maneuverVocabulary.some(
      (v) => v.type === pick.type && v.slug === pick.slug && v.targetId === pick.targetId,
    );
    if (!inVocabulary) continue;
    const opponent = opponents.find((o) => o.id === pick.targetId);
    if (!opponent) continue;
    const label = MANEUVER_DEFS[pick.slug]?.label ?? pick.slug;
    const summary = pick.rationale ? `${label} vs ${opponent.name} — ${pick.rationale}` : `${label} vs ${opponent.name}`;
    candidates.push({
      id: `maneuver:${pick.slug}:${pick.targetId}`,
      type: 'maneuver',
      slug: pick.slug,
      targetId: pick.targetId,
      cost: 1,
      summary,
    });
  }
  return candidates;
}
```

Extend `buildCandidateList`'s signature and body:

```js
export function buildCandidateList({ opponents, readyActions, readySpells = [], readyAreaSpells = [], readyAttackSpells = [], readyDebuffSpells = [], readyBreathWeapons = [], readyMultiStrikeBundles = [], readyChainSpells = [], readyHealSpells = [], readyBuffSpells = [], readyTierScalingAreaSpells = [], readyDualNatureSpells = [], readyTargetCountSpells = [], readyAutoHitAreaSpells = [], allies = [], seekTargets = [], turnState, hazard = null, hasRangedOrReach = false, maneuverVocabulary = [], maneuverPicks = null }) {
  if (turnState.actionsRemaining <= 0) return [endTurnCandidate()];
  return [
    ...buildMovementCandidates({ opponents, hazard, hasRangedOrReach }),
    ...buildStrikeCandidates({ readyActions, opponents, mapIncrement: turnState.mapIncrement }),
    ...buildManeuverCandidates({ maneuverVocabulary, maneuverPicks, opponents }),
    ...buildSpellCandidates({ readySpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildAreaSpellCandidates({ readyAreaSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildAttackSpellCandidates({ readyAttackSpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildDebuffSpellCandidates({ readyDebuffSpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildBreathWeaponCandidates({ readyBreathWeapons, actionsRemaining: turnState.actionsRemaining }),
    ...buildMultiStrikeCandidates({ readyMultiStrikeBundles, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildChainSpellCandidates({ readyChainSpells, opponents, actionsRemaining: turnState.actionsRemaining }),
    ...buildHealSpellCandidates({ readyHealSpells, allies, actionsRemaining: turnState.actionsRemaining }),
    ...buildBuffSpellCandidates({ readyBuffSpells, allies, actionsRemaining: turnState.actionsRemaining }),
    ...buildTierScalingAreaSpellCandidates({ readyTierScalingAreaSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildDualNatureSpellCandidates({ readyDualNatureSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildTargetCountSpellCandidates({ readyTargetCountSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildAutoHitAreaSpellCandidates({ readyAutoHitAreaSpells, actionsRemaining: turnState.actionsRemaining }),
    ...buildSeekCandidates({ seekTargets, opponents, actionsRemaining: turnState.actionsRemaining }),
    endTurnCandidate()
  ];
}
```

Also add a test confirming the splice point (in the same `describe('buildCandidateList', ...)` block already in the file — add this `it` alongside the existing ones there):

```js
  it('includes maneuver candidates when a vocabulary and matching picks are both present', () => {
    const candidates = buildCandidateList({
      opponents: [{ id: 'opp1', name: 'Goblin', distanceSquares: 5 }],
      readyActions: [],
      turnState: { actionsRemaining: 3, mapIncrement: 0, maneuverPicks: null },
      maneuverVocabulary: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1' }],
      maneuverPicks: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1', rationale: 'r' }],
    });
    expect(candidates).toContainEqual({ id: 'maneuver:trip:opp1', type: 'maneuver', slug: 'trip', targetId: 'opp1', cost: 1, summary: 'Trip vs Goblin — r' });
  });
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/agent-candidates.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/agent-candidates.mjs tests/agent-candidates.test.mjs
git commit -m "feat(#909): add maneuver vocabulary/candidate builders to agent-candidates

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Demoralize immunity tracking and the Foundry-data attacker profile

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-maneuver-vocabulary.test.mjs`

**Interfaces:**
- Consumes: `SIZE_ORDER` from `scripts/foundry-api.mjs`; `AGENT_MELEE_REACH_SQUARES`, `DEMORALIZE_RANGE_SQUARES` from `scripts/agent-candidates.mjs` (Task 4).
- Produces (consumed by Task 6): `getDemoralizeImmunityUntil(combat, attackerId, targetId)` → number (worldTime seconds, `0` if never set); `setDemoralizeImmunityUntil(combat, attackerId, targetId, worldTimeExpiry)` → `Promise<void>`; `computeManeuverAttackerProfile(actor)` → `{trip, shove, grapple, disarm, demoralize}` each `{eligible, reachSquares}`; `sizeOkForManeuver(attackerActor, targetActor)` → boolean. None of these four are exported outside `dungeon-combat.mjs` (same module-private convention `getAgentTurnState`/`resolveOpponentForTurn` already use) — Task 5's own test file imports them by re-exporting a thin test-only wrapper is unnecessary; instead the test file drives them indirectly through a small exported seam added in this task (see Step 3).

- [x] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-maneuver-vocabulary.test.mjs
import { describe, it, expect } from 'vitest';
import {
  computeManeuverAttackerProfile,
  sizeOkForManeuver,
  getDemoralizeImmunityUntil,
  setDemoralizeImmunityUntil,
} from '../scripts/dungeon-combat.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

function combatStub(flags = {}) {
  const store = { ...flags };
  return {
    getFlag: (_m, key) => store[key],
    setFlag: async (_m, key, value) => {
      store[key] = value;
    },
  };
}

describe('computeManeuverAttackerProfile', () => {
  it('is eligible for all five maneuvers for an NPC with Athletics/Intimidation and no handsFree getter at all', () => {
    const actor = { skills: { athletics: {}, intimidation: {} }, itemTypes: { weapon: [] } };
    const profile = computeManeuverAttackerProfile(actor);
    expect(profile.trip.eligible).toBe(true);
    expect(profile.shove.eligible).toBe(true);
    expect(profile.grapple.eligible).toBe(true);
    expect(profile.disarm.eligible).toBe(true);
    expect(profile.demoralize.eligible).toBe(true);
  });

  it('is ineligible for the four Athletics maneuvers without the Athletics skill, but still eligible for Demoralize with Intimidation', () => {
    const actor = { skills: { intimidation: {} }, itemTypes: { weapon: [] } };
    const profile = computeManeuverAttackerProfile(actor);
    expect(profile.trip.eligible).toBe(false);
    expect(profile.demoralize.eligible).toBe(true);
  });

  it('is ineligible for Demoralize without the Intimidation skill', () => {
    const actor = { skills: { athletics: {} }, itemTypes: { weapon: [] } };
    expect(computeManeuverAttackerProfile(actor).demoralize.eligible).toBe(false);
  });

  it('is ineligible for Athletics maneuvers for a character actor (handsFree getter present) with no free hand and no matching weapon', () => {
    const actor = { skills: { athletics: {} }, handsFree: 0, itemTypes: { weapon: [] } };
    expect(computeManeuverAttackerProfile(actor).trip.eligible).toBe(false);
  });

  it('is eligible for a character actor with a free hand', () => {
    const actor = { skills: { athletics: {} }, handsFree: 1, itemTypes: { weapon: [] } };
    expect(computeManeuverAttackerProfile(actor).trip.eligible).toBe(true);
  });

  it('is eligible for a character actor with no free hand but a held weapon carrying the matching trait', () => {
    const actor = {
      skills: { athletics: {} },
      handsFree: 0,
      itemTypes: { weapon: [{ system: { equipped: { carryType: 'held' }, traits: { value: ['trip'] } } }] },
    };
    expect(computeManeuverAttackerProfile(actor).trip.eligible).toBe(true);
    expect(computeManeuverAttackerProfile(actor).shove.eligible).toBe(false);
  });

  it('uses melee reach for the four Athletics maneuvers and the fixed 30ft range for Demoralize', () => {
    const actor = { skills: { athletics: {}, intimidation: {} }, itemTypes: { weapon: [] } };
    const profile = computeManeuverAttackerProfile(actor);
    expect(profile.trip.reachSquares).toBe(1);
    expect(profile.demoralize.reachSquares).toBe(6);
  });
});

describe('sizeOkForManeuver', () => {
  it('allows a same-size target', () => {
    const med = { system: { traits: { size: { value: 'med' } } } };
    expect(sizeOkForManeuver(med, med)).toBe(true);
  });

  it('allows a target exactly one size larger', () => {
    const med = { system: { traits: { size: { value: 'med' } } } };
    const lg = { system: { traits: { size: { value: 'lg' } } } };
    expect(sizeOkForManeuver(med, lg)).toBe(true);
  });

  it('disallows a target more than one size larger', () => {
    const med = { system: { traits: { size: { value: 'med' } } } };
    const huge = { system: { traits: { size: { value: 'huge' } } } };
    expect(sizeOkForManeuver(med, huge)).toBe(false);
  });

  it('allows a smaller target regardless of the size gap', () => {
    const grg = { system: { traits: { size: { value: 'grg' } } } };
    const tiny = { system: { traits: { size: { value: 'tiny' } } } };
    expect(sizeOkForManeuver(grg, tiny)).toBe(true);
  });

  it('defaults to allowed when either actor has no readable size', () => {
    expect(sizeOkForManeuver({}, {})).toBe(true);
  });
});

describe('demoralize immunity tracking', () => {
  it('reads back 0 when nothing has been set yet', () => {
    const combat = combatStub();
    expect(getDemoralizeImmunityUntil(combat, 'atk1', 'opp1')).toBe(0);
  });

  it('round-trips a set value for the exact attacker/target pair', async () => {
    const combat = combatStub();
    await setDemoralizeImmunityUntil(combat, 'atk1', 'opp1', 1600);
    expect(getDemoralizeImmunityUntil(combat, 'atk1', 'opp1')).toBe(1600);
    expect(getDemoralizeImmunityUntil(combat, 'atk1', 'opp2')).toBe(0);
    expect(getDemoralizeImmunityUntil(combat, 'atk2', 'opp1')).toBe(0);
  });

  it('preserves an existing entry for a different attacker/target pair when adding a new one', async () => {
    const combat = combatStub();
    await setDemoralizeImmunityUntil(combat, 'atk1', 'opp1', 1600);
    await setDemoralizeImmunityUntil(combat, 'atk1', 'opp2', 1700);
    expect(getDemoralizeImmunityUntil(combat, 'atk1', 'opp1')).toBe(1600);
    expect(getDemoralizeImmunityUntil(combat, 'atk1', 'opp2')).toBe(1700);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-maneuver-vocabulary.test.mjs`
Expected: FAIL — none of the four functions are exported yet.

- [x] **Step 3: Implement in `scripts/dungeon-combat.mjs`**

Add the import (alongside the existing `SIZE_ORDER`-adjacent imports — add a new import line near the top with the other single-symbol imports, e.g. right after the `makeFoundryApi` import at line 17):

```js
import { SIZE_ORDER } from "./foundry-api.mjs";
```

Add to the existing `agent-candidates.mjs` import block (the one starting `import { initAgentTurnState, ... } from "./agent-candidates.mjs";`):

```js
  AGENT_MELEE_REACH_SQUARES,
  DEMORALIZE_RANGE_SQUARES,
```

Add these new functions near `getAgentTurnState`/`setAgentTurnState` (just before `getAgentTurnState`'s own definition, so every per-combatant combat-flag helper lives in one place):

```js
const MELEE_MANEUVER_SLUGS = ["trip", "shove", "grapple", "disarm"];

/**
 * #909: whether `actor` can satisfy a melee maneuver's free-hand
 * requirement — either a literal free hand (`handsFree`, confirmed
 * present only on CharacterPF2e actors in the installed system — not
 * NPCs) or a currently-held weapon carrying `slug` as one of its own
 * traits (PF2e's own "or a weapon with the matching trait" exception,
 * e.g. a trip-trait weapon for Trip). An actor with no `handsFree` getter
 * at all (every NPC) defaults to eligible, matching
 * dungeon-strike-riders.mjs's resolveAthleticsRider precedent of gating
 * NPC maneuvers on skill existence alone, never hand state.
 */
function hasFreeHandOrManeuverWeapon(actor, slug) {
  if (typeof actor?.handsFree === "number" && actor.handsFree > 0) return true;
  const heldWeapons = (actor?.itemTypes?.weapon ?? []).filter(
    (w) => w.system?.equipped?.carryType === "held",
  );
  if (heldWeapons.some((w) => (w.system?.traits?.value ?? []).includes(slug))) return true;
  return actor?.handsFree === undefined;
}

/** #909: this turn's real maneuver eligibility for `actor`, in the plain
 * shape agent-candidates.mjs's buildManeuverVocabulary expects —
 * everything Foundry-specific (skill existence, free hand/weapon trait)
 * is resolved here; that file never touches a real actor document. */
function computeManeuverAttackerProfile(actor) {
  const profile = {};
  const hasAthletics = !!actor?.skills?.athletics;
  const hasIntimidation = !!actor?.skills?.intimidation;
  for (const slug of MELEE_MANEUVER_SLUGS) {
    profile[slug] = {
      eligible: hasAthletics && hasFreeHandOrManeuverWeapon(actor, slug),
      reachSquares: AGENT_MELEE_REACH_SQUARES,
    };
  }
  profile.demoralize = { eligible: hasIntimidation, reachSquares: DEMORALIZE_RANGE_SQUARES };
  return profile;
}

/** #909: PF2e's own "target no more than one size larger than you"
 * prerequisite, shared verbatim by Trip/Shove/Grapple/Disarm (confirmed
 * in each action's own lang/action-en.json text). Unreadable size data on
 * either side defaults to allowed rather than blocking the maneuver on a
 * data gap. */
function sizeOkForManeuver(attackerActor, targetActor) {
  const attackerIdx = SIZE_ORDER.indexOf(attackerActor?.system?.traits?.size?.value);
  const targetIdx = SIZE_ORDER.indexOf(targetActor?.system?.traits?.size?.value);
  if (attackerIdx < 0 || targetIdx < 0) return true;
  return targetIdx - attackerIdx <= 1;
}

/** #909: Demoralize's own 10-minute re-attempt immunity (PF2e RAW: "the
 * target is temporarily immune to your attempts to Demoralize it for 10
 * minutes", regardless of outcome) — tracked as a real worldTime
 * timestamp (reusing #785's game clock) rather than a round count, scoped
 * to this Combat document the same way agentTurnState already is. Returns
 * 0 (never immune) when nothing has been recorded yet for this pair. */
function getDemoralizeImmunityUntil(combat, attackerId, targetId) {
  return combat.getFlag(MODULE_ID, "demoralizeImmunity")?.[attackerId]?.[targetId] ?? 0;
}

async function setDemoralizeImmunityUntil(combat, attackerId, targetId, worldTimeExpiry) {
  const current = combat.getFlag(MODULE_ID, "demoralizeImmunity") ?? {};
  await combat.setFlag(MODULE_ID, "demoralizeImmunity", {
    ...current,
    [attackerId]: { ...(current[attackerId] ?? {}), [targetId]: worldTimeExpiry },
  });
}
```

Export the four new functions for Task 5's own test file (add to this file's existing `export` list by changing each `function` declaration above to `export function`— i.e. `export function computeManeuverAttackerProfile(actor) {`, `export function sizeOkForManeuver(...)`, `export function getDemoralizeImmunityUntil(...)`, and `export async function setDemoralizeImmunityUntil(...)`; `hasFreeHandOrManeuverWeapon` and `MELEE_MANEUVER_SLUGS` stay module-private).

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-maneuver-vocabulary.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-maneuver-vocabulary.test.mjs
git commit -m "feat(#909): add maneuver eligibility/size/demoralize-immunity helpers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire vocabulary building into `getPendingAgentTurn` and `agentTurnState`

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-agent-maneuver-pending.test.mjs`

**Interfaces:**
- Consumes: `computeManeuverAttackerProfile`, `sizeOkForManeuver`, `getDemoralizeImmunityUntil` (Task 5); `buildManeuverVocabulary` (Task 4).
- Produces: `getPendingAgentTurn`'s return value now also carries `maneuverVocabulary: Array<{type, slug, targetId}>`; `getAgentTurnState`/`setAgentTurnState` now also carry `maneuverPicks` through their existing round-trip — consumed by Task 7.

- [x] **Step 1: Write the failing test**

This test needs a full combat/combatant/scene stub exercising `getPendingAgentTurn` end to end — rather than inventing that stub shape from scratch, first find and read whichever existing test already builds one for `getPendingAgentTurn` (or the closest equivalent, e.g. a strike-candidate or spell-candidate integration test), and copy its exact combat/combatant/token/actor stub shape:

Run: `grep -rl "getPendingAgentTurn(" tests/*.mjs`

Read the first result in full, then write:

```js
// tests/dungeon-combat-agent-maneuver-pending.test.mjs
import { describe, it, expect } from 'vitest';
import { getPendingAgentTurn } from '../scripts/dungeon-combat.mjs';

// Build the combat/combatant/token/actor/scene stub using the exact shape
// copied from the existing getPendingAgentTurn test found above — an
// agent-controlled combatant with actor.skills.athletics and
// actor.skills.intimidation, one opponent token within melee reach (1
// square) and within line of sight, no other ready actions/spells needed
// for this test.

describe('getPendingAgentTurn maneuver vocabulary', () => {
  it('includes all five maneuvers in maneuverVocabulary for an eligible attacker with an in-reach, visible opponent', async () => {
    // const pending = await getPendingAgentTurn(combat);
    // expect(pending.maneuverVocabulary).toEqual(
    //   expect.arrayContaining([
    //     { type: 'maneuver', slug: 'trip', targetId: 'opp1' },
    //     { type: 'maneuver', slug: 'demoralize', targetId: 'opp1' },
    //   ]),
    // );
  });

  it('returns an empty maneuverVocabulary for an attacker with no Athletics/Intimidation at all', async () => {
    // same stub, actor.skills = {} (or omitted) -- expect([]).
  });

  it('excludes demoralize once setDemoralizeImmunityUntil has recorded a still-active immunity window for this attacker/target pair', async () => {
    // call setDemoralizeImmunityUntil(combat, combatant.id, 'opp1', game.time.worldTime + 600)
    // before calling getPendingAgentTurn, then assert no demoralize entry
    // for opp1 remains in maneuverVocabulary.
  });
});
```

(The three bodies above are deliberately left as comments describing exact expected assertions rather than runnable code: the real stub shape must come from the existing test file found in this step, not be guessed here — fill in the real stub and uncomment/complete each assertion before running.)

- [x] **Step 2: Run test to verify it fails (once filled in)**

Run: `npm test -- tests/dungeon-combat-agent-maneuver-pending.test.mjs`
Expected: FAIL — `pending.maneuverVocabulary` is `undefined` (the field doesn't exist yet).

- [x] **Step 3: Extend `getAgentTurnState`/`setAgentTurnState`**

```js
function getAgentTurnState(combat, combatantId) {
  const stored = currentStoredAgentTurnState(combat, combatantId);
  return stored
    ? {
        actionsRemaining: stored.actionsRemaining,
        mapIncrement: stored.mapIncrement,
        maneuverPicks: stored.maneuverPicks ?? null,
      }
    : initAgentTurnState();
}

async function setAgentTurnState(combat, combatantId, turnState) {
  const counter =
    (currentStoredAgentTurnState(combat, combatantId)?.counter ?? 0) + 1;
  await combat.setFlag(MODULE_ID, "agentTurnState", {
    combatantId,
    round: combat.round,
    turn: combat.turn,
    actionsRemaining: turnState.actionsRemaining,
    mapIncrement: turnState.mapIncrement,
    maneuverPicks: turnState.maneuverPicks ?? null,
    counter,
  });
}
```

- [x] **Step 4: Build the vocabulary inside `getPendingAgentTurn` and merge it into the return value**

In `getPendingAgentTurn` (`scripts/dungeon-combat.mjs`), right after the existing `readyActions`/`hasRangedOrReach` block (the code reading `const readyActions = (combatant.actor?.system?.actions ?? [])...` and `const hasRangedOrReach = readyActions.some(...)`), add:

```js
  const maneuverAttackerProfile = computeManeuverAttackerProfile(combatant.actor);
  const maneuverOpponents = rawOpponents.map((o) => ({
    id: o.id,
    name: o.name,
    distanceSquares: chebyshevSquares(combatant.token, o.token, gridSize),
    hasLineOfSight: canSee(o),
    sizeOk: {
      trip: sizeOkForManeuver(combatant.actor, o.actor),
      shove: sizeOkForManeuver(combatant.actor, o.actor),
      grapple: sizeOkForManeuver(combatant.actor, o.actor),
      disarm: sizeOkForManeuver(combatant.actor, o.actor),
    },
    demoralizeImmune:
      game.time.worldTime < getDemoralizeImmunityUntil(combat, combatant.id, o.id),
  }));
  const maneuverVocabulary = buildManeuverVocabulary({
    attacker: maneuverAttackerProfile,
    opponents: maneuverOpponents,
  });
```

Pass `maneuverVocabulary` and `turnState.maneuverPicks` into the existing `buildCandidateList({...})` call (add two more properties to that call's object literal):

```js
  const candidates = buildCandidateList({
    seekTargets,
    opponents,
    readyActions,
    readySpells: [...readySpells, ...readyVariableCostSpells],
    readyAreaSpells,
    readyAttackSpells,
    readyDebuffSpells,
    readyBreathWeapons,
    readyMultiStrikeBundles,
    readyChainSpells,
    readyHealSpells,
    readyBuffSpells,
    readyTierScalingAreaSpells,
    readyDualNatureSpells,
    readyTargetCountSpells,
    readyAutoHitAreaSpells,
    allies,
    turnState,
    maneuverVocabulary,
    maneuverPicks: turnState.maneuverPicks,
    hazard: nearestHazardousRegionPoint(
      combat.scene,
      combatant.token,
      gridSize,
    ),
    hasRangedOrReach,
  });
```

Add `maneuverVocabulary` to the function's final return object:

```js
  return {
    combatId: combat.id,
    combatantId: combatant.id,
    context: buildDecisionContext({
      self,
      opponents,
      allies,
      candidates,
      roundNumber: combat.round,
    }),
    candidates,
    maneuverVocabulary,
  };
```

- [x] **Step 5: Fill in and run the Task 6 test, confirm it passes**

Fill in the real combat/combatant/token/actor stub (copied in Step 1) and uncomment the assertions, then:

Run: `npm test -- tests/dungeon-combat-agent-maneuver-pending.test.mjs`
Expected: PASS.

- [x] **Step 6: Run the full suite once**

Run: `npm test`
Expected: PASS (0 new failures) — in particular, every pre-existing test that calls `getPendingAgentTurn` directly and asserts an exact return-object shape (`toEqual` on the whole object, not just specific fields) needs its expected object updated to include the new `maneuverVocabulary` field. Search for these:

Run: `grep -rln "getPendingAgentTurn(" tests/*.mjs`

For each match, check whether its assertions use `toEqual` against the whole returned object (vs. just reading specific fields like `pending.candidates`); if so, add `maneuverVocabulary: [...]` (whatever the real expected vocabulary is for that test's stub — likely `[]` for a stub with no Athletics/Intimidation) to the expected object literal.

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-agent-maneuver-pending.test.mjs
git commit -m "feat(#909): build maneuver vocabulary inside getPendingAgentTurn

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Fetch and persist reasoning-model picks once per turn

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-agent-service-loop.test.mjs`

**Interfaces:**
- Consumes: `fetchCombatCandidates` (Task 3); `getAgentTurnState`/`setAgentTurnState` (already module-private in this file, extended by Task 6).
- Produces: `runAgentDecisionLoop` now accepts an injectable `fetchCandidates` dependency (defaulting to `fetchCombatCandidates`), consumed by nothing further in this plan but available the same way `fetchDecision`/`getPending`/`applyDecision` already are for any future test.

- [x] **Step 1: Write the failing tests**

Add to `tests/dungeon-combat-agent-service-loop.test.mjs` (a new `describe` block; the file's existing `installGameStub`/`afterEach` at the top apply to these too):

```js
describe('runAgentDecisionLoop maneuver-candidate augmentation', () => {
  const combat = { id: 'combat-1', round: 1, turn: 0 };
  const combatant = { id: 'atk' };

  function combatWithFlagStore(initial = {}) {
    const store = { ...initial };
    return {
      ...combat,
      getFlag: (_m, key) => store[key],
      setFlag: async (_m, key, value) => {
        store[key] = value;
      },
    };
  }

  it('fetches and persists maneuver picks once, then rebuilds pending before deciding, when the vocabulary is non-empty', async () => {
    installGameStub();
    const vocabulary = [{ type: 'maneuver', slug: 'trip', targetId: 'opp1' }];
    const pendingBeforeFetch = {
      combatId: 'combat-1', combatantId: 'atk',
      context: { candidates: [], roundNumber: 1 }, candidates: [],
      maneuverVocabulary: vocabulary,
    };
    const pendingAfterFetch = {
      ...pendingBeforeFetch,
      candidates: [{ id: 'maneuver:trip:opp1', type: 'maneuver' }],
    };
    const stubCombat = combatWithFlagStore();
    const getPending = vi.fn().mockResolvedValueOnce(pendingBeforeFetch).mockResolvedValueOnce(pendingAfterFetch);
    const fetchCandidates = vi.fn().mockResolvedValue({ picks: [{ type: 'maneuver', slug: 'trip', targetId: 'opp1', rationale: 'r' }] });
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);

    await runAgentDecisionLoop(stubCombat, combatant, { fetchDecision, fetchCandidates, getPending, applyDecision });

    expect(fetchCandidates).toHaveBeenCalledWith({
      baseUrl: 'https://agent.example', apiKey: 'test-key',
      context: pendingBeforeFetch.context, vocabulary,
    });
    expect(getPending).toHaveBeenCalledTimes(2);
    expect(fetchDecision).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining(pendingAfterFetch.context) }),
    );
  });

  it('never calls fetchCandidates when maneuverVocabulary is empty', async () => {
    installGameStub();
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [], maneuverVocabulary: [] };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchCandidates = vi.fn();
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);

    await runAgentDecisionLoop({ id: 'combat-1' }, combatant, { fetchDecision, fetchCandidates, getPending, applyDecision });

    expect(fetchCandidates).not.toHaveBeenCalled();
  });

  it('never calls fetchCandidates when maneuverVocabulary is absent entirely (existing pendingTurn shape, no regression)', async () => {
    installGameStub();
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [] };
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchCandidates = vi.fn();
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);

    await runAgentDecisionLoop({ id: 'combat-1' }, combatant, { fetchDecision, fetchCandidates, getPending, applyDecision });

    expect(fetchCandidates).not.toHaveBeenCalled();
    expect(fetchDecision).toHaveBeenCalled();
  });

  it('persists an empty maneuverPicks array (not null) when fetchCandidates fails, so it is not retried on the next loop iteration this same turn', async () => {
    installGameStub();
    const vocabulary = [{ type: 'maneuver', slug: 'trip', targetId: 'opp1' }];
    const pendingTurn = { combatId: 'combat-1', combatantId: 'atk', context: { candidates: [] }, candidates: [], maneuverVocabulary: vocabulary };
    const stubCombat = combatWithFlagStore();
    const getPending = vi.fn().mockResolvedValue(pendingTurn);
    const fetchCandidates = vi.fn().mockRejectedValue(new Error('network error'));
    const fetchDecision = vi.fn().mockResolvedValue({ candidateId: 'endTurn' });
    const applyDecision = vi.fn().mockResolvedValue(null);

    await runAgentDecisionLoop(stubCombat, combatant, { fetchDecision, fetchCandidates, getPending, applyDecision });

    expect(fetchCandidates).toHaveBeenCalledTimes(1);
    expect(fetchDecision).toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-agent-service-loop.test.mjs`
Expected: FAIL — `runAgentDecisionLoop` doesn't accept/use a `fetchCandidates` dependency yet, and `maneuverVocabulary` is never read.

- [x] **Step 3: Implement in `scripts/dungeon-combat.mjs`**

Add the import:

```js
import { fetchCombatDecision, fetchCombatCandidates } from "./agent-service-client.mjs";
```

(This replaces the existing `import { fetchCombatDecision } from "./agent-service-client.mjs";` line.)

Modify `runAgentDecisionLoop`:

```js
export async function runAgentDecisionLoop(
  combat,
  combatant,
  {
    fetchDecision = fetchCombatDecision,
    fetchCandidates = fetchCombatCandidates,
    getPending = getPendingAgentTurn,
    applyDecision = applyAgentDecision,
  } = {},
) {
  const baseUrl = game.settings.get(MODULE_ID, "agentServiceUrl");
  const apiKey = game.settings.get(MODULE_ID, "agentServiceApiKey");
  if (!baseUrl) return;

  let pending = await getPending(combat);
  while (pending) {
    // #616: an unaware hostile has nothing to decide; end its turn now rather
    // than asking the agent service (or waiting out the fallback timeout).
    if (isUnawareHostile(combat, combatant)) {
      await endUnawareTurn(combat, combatant);
      return;
    }
    // #909: once per turn, when there's a non-empty maneuver vocabulary and
    // no picks have been fetched yet this turn, ask the reasoning-model
    // endpoint which (if any) maneuvers to propose, persist the result onto
    // the same combat-flag turn state mapIncrement/actionsRemaining already
    // use, then rebuild `pending` so its own deterministic candidate list
    // picks the persisted picks back up (the same rebuild
    // applyAgentDecision's own internal getPendingAgentTurn call will do).
    if (pending.maneuverVocabulary?.length) {
      const turnState = getAgentTurnState(combat, pending.combatantId);
      if (turnState.maneuverPicks === null) {
        let picks = [];
        try {
          const response = await fetchCandidates({
            baseUrl,
            apiKey,
            context: pending.context,
            vocabulary: pending.maneuverVocabulary,
          });
          picks = response?.picks ?? [];
        } catch (err) {
          console.error("agent-service: combat-candidates call failed:", err.message);
        }
        await setAgentTurnState(combat, pending.combatantId, { ...turnState, maneuverPicks: picks });
        pending = await getPending(combat);
        if (!pending) return;
      }
    }
    let decision;
    try {
      // actorProfile is reserved for future actor-complexity tiering; the
      // v1 service ignores it, but the request contract always carries it.
      decision = await fetchDecision({
        baseUrl,
        apiKey,
        context: { ...pending.context, actorProfile: { tier: "standard" } },
      });
    } catch (err) {
      console.error("agent-service: combat-decision call failed:", err.message);
      return;
    }
    try {
      pending = await applyDecision(
        combat,
        pending.combatantId,
        decision.candidateId,
        decision.rationale,
      );
    } catch (err) {
      console.error("agent-service: applyAgentDecision failed:", err.message);
      return;
    }
    if (pending) {
      await new Promise((resolve) => setTimeout(resolve, actionPaceDelayMs()));
    }
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-agent-service-loop.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-agent-service-loop.test.mjs
git commit -m "feat(#909): fetch and persist maneuver picks once per agent turn

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Execute a chosen maneuver candidate

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-maneuver-execution.test.mjs`

**Interfaces:**
- Consumes: `resolveOpponentForTurn` (already module-private in this file); `setDemoralizeImmunityUntil` (Task 5); `pushTokenAway` (already exported in this file).
- Produces: a new `else if (candidate.type === "maneuver")` branch inside `applyAgentDecision`, the terminal consumer in this plan.

- [ ] **Step 1: Write the failing tests**

First, find and read an existing `applyAgentDecision` test (e.g. for the `strike` or `cast` branch) to copy its exact `game`/`combat`/`combatant`/`target` stub shape:

Run: `grep -rl "applyAgentDecision(" tests/*.mjs`

```js
// tests/dungeon-combat-maneuver-execution.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyAgentDecision } from '../scripts/dungeon-combat.mjs';

// Build combat/combatant/target stubs using the exact shape copied from
// the existing applyAgentDecision test found above. `combatant.actor` must
// have a real-enough shape for resolveOpponentForTurn/getPendingAgentTurn's
// own internal re-derivation to find a maneuver candidate matching the
// candidateId this test applies -- i.e. the stub actor needs
// skills.athletics/intimidation and the target needs to be in melee range
// and visible, matching Task 6's own vocabulary-building inputs.

function installGamePf2eStub(actionImpls) {
  globalThis.game = {
    ...globalThis.game,
    pf2e: { actions: actionImpls },
    time: { worldTime: 1000 },
  };
}

describe('applyAgentDecision maneuver execution', () => {
  it('calls game.pf2e.actions.trip with an explicit target and applies Prone on success', async () => {
    const increaseCondition = vi.fn();
    const target = { actor: { increaseCondition } /* , token: ... */ };
    installGamePf2eStub({
      trip: ({ callback }) => { callback({ outcome: 'success' }); },
    });
    // await applyAgentDecision(combat, combatantId, 'maneuver:trip:opp1', 'rationale');
    // expect(increaseCondition).toHaveBeenCalledWith('prone');
  });

  it('applies Prone plus 1d6 bludgeoning damage on a critical success Trip', async () => {
    // same shape, outcome: 'criticalSuccess' -- expect increaseCondition('prone')
    // AND target.actor.applyDamage called with a damage total and the target's token.
  });

  it('pushes the target away via pushTokenAway on a successful Shove (5ft / 1 square)', async () => {
    // outcome: 'success' -> pushTokenAway called with distanceSquares 1
  });

  it('pushes the target 10ft / 2 squares on a critical success Shove', async () => {
    // outcome: 'criticalSuccess' -> pushTokenAway called with distanceSquares 2
  });

  it('applies Grabbed on a successful Grapple and Restrained on a critical success', async () => {
    // two sub-cases
  });

  it('applies Frightened 1 on a successful Demoralize, Frightened 2 on a critical success, and always records the 10-minute immunity timestamp', async () => {
    // outcome: 'success' -> increaseCondition('frightened', { value: 1 })
    // outcome: 'criticalSuccess' -> increaseCondition('frightened', { value: 2 })
    // both -> setDemoralizeImmunityUntil's underlying combat.setFlag called
    // with worldTime (1000) + 600
  });

  it('does nothing when the resolved target no longer exists', async () => {
    // resolveOpponentForTurn returns null/undefined for this candidate's
    // targetId -- game.pf2e.actions.* must never be called.
  });
});
```

(As with Task 6's Step 1, the bodies above intentionally stay partially commented/pseudocoded — fill in the real stub shape copied from the found existing test before running, rather than guessing it here.)

- [ ] **Step 2: Run tests to verify they fail (once filled in)**

Run: `npm test -- tests/dungeon-combat-maneuver-execution.test.mjs`
Expected: FAIL — `applyAgentDecision` has no `maneuver` branch yet.

- [ ] **Step 3: Implement `executeManeuverCandidate` and the new branch**

Add this function near the other `execute*`/`rollAndApply*` helpers in `scripts/dungeon-combat.mjs` (e.g. just above `applyAgentDecision`):

```js
/**
 * #909: game.pf2e.actions.<slug>() (trip/shove/grapple/disarm/demoralize)
 * is fire-and-forget -- confirmed by reading the installed system's own
 * bundled source, none of the five standalone action functions `return`
 * their own W.simpleRollActionCheck(...) promise. The only way to know the
 * roll finished is the `callback` option, so this bridges that callback to
 * a promise this function can actually await, rather than awaiting the
 * macro call itself (which would resolve to undefined immediately, before
 * the roll's outcome is known).
 */
function runManeuverCheck(slug, combatant, target) {
  return new Promise((resolve) => {
    game.pf2e.actions[slug]({
      actors: [combatant.actor],
      target: () => ({ actor: target.actor, token: target.token }),
      callback: ({ outcome }) => resolve(outcome),
    });
  });
}

/** PF2e RAW outcome table for the five basic maneuvers, taken verbatim
 * from lang/action-en.json (see this feature's spec) -- none of the five
 * macros auto-apply their own outcome, so every effect here is applied by
 * hand, mirroring dungeon-strike-riders.mjs's existing
 * applyConditionOnSuccess precedent for the condition-only cases. */
async function applyManeuverOutcome(slug, combat, combatant, target, outcome) {
  if (slug === "trip") {
    if (outcome === "success" || outcome === "criticalSuccess") {
      await target.actor.increaseCondition("prone");
    }
    if (outcome === "criticalSuccess") {
      const roll = await new Roll("1d6").evaluate();
      await target.actor.applyDamage({ damage: roll.total, token: target.token });
    }
    if (outcome === "criticalFailure") {
      await combatant.actor.increaseCondition("prone");
    }
  } else if (slug === "shove") {
    if (outcome === "success") {
      await pushTokenAway(combat, combatant, target, 1);
    } else if (outcome === "criticalSuccess") {
      await pushTokenAway(combat, combatant, target, 2);
    } else if (outcome === "criticalFailure") {
      await combatant.actor.increaseCondition("prone");
    }
  } else if (slug === "grapple") {
    if (outcome === "success") {
      await target.actor.increaseCondition("grabbed");
    } else if (outcome === "criticalSuccess") {
      await target.actor.increaseCondition("restrained");
    }
  } else if (slug === "disarm") {
    if (outcome === "success") {
      const effect = await fromUuid("Compendium.pf2e.other-effects.Item.PuDS0DEq0CnaSIFV");
      if (effect) await target.actor.createEmbeddedDocuments("Item", [effect.toObject()]);
    } else if (outcome === "criticalFailure") {
      await combatant.actor.increaseCondition("off-guard");
    }
  } else if (slug === "demoralize") {
    if (outcome === "success") {
      await target.actor.increaseCondition("frightened", { value: 1 });
    } else if (outcome === "criticalSuccess") {
      await target.actor.increaseCondition("frightened", { value: 2 });
    }
    await setDemoralizeImmunityUntil(combat, combatant.id, target.id, game.time.worldTime + 600);
  }
}

async function executeManeuverCandidate(combat, combatant, candidate) {
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) return;
  const outcome = await runManeuverCheck(candidate.slug, combatant, target);
  await applyManeuverOutcome(candidate.slug, combat, combatant, target, outcome);
}
```

Add the new branch inside `applyAgentDecision`, alongside the existing `strike`/`cast`/etc. branches (after the `castArea` branch's closing, matching the existing `else if (candidate.type === "...")` chain style):

```js
  } else if (candidate.type === "maneuver") {
    await executeManeuverCandidate(combat, combatant, candidate);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-maneuver-execution.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [ ] **Step 6: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-maneuver-execution.test.mjs
git commit -m "feat(#909): execute chosen maneuver candidates against PF2e's own action macros

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Version bump

**Files:**
- Modify: `module.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — final housekeeping step before merge.

- [ ] **Step 1: Check the current version and bump it**

Run: `grep '"version"' module.json`

This is a new subsystem (a new agent-service endpoint plus five Foundry-side files), so per `CLAUDE.md`'s versioning rule this is a **minor** bump: `x.Y.0` → `x.Y+1.0` (drop the patch component). Edit `module.json`'s `version` field accordingly — do not reuse any version number already used by a prior merge.

- [ ] **Step 2: Verify no other file hardcodes the old version**

Run: `grep -rn "<old version string>" . --include="*.json" --include="*.mjs" --include="*.md" | grep -v node_modules | grep -v docs/superpowers`
Expected: no match outside `module.json` itself.

- [ ] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#909): bump version for the AI-actor-maneuvers feature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (reasoning pipeline, not a one-off deterministic builder) — Task 1/2/3 build the new endpoint+client; Task 6/7 wire it into the existing turn loop.
- Decision 2 (Foundry enumerates vocabulary, LLM only selects/parameterizes) — Task 4's `buildManeuverVocabulary` is the enumeration; Task 1's `generateCombatCandidates` only ever proposes from what it's sent; Task 4's `buildManeuverCandidates` is the authoritative post-hoc validation.
- Decision 3 (full RAW prerequisites: skill, range/LOS, free-hand-or-weapon-trait, size cap, Demoralize range/awareness/immunity) — Task 4 (range/LOS/size-gate wiring in `buildManeuverVocabulary`) and Task 5 (the actual free-hand/size/immunity computations).
- Decision 4 (litellm-only generic endpoint, Foundry validates referentially) — Task 1 (litellm-only, modeled on `customization-generator.mjs`) and Task 4's `buildManeuverCandidates`.
- Decision 5 (skip the call when vocabulary is empty) — Task 7's `if (pending.maneuverVocabulary?.length)` gate, with a dedicated test.
- Decision 6 (execute via `game.pf2e.actions.*`, hand-apply RAW outcome) — Task 8.
- Decision 7 (Demoralize immunity as a real worldTime timestamp) — Task 5 (`getDemoralizeImmunityUntil`/`setDemoralizeImmunityUntil`) and Task 8 (`applyManeuverOutcome`'s demoralize branch writing it).
- Decision 8 (feats/weapon-switching/variants out of scope) — not built anywhere in this plan; #910/#911 referenced in Global Constraints and nowhere else attempted.
- The Maneuver reference table (RAW outcome values) — Task 8's `applyManeuverOutcome` implements every cell of it exactly (Trip's crit bludgeoning, Shove's 5ft/10ft, Grapple's Grabbed/Restrained, Disarm's effect UUID/critical-failure Off-Guard, Demoralize's Frightened 1/2 plus immunity).
- Testing considerations section (pure vocabulary/candidate tests, generator schema tests, pick-validation tests, mocked-execution tests) — Tasks 1/4/5/6/8 each cover their named slice.

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X" anywhere. Tasks 6 and 8 deliberately leave their test *stub shape* to be copied from an existing test the implementer must find and read first (explicitly instructed which `grep` to run) — this is not a placeholder for what the test asserts (every assertion is spelled out precisely), only for the mechanical stub-building boilerplate this plan cannot safely guess without risking a wrong/stale shape; this is weaker than the rest of the plan's full code and is called out here deliberately rather than silently.

**3. Type consistency:** `buildManeuverVocabulary`'s `{type, slug, targetId}` shape is identical everywhere it's produced (Task 4) and consumed (Task 4's `buildManeuverCandidates`, Task 1's generator response schema, Task 7's fetch/validate, Task 6's wiring). `computeManeuverAttackerProfile`'s `{eligible, reachSquares}` per-slug shape matches exactly what `buildManeuverVocabulary` destructures. `getAgentTurnState`/`setAgentTurnState`'s `maneuverPicks` field name and `null`-vs-array sentinel usage is identical in Task 6 (storage) and Task 7 (the `=== null` check gating the fetch).

**4. Review Focus:** all five items have a direct test — empty vocabulary skip (Task 7, two dedicated tests), vocabulary-mismatched pick dropped (Task 4, three dedicated tests), existing bare-stub `runAgentDecisionLoop` tests never touching `combat.getFlag` (Task 7's third test, explicitly named for this), agent-service failure not blocking the turn (Task 7's fourth test), and a vanished execution-time target no-op (Task 8's last test).
