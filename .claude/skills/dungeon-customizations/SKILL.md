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
2. For each returned entry, compute its identity key: every entry carries
   `sceneId`; a `trap` entry is identified by `(sceneId, actorId)`, and a
   `skill_challenge`, `puzzle`, or `narrative` entry by `(sceneId, roomId)`.
   Use this key to track, within this conversation, which entries you've
   already auto-fulfilled or are already holding open on the billboard —
   never re-process the same key twice in one session.
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
