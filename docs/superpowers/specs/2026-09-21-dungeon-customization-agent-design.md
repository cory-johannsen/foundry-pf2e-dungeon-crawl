# Interactive dungeon-customization-fulfillment agent — design

**Tracks:** [#19](https://github.com/cory-johannsen/foundry-pf2e-dungeon-crawl/issues/19)

## Problem

`tools/agent-loop/mcp-server.mjs` already exposes `list_pending_customizations` and the four `submit_*_customization` tools (`tools/agent-loop/README.md:76-127`), but fulfilling a pending trap/skill-challenge/puzzle/narrative customization today requires a human to remember to ask a connected agent session "check for and fulfill any pending dungeon customizations." Every request gets identical treatment — there's no distinction between content the agent can confidently write itself and content that genuinely needs a human's plot knowledge, and nothing surfaces the latter proactively.

## Goal

An agent session connected to `foundry-agent-bridge` that, running continuously for the length of a play session, automatically fulfills whatever customizations it can, surfaces the ones it can't as a running list, and collects the missing information interactively when a human picks one — without reintroducing a hardcoded single-LLM-provider process (the exact coupling `mcp-server.mjs` was built to avoid; see `tools/agent-loop/README.md:82-88`). This is a foundation, not a finished product — it's scoped to one GM, one scene, one connected session at a time.

## Architecture

Three pieces, only one of which is new code:

1. **Existing (unchanged).** `mcp-server.mjs`'s five tools — `list_pending_customizations` and the four `submit_*_customization` tools. All triage and content-generation judgment lives in the connected agent session, calling these exactly as the manual flow does today.
2. **New, minimal (`tools/agent-loop/watch-pending.mjs`).** A dumb detector script: polls the Foundry relay every few seconds for pending-customization state and prints one line whenever a genuinely new entry appears. No LLM calls, no provider config — pure change detection, so it adds no coupling the MCP approach doesn't already have.
3. **New (`.claude/skills/dungeon-customizations/SKILL.md`).** Instructions for the connected agent session: one check pass (list → triage → auto-fulfill → billboard → handle a pending selection). Invoked via `/loop`'s **dynamic mode** (`/loop check for dungeon customizations`, no fixed interval), which arms a `Monitor` on `watch-pending.mjs`'s output as its wake signal instead of polling itself.

```
watch-pending.mjs (new, dumb)              Connected agent session (this /loop)
  poll relay every few seconds               dynamic /loop iteration:
  diff vs last-seen pending state              run dungeon-customizations pass
  new entry? → print one line   ─────────►      Monitor(watch-pending.mjs) armed
                                                 fallback ScheduleWakeup ~20-30min
                                                    │
                                                    ▼ (Monitor event OR fallback fires)
                                              re-run pass, re-arm Monitor
```

Net effect: response time to a new pending customization is bounded by the detector's own poll interval (a few seconds), not by any fixed wakeup cadence — while the only process capable of writing content or making judgment calls is still the human-chosen, human-supervised agent session itself.

## Triage protocol

Each pass calls `list_pending_customizations` for the **current scene only** (no `sceneId` override — matches the tool's own default and how a GM actually plays: one dungeon crawl scene at a time). At most one entry per kind exists today (trap/skill_challenge/puzzle/narrative), so at most four entries per pass.

None of `mcp-server.mjs`'s five tools return a stable `id` — a trap is identified by `actorId`, everything else by `{sceneId, roomId}`. The skill treats `(kind, sceneId, actorId-or-roomId)` as the identity key for tracking state across passes: has this been seen, auto-fulfilled, highlighted, or already asked about.

For each entry not yet resolved, the agent applies this rubric — auto-fulfill by default, flag for a human when:
- A narrative room is `archetype: ally` or `goal` (needs an NPC's identity/hook, or what "the" objective actually is in this campaign — knowledge the agent doesn't have).
- A narrative room is `archetype: choice` where the two options would meaningfully branch later content.
- Any entry whose existing name/summary/`locationTag` reads as an obvious callback to something session-specific (a name, a prior NPC, an in-fiction detail) the agent has no way to know.

Everything else — trap flavor, skill-challenge/puzzle flavor text, narrative `lore` — is auto-fulfilled and submitted immediately via the matching `submit_*_customization` tool.

## Billboard & selection protocol

Chat scrolls, so "always onscreen" means: reprint the current list of unresolved, highlighted entries at the top of the response on every tick or interaction. Format:

```
Open customizations needing you:
1. [narrative/ally] Room "Sunken Shrine" — needs an NPC identity + hook
2. [narrative/goal] Room "The Vault" — needs the actual objective
```

Items auto-fulfilled in that pass are mentioned once, briefly, below the list (e.g. "Also auto-fulfilled: trap on Scene X actor Y") — they don't stay in the running billboard.

**Selection:** the human replies with the item's number. The agent asks specifically for that entry's missing field(s) (e.g. for `ally`: NPC name + hook), and on receiving an answer, submits via the matching `submit_*_customization` tool and drops the item from the billboard. Not responding leaves the item on the billboard for the next tick — no additional re-prompting beyond the list itself.

## Detector script (`tools/agent-loop/watch-pending.mjs`)

- Same env vars as `poll.mjs` (`FOUNDRY_BASE_URL`, `FOUNDRY_REST_API_KEY`), same self-hosted-relay assumption (`tools/agent-loop/README.md:10-20`).
- Loop: query pending-customization state by executing the same relay script `list_pending_customizations` sends via `foundry-rest` (each process calls the relay independently — no shared in-process module between `mcp-server.mjs` and this script), diff against the previous poll's snapshot, print one line per newly-appeared `(kind, sceneId, actorId-or-roomId)` key.
- No escalation logic of its own: a relay hiccup just gets retried on the next tick (each request opens a fresh connection, matching `poll.mjs`'s `Connection: close` resilience — `tools/agent-loop/README.md:67-74`), and there is no "it's been down too long" warning here — the interactive session's own fallback wakeup is the safety net.
- Zero pending state is not an error — it's silence, exactly like an unchanged snapshot.

## Skill & loop invocation (`.claude/skills/dungeon-customizations/SKILL.md`)

- Matches the existing project-skill convention (`.claude/skills/foundry-rest`, `.claude/skills/pf2e-data`).
- Stateless per invocation — running it once, without `/loop`, does exactly the manual flow that exists today (list, triage, fulfill, show billboard), so the on-demand case from the original issue falls out for free.
- Wrapped in `/loop check for dungeon customizations` (dynamic mode) for the standing-loop behavior: run the pass now, arm `Monitor` on `watch-pending.mjs`, set a ~20-30 minute fallback `ScheduleWakeup` in case the Monitor expires (30-minute cap) or misses something, re-arm on every wake per `/loop`'s existing dynamic-mode pattern.

## Alternatives considered

- **Fixed-interval `/loop` (1-minute cron).** Simpler than the Monitor-based design, and still model-agnostic, but the cron backend's floor is 1-minute granularity — too slow for "how quickly does a highlighted item show up." Rejected in favor of the Monitor-based push design above once this floor was identified.
- **A dedicated standalone script, `poll.mjs`-shaped, with its own LLM provider config.** Would get arbitrarily fast polling (like `poll.mjs`'s 3s), but requires the script itself to make judgment/content-generation calls — reintroducing the single-hardcoded-provider coupling `mcp-server.mjs` exists specifically to avoid (`tools/agent-loop/README.md:82-88`). Rejected; the Monitor-based design gets comparable responsiveness without this cost, because the detector script does no judgment at all.
- **A live web dashboard (Artifact) or in-Foundry HUD panel as the billboard surface.** Either would be more literally "always onscreen," but both add a new moving part (a published page + shared state, or new module UI) beyond what a first version needs. Rejected in favor of reprinting the list in chat; either remains a natural "more advanced integration" this item is explicitly meant to be a basis for.

## Non-goals

- Multiple scenes / multiple concurrent dungeon runs in one pass (current-scene-only, per the architecture section).
- Locking or idempotency around concurrent submissions — none exists in `mcp-server.mjs` today (last-submit-wins), and none is added here.
- Any Foundry-module-side changes. All five MCP tools are reused exactly as they exist today.

## Testing

- `watch-pending.mjs`'s diff logic is pure data transformation over two consecutive poll snapshots — real unit tests: emits a line only for a genuinely new `(kind, sceneId, key)`, stays silent on an unchanged or already-seen entry, handles the zero-pending case cleanly.
- The skill's own instructions (triage rubric, billboard format, selection flow) aren't unit-testable prompt logic — validated live against a running world, same precedent as the rest of this bridge (`tests/agent-loop-mcp-server.test.mjs`'s own scope note).
- `tests/agent-loop-mcp-server.test.mjs` needs no changes — none of the five underlying tools change.
