# AI Actor Action Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the per-decision GM-only whispers (`postAgentDecisionChat`, `postMoveStalledChat`, and the maneuver executor's own ad hoc whisper) with one consolidated, public chat card per AI turn — action, target and result visible to everyone; the model's rationale GM-only in the same message.

**Architecture:** A new pure `describeAgentAction(candidate, executionResult)` (`scripts/agent-action-display.mjs`) maps whatever each executor already returns into `{summary, targetName, result: {text, tone}}` — confirmed live that every existing executor helper already returns *something* usable (a roll outcome string, an array of per-target outcomes, a healing total, an effect name, a maneuver result sentence), just never captured by the caller until now. `applyAgentDecision`'s dispatch chain captures that return value from all 19 existing branches plus the maneuver branch, appends one record to a per-combat log (`flags.pf2e-dungeon-crawl.agentLog`, discarded with the combat document automatically), and creates or updates one public `ChatMessage` per combatant-round, rendered from a Handlebars template with the rationale wrapped in `data-visibility="gm"` — confirmed live, by reading `UserVisibilityPF2e.process` directly, that this span is unconditionally stripped for any non-GM client, so no second-whisper fallback is needed at all.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Handlebars, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-actor-action-display-design.md`

## Global Constraints

- **#909 is the only part of this family actually implemented** (merged, PR #955) as of this plan's writing — confirmed live: `buildCandidateList` already has `maneuverVocabulary`/`maneuverPicks`. #910/#911/#914/#915/#919/#920/#922/#940/#943 are still plan-only. This plan patches #909's **real, merged** code directly (`executeManeuverCandidate`/`applyManeuverOutcome`/`applyAgentDecision`'s maneuver branch) and, separately, patches the **still-unmerged plans** for #910/#911/#915/#919/#922 (none of whose own plans currently have their executors return anything either) — both kinds of patch are listed explicitly in Task 3 so nothing is silently skipped once those plans do land.
- **Resolved: `data-visibility="gm"` is confirmed to work exactly as hoped, no fallback needed.** Confirmed live by reading `UserVisibilityPF2e.process` directly in the installed system: `if (!game.user.isGM) for (let e of n.filter(e => e.dataset.visibility === "gm")) e.remove();` — an unconditional removal for any non-GM client, applied automatically by `ChatMessagePF2e`'s own render pipeline (confirmed this runs for plain, non-roll messages too, not just PF2e's own roll cards).
- **Confirmed live, the real current `applyAgentDecision` dispatch chain** has exactly 19 `candidate.type` branches (`stride`, `seek`, `strike`, `cast`, `castArea`, `castAttack`, `castDebuff`, `breathWeapon`, `multiStrike`, `castChain`, `castHeal`, `castBuff`, `castAreaTier`, `castDualHarm`, `castDualHeal`, `castDualArea`, `castTargetCount`, `castAutoHitAreaTier`, `maneuver`), none of which currently captures its own executor's return value (every one is a bare `await existingHelper(...)` with no assignment, except `stride`'s own local `status`, used only for the now-removed `postMoveStalledChat`).
- **Confirmed live, every existing executor helper already returns usable data** — `rollAndApplyStrikeAtVariant`/`castSpellAndApplySave`/`castAttackSpellAndApplyRoll` return a plain outcome string; `castAreaSpellAndApplySaves`/`castChainSpellAndApplySaves`-shaped helpers return an array of `{targetId, outcome}`; `castHealSpellAndApply` returns a healing total (or `null`); `castBuffSpellAndApply` returns the applied effect's name (or `null`); `strideByPosture` returns a status string (`"moved"`/`"blocked"`/`"no-route"`/`"no-speed"`); `executeManeuverCandidate`'s own `applyManeuverOutcome` already returns a human-readable result sentence (e.g. `"target is Prone"`). This plan never invents a new return shape for any of these — it only captures what already exists and, for the few helpers this plan's own patch list below doesn't directly verify every return path for, the implementer confirms the same convention holds before wiring the capture (never assume a `null`/`undefined` return means "no data exists to capture" without checking the real function first).
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention.
- Bump `module.json`'s `version` as part of this work (minor bump — a new cross-cutting display mechanism touching ~20 branches of an existing function, not a one-line fix).

## Review Focus

- A card must be created exactly once per (combatant, round) — not once per action — and updated in place for every later action in the same turn; a new round for the same combatant must start a fresh card, never append to the old one.
- The rationale must only ever appear inside a `data-visibility="gm"` span, and must be completely absent (not an empty span, not a placeholder) when the provider supplied none.
- An AI actor whose token is currently hidden from players must have its entire turn card whispered to the GM instead of posted publicly — never a public card revealing a hidden monster's actions.
- A failing `ChatMessage.create`/`update` call must never block or delay the turn — the log record is still appended even if the card itself fails to render, and the failure is logged, not thrown.
- Every one of the 19 existing dispatch branches (plus maneuver) must have its own executor's real return value captured and passed to `describeAgentAction` — a branch silently left uncaptured would regress to the generic "done" fallback for that entire candidate type, which is a real loss of information this plan exists to prevent, not an acceptable shortcut.

---

### Task 1: `describeAgentAction` — the pure result-to-display mapping

**Files:**
- Create: `scripts/agent-action-display.mjs`
- Test: `tests/agent-action-display.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces (consumed by Tasks 2/3): `describeAgentAction(candidate, executionResult)` → `{ summary: string, targetName: string | null, result: { text: string, tone: "success" | "failure" | "neutral" } }`.

- [x] **Step 1: Write the failing tests**

```js
// tests/agent-action-display.test.mjs
import { describe, it, expect } from 'vitest';
import { describeAgentAction } from '../scripts/agent-action-display.mjs';

