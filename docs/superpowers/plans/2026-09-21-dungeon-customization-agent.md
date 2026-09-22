# Dungeon-customization-fulfillment agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the connected `foundry-agent-bridge` session everything it needs to run as a standing loop that auto-fulfills pending dungeon customizations, highlights the ones needing a human, and collects that input interactively — near-instant response to a new pending item, no hardcoded LLM provider.

**Architecture:** A new dumb detector script (`tools/agent-loop/watch-pending.mjs`) polls the relay every few seconds and prints one line per newly-appeared pending customization; a new project skill (`.claude/skills/dungeon-customizations/SKILL.md`) encodes the triage/billboard/selection instructions and is wrapped in `/loop`'s dynamic mode, which arms a `Monitor` on the detector's output as its wake signal. `tools/agent-loop/mcp-server.mjs`'s five existing tools are unchanged and untouched by this plan.

**Tech Stack:** Node.js (ESM, `.mjs`), Vitest, the existing `foundry-agent-bridge` MCP server, this harness's `/loop` skill + `Monitor` tool.

**Spec:** `docs/superpowers/specs/2026-09-21-dungeon-customization-agent-design.md`

## Global Constraints

- `tools/agent-loop/mcp-server.mjs`'s five tools (`list_pending_customizations`, `submit_trap_customization`, `submit_skill_challenge_customization`, `submit_puzzle_customization`, `submit_narrative_customization`) are not modified. (Spec Architecture, Non-goals.)
- No Foundry-module-side (`scripts/`, `module.json`) changes of any kind. (Spec Non-goals.)
- The detector script (`watch-pending.mjs`) makes zero LLM/provider calls and takes no `ANTHROPIC_API_KEY`/`LAYA_*` config — content judgment lives only in the connected agent session. (Spec Architecture, Alternatives Considered.)
- Current-scene-only scope: no code here ever passes an explicit `sceneId` override to `list_pending_customizations`. (Spec Triage protocol.)
- No locking/idempotency is added around submissions — last-submit-wins is accepted as-is. (Spec Non-goals.)
- `watch-pending.mjs` reuses the same environment variables as `poll.mjs` (`FOUNDRY_BASE_URL`, `FOUNDRY_REST_API_KEY`, optional `FOUNDRY_CLIENT_ID`) via the existing `readEnvOrDotenv` helper in `tools/agent-loop/foundry-client.mjs` — no new env-loading mechanism.

---

### Task 1: Detector script — `tools/agent-loop/watch-pending.mjs`

**Files:**
- Create: `tools/agent-loop/watch-pending.mjs`
- Modify: `package.json` (add an `agent-loop-watch` script, alongside the existing `agent-loop`/`agent-bridge-mcp` scripts)
- Test: `tests/agent-loop-watch-pending.test.mjs`