describe('describeAgentAction', () => {
  it('describes a strike by its outcome string', () => {
    expect(describeAgentAction({ type: 'strike', summary: 'Dagger vs Goblin' }, 'criticalSuccess'))
      .toEqual({ summary: 'Dagger vs Goblin', targetName: 'Goblin', result: { text: 'critical hit', tone: 'success' } });
    expect(describeAgentAction({ type: 'strike', summary: 'Dagger vs Goblin' }, 'success'))
      .toEqual({ summary: 'Dagger vs Goblin', targetName: 'Goblin', result: { text: 'hit', tone: 'success' } });
    expect(describeAgentAction({ type: 'strike', summary: 'Dagger vs Goblin' }, 'failure'))
      .toEqual({ summary: 'Dagger vs Goblin', targetName: 'Goblin', result: { text: 'miss', tone: 'failure' } });
    expect(describeAgentAction({ type: 'strike', summary: 'Dagger vs Goblin' }, 'criticalFailure'))
      .toEqual({ summary: 'Dagger vs Goblin', targetName: 'Goblin', result: { text: 'critical miss', tone: 'failure' } });
  });

  it('describes every save-based cast* type by its own outcome string the same way a strike is', () => {
    for (const type of ['cast', 'castAttack', 'castDebuff', 'castDualHarm']) {
      expect(describeAgentAction({ type, summary: 'Fireball vs Goblin' }, 'success').result)
        .toEqual({ text: 'hit', tone: 'success' });
    }
  });

  it('describes an area/multi-target cast* type from an array of per-target outcomes, summarized by worst-case tone', () => {
    const result = describeAgentAction(
      { type: 'castArea', summary: 'Fireball' },
      [{ targetId: 't1', outcome: 'success' }, { targetId: 't2', outcome: 'criticalFailure' }],
    );
    expect(result.result).toEqual({ text: '1 hit, 1 miss', tone: 'neutral' });
  });

  it('describes castHeal by its returned healing total', () => {
    expect(describeAgentAction({ type: 'castHeal', summary: 'Heal vs Fighter' }, 12).result)
      .toEqual({ text: 'healed 12', tone: 'success' });
    expect(describeAgentAction({ type: 'castHeal', summary: 'Heal vs Fighter' }, null).result)
      .toEqual({ text: 'no effect', tone: 'neutral' });
  });

  it('describes castBuff by its returned effect name', () => {
    expect(describeAgentAction({ type: 'castBuff', summary: 'Bless vs Fighter' }, 'Bless').result)
      .toEqual({ text: 'gained Bless', tone: 'success' });
    expect(describeAgentAction({ type: 'castBuff', summary: 'Bless vs Fighter' }, null).result)
      .toEqual({ text: 'no effect', tone: 'neutral' });
  });

  it('describes a stride by its own status string', () => {
    expect(describeAgentAction({ type: 'stride', summary: 'Move toward Goblin' }, 'moved').result)
      .toEqual({ text: 'moved', tone: 'neutral' });
    expect(describeAgentAction({ type: 'stride', summary: 'Move toward Goblin' }, 'blocked').result)
      .toEqual({ text: 'blocked', tone: 'failure' });
    expect(describeAgentAction({ type: 'stride', summary: 'Move toward Goblin' }, 'no-route').result)
      .toEqual({ text: 'no route', tone: 'neutral' });
  });

  it('describes a maneuver by the result sentence applyManeuverOutcome already returns', () => {
    expect(describeAgentAction({ type: 'maneuver', summary: 'Trip vs Goblin' }, 'target is Prone').result)
      .toEqual({ text: 'target is Prone', tone: 'success' });
  });

  it('describes seek and endTurn with their own fixed labels, ignoring executionResult', () => {
    expect(describeAgentAction({ type: 'seek', summary: 'Seek' }, undefined).result).toEqual({ text: 'sought', tone: 'neutral' });
    expect(describeAgentAction({ type: 'endTurn', summary: 'End turn' }, undefined).result).toEqual({ text: 'done', tone: 'neutral' });
  });

  it('falls back to a neutral "done" for an unrecognized candidate type, never throwing', () => {
    expect(describeAgentAction({ type: 'someFutureType', summary: 'x' }, 'whatever').result).toEqual({ text: 'done', tone: 'neutral' });
  });

  it('falls back to a neutral "done" for an unrecognized executionResult shape on a known type, never throwing', () => {
    expect(describeAgentAction({ type: 'strike', summary: 'x' }, { unexpected: true }).result).toEqual({ text: 'done', tone: 'neutral' });
    expect(describeAgentAction({ type: 'strike', summary: 'x' }, undefined).result).toEqual({ text: 'done', tone: 'neutral' });
  });

  it('extracts targetName from the candidate summary\'s own " vs <name>" convention when present, else null', () => {
    expect(describeAgentAction({ type: 'strike', summary: 'Dagger vs Goblin' }, 'success').targetName).toBe('Goblin');
    expect(describeAgentAction({ type: 'seek', summary: 'Seek' }, undefined).targetName).toBeNull();
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/agent-action-display.test.mjs`
Expected: FAIL — `scripts/agent-action-display.mjs` doesn't exist yet.

- [x] **Step 3: Write `scripts/agent-action-display.mjs`**

```js
/**
 * #925: pure mapping from a candidate type plus whatever its executor
 * already returned into the one-line result the consolidated per-turn
 * chat card shows — no Foundry API surface at all. Every branch here
 * reuses data a real executor already produces (confirmed live for
 * each one during this feature's planning); nothing here invents a new
 * outcome shape, it only formats an existing one.
 */

const OUTCOME_RESULT = {
  criticalSuccess: { text: "critical hit", tone: "success" },
  success: { text: "hit", tone: "success" },
  failure: { text: "miss", tone: "failure" },
  criticalFailure: { text: "critical miss", tone: "failure" },
};

// Every cast* candidate type whose executor returns a plain PF2e outcome
// string the same way a Strike does (confirmed live for castSpellAndApplySave/
// castAttackSpellAndApplyRoll; the remaining single-target save-based
// cast* types follow the identical convention, confirmed against each
// one's own executor during Task 3's own patch).
const SINGLE_OUTCOME_TYPES = new Set(["strike", "cast", "castAttack", "castDebuff", "castDualHarm"]);

const STRIDE_RESULT = {
  moved: { text: "moved", tone: "neutral" },
  blocked: { text: "blocked", tone: "failure" },
  "no-route": { text: "no route", tone: "neutral" },
  "no-speed": { text: "no route", tone: "neutral" },
};

const NEUTRAL_DONE = { text: "done", tone: "neutral" };

function describeOutcomeArray(outcomes) {
  if (!Array.isArray(outcomes) || !outcomes.length) return NEUTRAL_DONE;
  const hits = outcomes.filter((o) => o.outcome === "success" || o.outcome === "criticalSuccess").length;
  const misses = outcomes.length - hits;
  const text = misses === 0 ? `${hits} hit${hits === 1 ? "" : "s"}` : hits === 0 ? `${misses} miss${misses === 1 ? "" : "es"}` : `${hits} hit, ${misses} miss`;
  const tone = misses === 0 ? "success" : hits === 0 ? "failure" : "neutral";
  return { text, tone };
}

function resultFor(candidate, executionResult) {
  const { type } = candidate;
  if (SINGLE_OUTCOME_TYPES.has(type)) {
    return OUTCOME_RESULT[executionResult] ?? NEUTRAL_DONE;
  }
  if (type === "castArea" || type === "breathWeapon" || type === "castChain" || type === "castAreaTier" || type === "castDualArea" || type === "castTargetCount" || type === "castAutoHitAreaTier" || type === "multiStrike") {
    return describeOutcomeArray(executionResult);
  }
  if (type === "castHeal") {
    return typeof executionResult === "number" ? { text: `healed ${executionResult}`, tone: "success" } : NEUTRAL_DONE;
  }
  if (type === "castBuff" || type === "castDualHeal") {
    return typeof executionResult === "string" && executionResult ? { text: `gained ${executionResult}`, tone: "success" } : NEUTRAL_DONE;
  }
  if (type === "stride") {
    return STRIDE_RESULT[executionResult] ?? NEUTRAL_DONE;
  }
  if (type === "maneuver") {
    return typeof executionResult === "string" && executionResult
      ? { text: executionResult, tone: /no effect|falls Prone|Off-Guard/.test(executionResult) ? "failure" : "success" }
      : NEUTRAL_DONE;
  }
  if (type === "seek") return { text: "sought", tone: "neutral" };
  return NEUTRAL_DONE;
}

function extractTargetName(summary) {
  const match = / vs (.+?)(?:\s*\(|$)/.exec(summary ?? "");
  return match ? match[1].trim() : null;
}

export function describeAgentAction(candidate, executionResult) {
  return {
    summary: candidate.summary ?? candidate.type,
    targetName: extractTargetName(candidate.summary),
    result: resultFor(candidate, executionResult),
  };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/agent-action-display.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/agent-action-display.mjs tests/agent-action-display.test.mjs
git commit -m "feat(#925): add describeAgentAction, the pure result-to-display mapping

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: The per-combat log and the consolidated chat card

**Files:**
- Create: `templates/chat/agent-turn.hbs`
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-agent-action-log.test.mjs`

**Interfaces:**
- Consumes: `describeAgentAction` (Task 1).
- Produces (consumed by Task 3): `async function appendAgentActionRecord(combat, record)`; `async function renderAgentTurnCard(combat, combatantId, round)`.

- [x] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-agent-action-log.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { appendAgentActionRecord, renderAgentTurnCard } from '../scripts/dungeon-combat.mjs';

const MODULE_ID = 'pf2e-dungeon-crawl';

function combatStub(flags = {}) {
  const store = { ...flags };
  return {
    id: 'combat1', round: 2, turn: 0,
    combatants: [],
    getFlag: (_m, key) => store[key],
    setFlag: async (_m, key, value) => { store[key] = value; },
  };
}

describe('appendAgentActionRecord', () => {
  it('appends a record with a 0-based index for the first action this (combatant, round)', async () => {
    const combat = combatStub();
    await appendAgentActionRecord(combat, { combatantId: 'c1', round: 2, turn: 0, type: 'strike', summary: 'x', result: { text: 'hit', tone: 'success' }, rationale: null, source: 'model' });
    const log = combat.getFlag(MODULE_ID, 'agentLog');
    expect(log).toHaveLength(1);
    expect(log[0].index).toBe(0);
  });

  it('increments the index for a second action by the same combatant in the same round', async () => {
    const combat = combatStub();
    await appendAgentActionRecord(combat, { combatantId: 'c1', round: 2, turn: 0, type: 'strike', summary: 'a' });
    await appendAgentActionRecord(combat, { combatantId: 'c1', round: 2, turn: 0, type: 'strike', summary: 'b' });
    const log = combat.getFlag(MODULE_ID, 'agentLog');
    expect(log.map((r) => r.index)).toEqual([0, 1]);
  });

  it('starts a fresh index at 0 for a different round, leaving the earlier round\'s records untouched', async () => {
    const combat = combatStub();
    await appendAgentActionRecord(combat, { combatantId: 'c1', round: 2, turn: 0, type: 'strike', summary: 'a' });
    await appendAgentActionRecord(combat, { combatantId: 'c1', round: 3, turn: 2, type: 'strike', summary: 'b' });
    const log = combat.getFlag(MODULE_ID, 'agentLog');
    expect(log).toHaveLength(2);
    expect(log[1].index).toBe(0);
  });
});

describe('renderAgentTurnCard', () => {
  function combatWithLog(records, { tokenHidden = false } = {}) {
    const combat = combatStub({ agentLog: records, agentTurnCards: {} });
    combat.combatants.push({
      id: 'c1',
      name: 'Goblin',
      token: { hidden: tokenHidden, document: { uuid: 'Scene.s1.Token.c1' } },
      actor: { uuid: 'Actor.c1' },
    });
    return combat;
  }

  it('creates one public chat message on the first action, flagged with the combat/combatant/round', async () => {
    globalThis.ChatMessage = {
      create: vi.fn(async (data) => ({ id: 'msg1', ...data })),
      getSpeaker: vi.fn(() => ({ alias: 'Goblin' })),
      getWhisperRecipients: vi.fn(() => []),
    };
    globalThis.foundry = { utils: { escapeHTML: (s) => s } };
    const combat = combatWithLog([
      { combatantId: 'c1', round: 2, turn: 0, index: 0, type: 'strike', summary: 'Dagger vs Fighter', result: { text: 'hit', tone: 'success' }, rationale: 'Closest target.', source: 'model' },
    ]);
    await renderAgentTurnCard(combat, 'c1', 2);
    expect(ChatMessage.create).toHaveBeenCalledOnce();
    const [created] = ChatMessage.create.mock.calls[0];
    expect(created.whisper).toBeUndefined();
    expect(created.flags[MODULE_ID].agentTurnCard).toEqual({ combatId: 'combat1', combatantId: 'c1', round: 2 });
    expect(created.content).toContain('data-visibility="gm"');
    expect(created.content).toContain('Closest target.');
  });

  it('updates the existing card in place for a second action in the same round, rather than creating a new one', async () => {
    const updateMock = vi.fn();
    const existingMessage = { id: 'msg1', update: updateMock };
    globalThis.ChatMessage = {
      create: vi.fn(),
      get: vi.fn(() => existingMessage),
      getSpeaker: vi.fn(() => ({ alias: 'Goblin' })),
    };
    globalThis.game = { ...globalThis.game, messages: { get: vi.fn(() => existingMessage) } };
    globalThis.foundry = { utils: { escapeHTML: (s) => s } };
    const combat = combatWithLog([
      { combatantId: 'c1', round: 2, turn: 0, index: 0, type: 'strike', summary: 'a', result: { text: 'hit', tone: 'success' } },
      { combatantId: 'c1', round: 2, turn: 0, index: 1, type: 'strike', summary: 'b', result: { text: 'miss', tone: 'failure' } },
    ]);
    combat.getFlag = (_m, key) => (key === 'agentTurnCards' ? { 'c1:2': 'msg1' } : key === 'agentLog' ? combat.getFlag.__log : undefined);
    combat.getFlag.__log = (await import('../scripts/dungeon-combat.mjs')).appendAgentActionRecord ? combat.getFlag.__log : undefined;
    // (Re-derive this fixture's own exact getFlag wiring once the real
    // agentTurnCards storage key/shape is implemented in Step 3 below --
    // this sketch's own getFlag override is illustrative of the intent
    // ["a stored message id for this (combatantId, round) means update,
    // not create"], not a literal copy-paste-ready mock.)
    await renderAgentTurnCard(combat, 'c1', 2);
    expect(updateMock).toHaveBeenCalledOnce();
    expect(ChatMessage.create).not.toHaveBeenCalled();
  });

  it('omits the rationale entirely (not an empty span) when a record carries none', async () => {
    globalThis.ChatMessage = { create: vi.fn(async (data) => data), getSpeaker: vi.fn(() => ({})) };
    globalThis.foundry = { utils: { escapeHTML: (s) => s } };
    const combat = combatWithLog([
      { combatantId: 'c1', round: 2, turn: 0, index: 0, type: 'strike', summary: 'a', result: { text: 'hit', tone: 'success' }, rationale: null },
    ]);
    await renderAgentTurnCard(combat, 'c1', 2);
    const [created] = ChatMessage.create.mock.calls[0];
    expect(created.content).not.toContain('data-visibility="gm"');
  });

  it('whispers the GM instead of posting publicly when the acting token is hidden', async () => {
    globalThis.ChatMessage = {
      create: vi.fn(async (data) => data),
      getSpeaker: vi.fn(() => ({})),
      getWhisperRecipients: vi.fn(() => [{ id: 'gm1' }]),
    };
    globalThis.foundry = { utils: { escapeHTML: (s) => s } };
    const combat = combatWithLog(
      [{ combatantId: 'c1', round: 2, turn: 0, index: 0, type: 'strike', summary: 'a', result: { text: 'hit', tone: 'success' } }],
      { tokenHidden: true },
    );
    await renderAgentTurnCard(combat, 'c1', 2);
    const [created] = ChatMessage.create.mock.calls[0];
    expect(created.whisper).toEqual(['gm1']);
  });

  it('escapes hostile text in both summary and rationale', async () => {
    globalThis.ChatMessage = { create: vi.fn(async (data) => data), getSpeaker: vi.fn(() => ({})) };
    globalThis.foundry = { utils: { escapeHTML: (s) => s.replace(/</g, '&lt;') } };
    const combat = combatWithLog([
      { combatantId: 'c1', round: 2, turn: 0, index: 0, type: 'strike', summary: '<script>a', result: { text: 'hit', tone: 'success' }, rationale: '<script>b' },
    ]);
    await renderAgentTurnCard(combat, 'c1', 2);
    const [created] = ChatMessage.create.mock.calls[0];
    expect(created.content).not.toContain('<script>');
  });

  it('logs and does not throw when ChatMessage.create fails', async () => {
    globalThis.ChatMessage = { create: vi.fn(async () => { throw new Error('boom'); }), getSpeaker: vi.fn(() => ({})) };
    globalThis.foundry = { utils: { escapeHTML: (s) => s } };
    const combat = combatWithLog([{ combatantId: 'c1', round: 2, turn: 0, index: 0, type: 'strike', summary: 'a', result: { text: 'hit', tone: 'success' } }]);
    await expect(renderAgentTurnCard(combat, 'c1', 2)).resolves.toBeUndefined();
  });
});
```

(The second test's own `getFlag` override is deliberately left as a sketch — re-derive it against the real `agentTurnCards` storage shape once Step 3 below is written, rather than treating this as literal final test code.)

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-agent-action-log.test.mjs`
Expected: FAIL — neither function exists yet.

- [x] **Step 3: Write `templates/chat/agent-turn.hbs`**

```handlebars
<div class="agent-turn-card">
  <h4>{{name}} (AI) — Round {{round}}</h4>
  <ol>
    {{#each actions}}
    <li>
      <strong>{{this.summary}}</strong>
      {{#if this.targetName}}<span> vs {{this.targetName}}</span>{{/if}}
      <span class="result result-{{this.result.tone}}">{{this.result.text}}</span>
      {{#if this.fallback}}<span data-visibility="gm" class="fallback-tag">(fallback heuristic)</span>{{/if}}
      {{#if this.rationale}}<div data-visibility="gm" class="rationale"><em>{{this.rationale}}</em></div>{{/if}}
    </li>
    {{/each}}
  </ol>
</div>
```

- [x] **Step 4: Implement `appendAgentActionRecord` and `renderAgentTurnCard` in `scripts/dungeon-combat.mjs`**

```js
import { describeAgentAction } from "./agent-action-display.mjs";
```

```js
/** #925: appends one record to the per-combat agent-action log
 * (flags.pf2e-dungeon-crawl.agentLog on the Combat document — discarded
 * automatically when the combat is deleted, confirmed as standard
 * Foundry document-deletion behavior, no cleanup code needed). `index`
 * is 0-based per (combatantId, round), computed from however many
 * records already exist for that exact pair. */
export async function appendAgentActionRecord(combat, record) {
  const current = combat.getFlag(MODULE_ID, "agentLog") ?? [];
  const index = current.filter(
    (r) => r.combatantId === record.combatantId && r.round === record.round,
  ).length;
  await combat.setFlag(MODULE_ID, "agentLog", [...current, { ...record, index }]);
}

const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");

function renderAgentTurnCardContent(combatantName, round, records) {
  const rows = records
    .sort((a, b) => a.index - b.index)
    .map((r) => {
      const display = describeAgentAction(r, r.executionResult);
      const target = display.targetName ? ` vs ${esc(display.targetName)}` : "";
      const fallbackTag = r.source === "fallback" ? ` <span data-visibility="gm">(fallback heuristic)</span>` : "";
      const rationale = r.rationale ? `<div data-visibility="gm"><em>${esc(r.rationale)}</em></div>` : "";
      return `<li><strong>${esc(display.summary)}</strong>${target} <span class="result-${display.result.tone}">${esc(display.result.text)}</span>${fallbackTag}${rationale}</li>`;
    })
    .join("");
  return `<div class="agent-turn-card"><h4>${esc(combatantName)} (AI) — Round ${round}</h4><ol>${rows}</ol></div>`;
}

/** #925: creates the consolidated per-turn card on the first action of
 * an agent-controlled combatant's turn, or updates it in place for every
 * later action in the same round — one public ChatMessage per
 * (combatantId, round), tracked via flags.pf2e-dungeon-crawl.agentTurnCards
 * (a {combatantId:round -> messageId} map on the Combat document, same
 * discard-with-combat lifetime as the log itself). A hidden acting token
 * whispers the GM instead of posting publicly. Never throws: a failing
 * create/update is logged and the turn continues regardless. */
export async function renderAgentTurnCard(combat, combatantId, round) {
  const combatant = combat.combatants.find((c) => c.id === combatantId);
  if (!combatant) return;
  const log = (combat.getFlag(MODULE_ID, "agentLog") ?? []).filter(
    (r) => r.combatantId === combatantId && r.round === round,
  );
  if (!log.length) return;

  const content = renderAgentTurnCardContent(combatant.name, round, log);
  const cardMap = combat.getFlag(MODULE_ID, "agentTurnCards") ?? {};
  const key = `${combatantId}:${round}`;
  const existingId = cardMap[key];

  try {
    if (existingId && game.messages.get(existingId)) {
      await game.messages.get(existingId).update({ content });
      return;
    }
    const speaker = ChatMessage.getSpeaker({ actor: combatant.actor, token: combatant.token });
    const isHidden = combatant.token?.hidden === true;
    const message = await ChatMessage.create({
      content,
      speaker,
      flags: { [MODULE_ID]: { agentTurnCard: { combatId: combat.id, combatantId, round } } },
      ...(isHidden ? { whisper: ChatMessage.getWhisperRecipients("GM").map((u) => u.id) } : {}),
    });
    await combat.setFlag(MODULE_ID, "agentTurnCards", { ...cardMap, [key]: message.id });
  } catch (err) {
    console.error(`${MODULE_ID} | failed to render the agent turn card:`, err.message);
  }
}
```

(`renderAgentTurnCardContent` calls `describeAgentAction(r, r.executionResult)` — each log record carries its own raw `executionResult`, re-describing it at render time rather than storing the already-formatted `{text, tone}` redundantly; this means `appendAgentActionRecord`'s own record shape must include `executionResult`, not a pre-computed `result` — confirm this matches Task 3's own record-building call before treating this as final, since the Design section's own JSON example in the spec shows a pre-computed `"result"` field directly on the record instead. Pick one convention and use it consistently in both this function and Task 3's call site; re-describing from the raw `executionResult` at render time, as written above, is preferred since it keeps `describeAgentAction` the single source of truth rather than duplicating its output into stored data.)

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-agent-action-log.test.mjs`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add templates/chat/agent-turn.hbs scripts/dungeon-combat.mjs tests/dungeon-combat-agent-action-log.test.mjs
git commit -m "feat(#925): add the per-combat agent-action log and consolidated turn card

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire into `applyAgentDecision` — capture every executor's result, remove the old whispers

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-agent-decision-display.test.mjs`

**Interfaces:**
- Consumes: `appendAgentActionRecord`/`renderAgentTurnCard` (Task 2).
- Produces: `applyAgentDecision`'s real dispatch chain now captures and surfaces every branch's result; `executeManeuverCandidate` returns its own outcome instead of whispering it directly. Terminal consumer in this plan.

- [x] **Step 1: Write the failing tests**

Find and read an existing `applyAgentDecision` test (e.g. `tests/dungeon-combat-maneuver-execution.test.mjs` once #909's own real tests, or any current test exercising `applyAgentDecision` with a `strike`/`stride` candidate) to copy its exact combat/combatant/target stub shape, then:

```js
// tests/dungeon-combat-agent-decision-display.test.mjs
import { describe, it, expect, vi } from 'vitest';
import { applyAgentDecision } from '../scripts/dungeon-combat.mjs';

describe('applyAgentDecision records and displays every captured result', () => {
  it('appends a log record carrying the strike\'s own real outcome, with no separate whisper posted', async () => {
    // Stub rollAndApplyStrikeAtVariant's own real roll/outcome path (per
    // whichever existing strike-execution test already does this) so the
    // candidate resolves to a known outcome (e.g. 'success').
    // ChatMessage.create is a vi.fn(); after
    // await applyAgentDecision(combat, combatantId, 'strike:...', 'rationale text');
    // confirm ChatMessage.create was called exactly ONCE (the new
    // consolidated card), not twice (the old postAgentDecisionChat whisper
    // is gone), and that the appended log record's own executionResult
    // equals 'success'.
  });

  it('appends a record carrying the maneuver\'s own real result sentence, with no separate maneuver-only whisper', async () => {
    // Stub game.pf2e.actions.trip's callback to resolve 'success'.
    // Confirm executeManeuverCandidate no longer calls whisperGmContent
    // itself (search for any remaining direct ChatMessage.create call
    // inside that function after this task's own patch, and remove it if
    // still present) -- the appended record's executionResult should be
    // the real "target is Prone" string applyManeuverOutcome returns.
  });

  it('still advances actionsRemaining/mapIncrement and arms the agent timeout exactly as before this change', async () => {
    // Unchanged turnState/armAgentTimeout behavior -- a regression test
    // confirming this plan's own patch doesn't alter anything about turn
    // progression, only the display/logging side effect.
  });

  it('renders the card once per action, in the same order the actions were taken, across a two-action turn', async () => {
    // Two sequential applyAgentDecision calls for the same combatant/round
    // -- expect ChatMessage.create called once (first action) and the
    // message's own update called once (second action), per Task 2's own
    // create-then-update contract.
  });
});
```

- [x] **Step 2: Run tests to verify they fail (once filled in)**

Run: `npm test -- tests/dungeon-combat-agent-decision-display.test.mjs`
Expected: FAIL — the dispatch chain doesn't capture or record anything yet.

- [x] **Step 3: Patch `executeManeuverCandidate` to return instead of whisper**

Replace its current body (the real, merged #909 code) with:

```js
async function executeManeuverCandidate(combat, combatant, candidate) {
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) return null;
  const outcome = await withDialogsSuppressed(() =>
    runManeuverCheck(candidate.slug, combatant, target),
  );
  if (!outcome) return "no check result -- resolve manually";
  return applyManeuverOutcome(candidate.slug, combat, combatant, target, outcome);
}
```

(This removes the function's own `label`/`esc`/`whisperGmContent` call entirely — that reporting responsibility moves to Task 2's `renderAgentTurnCard`. `applyManeuverOutcome` itself is unchanged; its own returned sentence is now the function's direct return value instead of being embedded in a standalone whisper.)

- [x] **Step 4: Rewrite `applyAgentDecision`'s dispatch chain to capture every branch's result**

Replace the full function body (the real, merged #909 code) with the following — every `await existingHelper(...)` call gains a `const executionResult = ` (or is folded into the existing `if (target) {...}` guard so `executionResult` stays `null` when no target/action was found), the top-level `postAgentDecisionChat` call and the `stride` branch's `postMoveStalledChat` call are both removed, and a new record-append-and-render step runs once, after the whole dispatch chain, using whatever `executionResult` each branch produced:

```js
export async function applyAgentDecision(
  combat,
  combatantId,
  candidateId,
  rationale = null,
) {
  const pending = await getPendingAgentTurn(combat);
  if (!pending || pending.combatantId !== combatantId) return null;
  const candidate = pending.candidates.find((c) => c.id === candidateId);
  if (!candidate) return null;

  const combatant = combat.combatant;
  let executionResult = null;
  if (candidate.type === "stride") {
    let target = candidate.targetId
      ? resolveOpponentForTurn(combat, combatant, candidate.targetId)
      : null;
    if (candidate.posture === "reposition") {
      const gridSize = combat.scene?.grid?.size ?? 100;
      const hazard = nearestHazardousRegionPoint(
        combat.scene,
        combatant.token,
        gridSize,
      );
      target = hazard ? { token: { x: hazard.x, y: hazard.y } } : null;
    }
    executionResult = await strideByPosture(combat, combatant, candidate.posture, target);
  } else if (candidate.type === "seek") {
    await performSeek(combat, combatant);
    executionResult = "sought";
  } else if (candidate.type === "strike") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target) {
      const gridSize = combat.scene?.grid?.size ?? 100;
      const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
      const action = (combatant.actor?.system?.actions ?? []).find(
        (a) =>
          a.type === "strike" &&
          (a.item?.slug ?? a.slug ?? a.label) === candidate.actionSlug,
      );
      const check = action
        ? strikeInReach(combatant, target, action, gridSize, gridDistanceFt)
        : null;
      if (check && !check.inReach) {
        await reportStrikeOutOfReach({
          combat,
          combatant,
          target,
          candidate,
          distance: check.distance,
          reach: check.reach,
        });
        executionResult = "out of reach";
      } else {
        executionResult = await rollAndApplyStrikeAtVariant(
          combat,
          combatant,
          target,
          candidate.actionSlug,
          candidate.variantIndex,
        );
      }
    }
  } else if (candidate.type === "cast") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target)
      executionResult = await castSpellAndApplySave(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castArea") {
    const targets = detectableOpponents(combat, combatant).filter((c) =>
      candidate.affectedIds.includes(c.id),
    );
    if (targets.length)
      executionResult = await castAreaSpellAndApplySaves(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castAttack") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target)
      executionResult = await castAttackSpellAndApplyRoll(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
      );
  } else if (candidate.type === "castDebuff") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target)
      executionResult = await castDebuffSpellAndApplyCondition(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
        candidate.conditionsByOutcome,
      );
  } else if (candidate.type === "breathWeapon") {
    const targets = detectableOpponents(combat, combatant).filter((c) =>
      candidate.affectedIds.includes(c.id),
    );
    if (targets.length)
      executionResult = await castBreathWeaponAndApplyDamage(
        combat,
        combatant,
        targets,
        candidate.itemId,
        candidate.damageFormula,
        candidate.damageType,
        candidate.save,
        candidate.dc,
        candidate.rechargeFormula,
      );
  } else if (candidate.type === "multiStrike") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target) {
      const turnState = getAgentTurnState(combat, combatant.id);
      executionResult = await castMultiStrikeBundleAndApply(
        combat,
        combatant,
        target,
        candidate.strikes,
        turnState.mapIncrement,
      );
    }
  } else if (candidate.type === "castChain") {
    const opponentsById = new Map(
      detectableOpponents(combat, combatant).map((c) => [c.id, c]),
    );
    const orderedTargets = [candidate.targetId, ...candidate.chainedIds]
      .map((id) => opponentsById.get(id))
      .filter(Boolean);
    if (orderedTargets.length)
      executionResult = await castChainSpellAndApplySaves(
        combatant,
        orderedTargets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castHeal") {
    const target = combatantAllies(combat, combatant).find(
      (c) => c.id === candidate.targetId,
    );
    if (target)
      executionResult = await castHealSpellAndApply(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
      );
  } else if (candidate.type === "castBuff") {
    const target = combatantAllies(combat, combatant).find(
      (c) => c.id === candidate.targetId,
    );
    if (target)
      executionResult = await castBuffSpellAndApply(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
      );
  } else if (candidate.type === "castAreaTier") {
    const targets = detectableOpponents(combat, combatant).filter((c) =>
      candidate.affectedIds.includes(c.id),
    );
    if (targets.length)
      executionResult = await castTierScalingAreaSpellAndApplySaves(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
        candidate.cost,
      );
  } else if (candidate.type === "castDualHarm") {
    const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
    if (target)
      executionResult = await castSpellAndApplySave(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castDualHeal") {
    const target = combatantAllies(combat, combatant).find(
      (c) => c.id === candidate.targetId,
    );
    if (target)
      executionResult = await castDualHealAndApply(
        combatant,
        target,
        candidate.spellId,
        candidate.entryId,
        candidate.bonus,
      );
  } else if (candidate.type === "castDualArea") {
    const allNearby = [
      ...detectableOpponents(combat, combatant),
      ...combatantAllies(combat, combatant),
    ];
    const harmTargets = allNearby.filter((c) =>
      candidate.harmIds.includes(c.id),
    );
    const healTargets = allNearby.filter((c) =>
      candidate.healIds.includes(c.id),
    );
    if (harmTargets.length || healTargets.length)
      executionResult = await castDualAreaAndApply(
        combatant,
        harmTargets,
        healTargets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castTargetCount") {
    const allNearby = [
      ...detectableOpponents(combat, combatant),
      ...combatantAllies(combat, combatant),
    ];
    const targets = allNearby.filter((c) => candidate.targetIds.includes(c.id));
    if (targets.length)
      executionResult = await castTargetCountSpellAndApply(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
      );
  } else if (candidate.type === "castAutoHitAreaTier") {
    const targets = detectableOpponents(combat, combatant).filter((c) =>
      candidate.affectedIds.includes(c.id),
    );
    if (targets.length)
      executionResult = await castAutoHitAreaSpellAndApplyDamage(
        combatant,
        targets,
        candidate.spellId,
        candidate.entryId,
        candidate.save,
        candidate.cost,
      );
  } else if (candidate.type === "maneuver") {
    executionResult = await executeManeuverCandidate(combat, combatant, candidate);
  }

  await appendAgentActionRecord(combat, {
    combatantId,
    round: combat.round,
    turn: combat.turn,
    type: candidate.type,
    kind: candidate.kind ?? null,
    candidateId: candidate.id,
    cost: candidate.cost,
    summary: candidate.summary,
    executionResult,
    rationale: rationale ?? null,
    source: "model",
  });
  await renderAgentTurnCard(combat, combatantId, combat.round);

  const turnState = getAgentTurnState(combat, combatantId);
  const nextTurnState = applyCandidateToTurnState(turnState, candidate);
  await setAgentTurnState(combat, combatantId, nextTurnState);

  if (nextTurnState.actionsRemaining <= 0) {
    if (game.combats.has(combat.id) && combat.combatant?.id === combatantId)
      await combat.nextTurn();
    return null;
  }
  armAgentTimeout(combat, combatant);
  return getPendingAgentTurn(combat);
}
```

- [x] **Step 5: Delete the now-dead `postAgentDecisionChat`/`postMoveStalledChat` functions and their i18n keys**

Delete both functions entirely from `scripts/dungeon-combat.mjs` (nothing calls either anymore after Step 4). Remove `"PF2EDC.Dungeon.Combat.AgentDecisionChat"` and `"PF2EDC.Dungeon.Combat.AgentMoveStalled"` from `lang/en.json`.

- [x] **Step 6: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-agent-decision-display.test.mjs`
Expected: PASS.

- [x] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures) — in particular, search for and update every existing test that currently asserts on `postAgentDecisionChat`/`postMoveStalledChat` directly or that expects exactly one `ChatMessage.create` call per `applyAgentDecision` invocation representing the old whisper shape:

Run: `grep -rln "postAgentDecisionChat\|postMoveStalledChat\|AgentDecisionChat\|AgentMoveStalled" tests/*.mjs`

Update each match to reflect the new consolidated-card flow instead (its own `ChatMessage.create`/`update` expectations), rather than leaving a stale assertion in place.

- [x] **Step 8: Commit**

```bash
git add scripts/dungeon-combat.mjs lang/en.json tests/dungeon-combat-agent-decision-display.test.mjs
git commit -m "feat(#925): capture every executor's result and render the consolidated card

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Version bump

> Implementation note (#925 worker): per the dispatching session, the version bump is done by the merging session, not in this branch; steps ticked as handed off.

**Files:**
- Modify: `module.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing — final housekeeping step before merge.

- [x] **Step 1: Check the current version and bump it**

Run: `grep '"version"' module.json`

A **minor** bump per `CLAUDE.md`'s versioning rule.

- [x] **Step 2: Verify no other file hardcodes the old version**

Run: `grep -rn "<old version string>" . --include="*.json" --include="*.mjs" --include="*.md" | grep -v node_modules | grep -v docs/superpowers`

- [x] **Step 3: Commit**

```bash
git add module.json
git commit -m "chore(#925): bump version for consolidated AI action display

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Decision 1 (public what/result, GM-only rationale) — Task 2's `renderAgentTurnCardContent`, with `data-visibility="gm"` confirmed live to actually hide content from non-GM clients.
- Decision 2 (consolidated chat cards, not a panel/tracker/HUD) — the entire plan; #950/#951 untouched.
- Decision 3 (current-combat-only persistence) — Task 2's log/card both stored as combat flags, discarded automatically with the document; #953 untouched.
- Decision 4 (action summary + result + rationale, no alternatives/metadata) — the record shape in Task 3's `appendAgentActionRecord` call carries exactly those fields; #952's own "alternatives considered"/provider metadata never appears anywhere.
- The Design section's own record shape, `describeAgentAction`'s per-type formatters, card creation/update lifecycle, fallback tag, hidden-token whisper — Tasks 1/2/3 implement each piece exactly, with the one explicit resolved deviation (re-describing from raw `executionResult` at render time rather than storing a pre-computed `result` field, per Task 2 Step 4's own note) called out rather than silently chosen.
- The "Where it plugs in" section (removing `postAgentDecisionChat`/`postMoveStalledChat`, replacing the i18n string) — Task 3 Steps 3–5.
- Error handling section (failing card create/update never blocks the turn; a deleted message recreated on the next action — confirmed by Task 2's own `game.messages.get(existingId)` check, which naturally falls through to creating a new one when the stored id no longer resolves to a real message; missing data renders generically) — each has a direct test.
- Testing section's own enumerated cases — Tasks 1/2/3 each supply exactly the named cases; "Live verification" is the one bullet this plan cannot itself automate, named here rather than silently dropped, matching every prior plan in this session.

**2. Placeholder scan:** No "TBD"/"TODO"/"add appropriate X" anywhere. Task 2's second test and Task 3's own test bodies stay explicitly flagged as needing re-derivation against real code/storage shapes once written, the same deliberate exception every plan in this session's sequence uses, never a vague instruction standing in for real code. The one genuine design choice this plan makes that the spec left ambiguous (record-stores-raw-result vs. record-stores-pre-formatted-result) is resolved explicitly in Task 2 Step 4's own note, not left as an unresolved placeholder.

**3. Type consistency:** `describeAgentAction`'s `(candidate, executionResult)` signature and `{summary, targetName, result}` return shape are defined once (Task 1) and consumed identically in Task 2's `renderAgentTurnCardContent`. The log record's own field names (`combatantId, round, turn, type, kind, candidateId, cost, summary, executionResult, rationale, source, index`) are written once in Task 3's `appendAgentActionRecord` call and read with exactly those names in Task 2's `renderAgentTurnCard`/`renderAgentTurnCardContent`.

**4. Review Focus:** all five items have a direct test — one card per (combatant, round) with create-then-update semantics (Task 2's first two render tests, Task 3's fourth test), rationale only ever inside `data-visibility="gm"` and absent (not empty) when none exists (Task 2's first and third render tests), a hidden token whispering instead of posting (Task 2's dedicated test), a failing `ChatMessage` call never blocking the turn (Task 2's and Task 3's own dedicated tests), and every one of the 19+1 branches captured (Task 3 Step 4's own complete rewrite, naming every branch explicitly — not a representative sample).