**Interfaces:**
- Consumes: `listPendingCustomizations(sceneId, opts)` from `tools/agent-loop/mcp-server.mjs` (already exported, returns `Promise<Array<{kind: "trap"|"skill_challenge"|"puzzle"|"narrative", sceneId?, actorId?, roomId?, name?, ...}>>` — trap entries have no `sceneId` field, per the existing fixtures in `tests/agent-loop-mcp-server.test.mjs`; the other three kinds do). `readEnvOrDotenv(name)` from `tools/agent-loop/foundry-client.mjs`.
- Produces: `keyForPending(entry)` → `string`, the identity key for one pending entry (`trap:<actorId>` for a trap; `<kind>:<sceneId>:<roomId>` for the other three kinds). `diffPending(previousKeys, currentEntries)` → `{ newEntries: Array<Entry>, currentKeys: Set<string> }`, a pure function over one poll's snapshot. Both are imported directly by this task's tests; no other task depends on them (the skill in Task 2 only depends on `watch-pending.mjs`'s **stdout line format**, described in Task 2, not on these functions).

Reusing `listPendingCustomizations` directly (rather than re-issuing an equivalent relay script by hand) is a small, deliberate refinement of the spec's Detector-script section: the spec's intent — this script and `mcp-server.mjs` don't share *runtime state* or a *running process* — holds regardless, since they're always two separate `node` invocations; importing the same already-exported, side-effect-free function is the DRY choice and avoids maintaining two copies of the same relay-script string.

- [ ] **Step 1: Write the failing tests for `keyForPending` and `diffPending`**

Create `tests/agent-loop-watch-pending.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { keyForPending, diffPending } from "../tools/agent-loop/watch-pending.mjs";

const trapEntry = { kind: "trap", actorId: "trap1", name: "Scythe Blades" };
const narrativeEntry = {
  kind: "narrative",
  sceneId: "scene-1",
  roomId: "room-1",
  archetype: "lore",
  name: "The Last Warden's Oath",
};

describe("keyForPending", () => {
  it("keys a trap entry by actorId alone (trap entries carry no sceneId)", () => {
    expect(keyForPending(trapEntry)).toBe("trap:trap1");
  });

  it("keys a non-trap entry by kind, sceneId, and roomId", () => {
    expect(keyForPending(narrativeEntry)).toBe(
      "narrative:scene-1:room-1",
    );
  });
});

describe("diffPending", () => {
  it("reports every entry as new when nothing was previously seen", () => {
    const { newEntries, currentKeys } = diffPending(
      new Set(),
      [trapEntry, narrativeEntry],
    );
    expect(newEntries).toEqual([trapEntry, narrativeEntry]);
    expect(currentKeys).toEqual(new Set(["trap:trap1", "narrative:scene-1:room-1"]));
  });

  it("does not re-report an entry already in the previous key set", () => {
    const previousKeys = new Set(["trap:trap1"]);
    const { newEntries, currentKeys } = diffPending(previousKeys, [trapEntry]);
    expect(newEntries).toEqual([]);
    expect(currentKeys).toEqual(new Set(["trap:trap1"]));
  });

  it("reports only the genuinely new entry when one of two was already seen", () => {
    const previousKeys = new Set(["trap:trap1"]);
    const { newEntries, currentKeys } = diffPending(previousKeys, [
      trapEntry,
      narrativeEntry,
    ]);
    expect(newEntries).toEqual([narrativeEntry]);
    expect(currentKeys).toEqual(
      new Set(["trap:trap1", "narrative:scene-1:room-1"]),
    );
  });

  it("treats zero pending entries as an empty, non-error result", () => {
    const { newEntries, currentKeys } = diffPending(new Set(["trap:trap1"]), []);
    expect(newEntries).toEqual([]);
    expect(currentKeys).toEqual(new Set());
  });

  it("re-flags an entry as new if it resolves (disappears from a poll) and then reappears with the same key", () => {
    // Poll 1: entry present.
    const poll1 = diffPending(new Set(), [narrativeEntry]);
    expect(poll1.newEntries).toEqual([narrativeEntry]);
    // Poll 2: entry resolved — no longer returned by list_pending_customizations.
    const poll2 = diffPending(poll1.currentKeys, []);
    expect(poll2.currentKeys).toEqual(new Set());
    // Poll 3: the same room generates a fresh pending request later — reported
    // as new again, since poll 2's (now empty) key set no longer contains it.
    const poll3 = diffPending(poll2.currentKeys, [narrativeEntry]);
    expect(poll3.newEntries).toEqual([narrativeEntry]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/agent-loop-watch-pending.test.mjs`
Expected: FAIL — `tools/agent-loop/watch-pending.mjs` does not exist (module not found).

- [ ] **Step 3: Write `tools/agent-loop/watch-pending.mjs`**

```js
#!/usr/bin/env node
/**
 * Dumb detector for #19: polls the Foundry relay for pending flavor-
 * customization requests and prints one line per newly-appeared entry.
 * Makes no judgment about content and holds no LLM/provider config at all —
 * it exists only to give an interactive agent session (via this harness's
 * Monitor tool) a fast wake signal, without reintroducing the
 * hardcoded-single-provider coupling `mcp-server.mjs` was built to avoid
 * (see tools/agent-loop/README.md's "Flavor customization... via MCP"
 * section). All triage and content generation still happens only in that
 * connected session, via mcp-server.mjs's five tools.
 *
 * Run: node tools/agent-loop/watch-pending.mjs
 * Requires: FOUNDRY_BASE_URL, FOUNDRY_REST_API_KEY (same as poll.mjs).
 * Optional: DOMMT_WATCH_INTERVAL_MS (default 5000).
 */
import { readEnvOrDotenv } from "./foundry-client.mjs";
import { listPendingCustomizations } from "./mcp-server.mjs";

const WATCH_INTERVAL_MS = Number(
  readEnvOrDotenv("DOMMT_WATCH_INTERVAL_MS") ?? 5000,
);

/** Identity key for one pending entry across polls. Trap entries carry no
 * sceneId (see tests/agent-loop-mcp-server.test.mjs's trap fixtures), so a
 * trap is identified by actorId alone; the other three kinds are scene- and
 * room-scoped. */
export function keyForPending(entry) {
  return entry.kind === "trap"
    ? `trap:${entry.actorId}`
    : `${entry.kind}:${entry.sceneId}:${entry.roomId}`;
}

/** Pure diff over one poll's snapshot against the previous poll's key set. */
export function diffPending(previousKeys, currentEntries) {
  const currentKeys = new Set(currentEntries.map(keyForPending));
  const newEntries = currentEntries.filter(
    (entry) => !previousKeys.has(keyForPending(entry)),
  );
  return { newEntries, currentKeys };
}

function describePending(entry) {
  const id = entry.kind === "trap" ? entry.actorId : entry.roomId;
  return `pending: ${entry.kind} id=${id} name=${JSON.stringify(entry.name ?? null)}`;
}

async function main() {
  console.error(
    `watch-pending: polling every ${WATCH_INTERVAL_MS}ms for new pending customizations`,
  );
  let previousKeys = new Set();
  for (;;) {
    try {
      const current = await listPendingCustomizations();
      const { newEntries, currentKeys } = diffPending(previousKeys, current);
      for (const entry of newEntries) {
        console.log(describePending(entry));
      }
      previousKeys = currentKeys;
    } catch (err) {
      // No escalation logic here by design (spec's Detector-script section)
      // — the connected session's own fallback wakeup is the safety net.
      console.error("watch-pending: poll failed, will retry:", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/agent-loop-watch-pending.test.mjs`
Expected: PASS — 7 tests (2 for `keyForPending`, 5 for `diffPending`).

- [ ] **Step 5: Add the `agent-loop-watch` npm script**

In `package.json`, in the `"scripts"` object, add (alongside the existing `"agent-loop"` and `"agent-bridge-mcp"` entries):

```json
"agent-loop-watch": "node tools/agent-loop/watch-pending.mjs",
```

- [ ] **Step 6: Run the full test suite to confirm nothing else broke**

Run: `npm test`
Expected: all existing suites still pass, plus the 6 new tests (total count increases by 6 from the pre-task baseline).

- [ ] **Step 7: Commit**

```bash
git add tools/agent-loop/watch-pending.mjs tests/agent-loop-watch-pending.test.mjs package.json
git commit -m "$(cat <<'EOF'
Add pending-customization detector script for the agent bridge loop

A dumb, provider-free poller that prints one line per newly-appeared
pending customization, giving a connected agent session a fast Monitor
wake signal instead of a fixed cron cadence (#19).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Skill instructions — `.claude/skills/dungeon-customizations/SKILL.md`

**Files:**
- Create: `.claude/skills/dungeon-customizations/SKILL.md`
- Modify: `tools/agent-loop/README.md` (append an invocation section, following the existing "Flavor customization... via MCP (#185)" section's style)

**Interfaces:**
- Consumes: the five `foundry-agent-bridge` MCP tools (unchanged, from Task-1's-sibling existing file `tools/agent-loop/mcp-server.mjs`) by name and parameter shape, exactly as documented in `tools/agent-loop/README.md`'s existing "Flavor customization" section. Also consumes `watch-pending.mjs`'s stdout line format from Task 1 (`pending: <kind> id=<id> name=<json-string-or-null>`) as the string a `Monitor` command filters on — the skill does not need to parse this line's fields (the actual pending-item data always comes fresh from a `list_pending_customizations` call, never from the detector's line), it only needs the line to exist as a wake trigger.
- Produces: nothing consumed by another task — this is the last task in this plan.

This task has no unit test: it is a markdown instructions file for the connected agent session, not executable code. The spec's own Testing section is explicit that this is validated live against a running world, not automated. Verification here is a manual checklist re-read against the spec (Step 2 below), not a fabricated test.

- [ ] **Step 1: Write `.claude/skills/dungeon-customizations/SKILL.md`**

```markdown
---
name: dungeon-customizations
description: Use when connected to the foundry-agent-bridge MCP server and asked to check, fulfill, or run a standing loop for pending dungeon customizations (trap, skill-challenge, puzzle, or narrative-room flavor text). Covers the triage rubric for auto-fulfilling vs. flagging for a human, the billboard format for open items, and wiring a fast standing loop via /loop's dynamic mode and the watch-pending detector.
---

# Dungeon customization fulfillment

One invocation of this skill is one check pass: list pending customizations
for the current scene, triage each, auto-fulfill what you can, and show a
billboard of what's left. Running it once, without `/loop`, is the complete
on-demand flow — nothing below requires the standing loop.

## One check pass

1. Call `list_pending_customizations` with no `sceneId` (defaults to the
   GM's currently-viewed scene — never pass an explicit `sceneId`).
2. For each returned entry, compute its identity key: a `trap` entry is
   identified by its `actorId` alone (trap entries carry no `sceneId`
   field); a `skill_challenge`, `puzzle`, or `narrative` entry is
   identified by `(sceneId, roomId)`. Use this key to track, within this
   conversation, which entries you've already auto-fulfilled or are
   already holding open on the billboard — never re-process the same key
   twice in one session.
3. Apply the triage rubric (below) to each not-yet-processed entry.
4. Auto-fulfill entries the rubric clears: write fitting name/
   description/summary/flavor content matching the entry's own mechanical
   fields (level, specialty skills, stage skill/DC, archetype) — never
   invent or change a mechanical value, only flavor text — and submit
   immediately via the matching tool (`submit_trap_customization`,
   `submit_skill_challenge_customization`, `submit_puzzle_customization`,
   or `submit_narrative_customization`).
5. Show the billboard (below) of everything still open, and handle a
   selection if the human's message is a number matching a billboard row
   from your immediately preceding turn.

## Triage rubric

Auto-fulfill by default. Flag an entry for a human instead when:

- It's a `narrative` entry with `archetype: "ally"` or `"goal"` — these
  need an NPC's identity/hook, or what "the" objective actually is in
  this campaign, which you have no way to know.
- It's a `narrative` entry with `archetype: "choice"` where the two
  options would meaningfully branch later content (not just cosmetic
  flavor either way).
- Its existing `name`/`summary`/`locationTag` reads as an obvious
  callback to something session-specific (a name, a prior NPC, an
  in-fiction detail) that you have no way to know.

Everything else — trap flavor, skill-challenge/puzzle flavor text, and
narrative `lore` entries — gets auto-fulfilled.

## Billboard format

Reprint the full list of currently-open (flagged, unresolved) entries at
the top of your response, every time you run a pass or the human
interacts with you:

```
Open customizations needing you:
1. [narrative/ally] Room "Sunken Shrine" — needs an NPC identity + hook
2. [narrative/goal] Room "The Vault" — needs the actual objective
```

If nothing is open, say so briefly instead of printing an empty list.
Mention anything auto-fulfilled in *this* pass once, briefly, below the
list (e.g. "Also auto-fulfilled: trap actorId=trap1") — auto-fulfilled
entries never appear in the billboard itself.

## Selection

When the human replies with a number matching a billboard row from your
immediately preceding turn, ask specifically for that entry's missing
field(s):

- `ally` → the NPC's name and hook
- `goal` → the actual suggested objective
- `choice` → the two `{label, consequence}` options
- anything else you flagged for a session-specific callback → whatever
  detail is missing, in your own words

Once the human answers, submit via the matching `submit_*_customization`
tool (always including that entry's required `name`/`summary` fields —
reuse the pending entry's own existing name/summary unless the human's
answer implies new ones) and drop it from the billboard. If the human
doesn't respond, leave the entry on the billboard for the next pass —
don't re-ask beyond what's already shown there.

## Standing loop (optional)

For continuous, near-real-time checking during a play session rather than
one-off invocations, start:

```
/loop check for dungeon customizations
```

This runs in `/loop`'s dynamic (self-pacing) mode: run a pass now, then
arm a `Monitor` on `node tools/agent-loop/watch-pending.mjs`'s output
(each stdout line means a new pending customization appeared) as the wake
signal, with a ~20-30 minute fallback wakeup underneath in case the
Monitor expires (its cap is 30 minutes) or something is missed. On every
wake — whether from the Monitor or the fallback — re-run a full check
pass (Step "One check pass" above) and re-arm. `watch-pending.mjs` needs
the same `FOUNDRY_BASE_URL`/`FOUNDRY_REST_API_KEY` as the rest of this
bridge; it makes no LLM calls of its own.
```

- [ ] **Step 2: Verify against the spec, item by item**

Re-read the new `SKILL.md` against `docs/superpowers/specs/2026-09-21-dungeon-customization-agent-design.md` and confirm each of the following is present and matches:

- [ ] Triage protocol's three flagging conditions (ally/goal, choice, session-specific callback) appear verbatim in intent.
- [ ] The identity-key rule (trap by `actorId` alone; others by `sceneId`+`roomId`) matches Task 1's `keyForPending` exactly.
- [ ] The billboard's numbered format and "auto-fulfilled items don't stay on the billboard" rule match the spec's Billboard & selection protocol.
- [ ] The selection flow (ask for missing fields, submit, drop from billboard, no re-prompt beyond the list) matches the spec.
- [ ] The standing-loop section names the exact `/loop` invocation, the Monitor target (`watch-pending.mjs`), and the ~20-30 minute fallback, matching the spec's Skill & loop invocation section.
- [ ] Nowhere does the skill instruct passing an explicit `sceneId` to `list_pending_customizations` (current-scene-only, per Global Constraints).

Fix any mismatch found directly in the file before continuing.

- [ ] **Step 3: Append an invocation section to `tools/agent-loop/README.md`**

Add a new section after the existing "Flavor customization: trap (#136), skill-challenge (#166), puzzle (#139), and narrative (#167) content, via MCP (#185)" section (matching its heading style):

```markdown
## Standing customization loop (#19)

`.claude/skills/dungeon-customizations` wraps the manual "check for and
fulfill any pending dungeon customizations" flow above into a repeatable
skill, and documents how to run it continuously: `/loop check for dungeon
customizations`. This arms a `Monitor` on `tools/agent-loop/watch-pending.mjs`
(`npm run agent-loop-watch` also runs it standalone), a dumb poller with no
LLM/provider config of its own that prints one line whenever a new pending
customization appears — giving the connected session a fast wake signal
without a fixed cron cadence, and without reintroducing the
hardcoded-provider coupling this MCP approach exists to avoid. See
`docs/superpowers/specs/2026-09-21-dungeon-customization-agent-design.md`
for the full design.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/dungeon-customizations/SKILL.md tools/agent-loop/README.md
git commit -m "$(cat <<'EOF'
Add dungeon-customizations skill and standing-loop invocation docs

Encodes the triage rubric, billboard format, and selection flow from
the #19 design spec, and documents wiring it into /loop's dynamic mode
via the new watch-pending detector.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
