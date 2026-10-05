# Trap Detection RAW Decision Documentation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve #755 — confirm current trap-detection behavior against PF2e's real Exploration rules and document the result. No functional code change: research (done) found a real RAW gap that this module deliberately accepts rather than fixes, and that decision needs a durable, explicit record rather than living only in this session's own investigation.

**Architecture:** Not applicable — this plan adds documentation only, to the two functions where the decision is load-bearing (`rollTrapDetection`, `handleTrapTokenMove` in `scripts/trap-combat.mjs`). No new subsystem, no behavior change, no new tests (nothing observable changes).

**Tech Stack:** N/A (doc comments only).

**Spec:** None — a documentation-only resolution with a single, already-user-approved decision; no design surface for a spec to cover.

## Global Constraints

- Every merge to `main` bumps `module.json`'s `version` (CLAUDE.md). This is a doc-only change: patch bump. Re-check the current version immediately before committing, since concurrent sessions push to this repo.
- No code behavior changes anywhere in this plan — `rollTrapDetection`/`handleTrapTokenMove`'s actual logic is untouched, only their doc comments.

## Review Focus

- **The documentation must state the real RAW rule, not a vague gesture at "simplified for gameplay"** — a future reader (including a future agent working #794) needs the actual mechanism (Search exploration activity gates passive hazard detection) to know what #794 would need to change.
- **The documentation must name why this module accepts the gap today** (no per-character exploration-activity system exists anywhere in this module, confirmed via #616's own temporary one-off workaround) rather than leaving it to look like an oversight nobody examined.
- **The documentation must point to #794** (the filed follow-up) so a future reader knows this was a deliberate, tracked deferral, not a dead end.

---

### Task 1: Document the RAW decision in `trap-combat.mjs`

**Files:**
- Modify: `scripts/trap-combat.mjs` (doc comments on `rollTrapDetection` and `handleTrapTokenMove` only)

**Interfaces:** None — no function signature, behavior, or test changes.

No test: this task changes comments only; `npx vitest run` is a pass-through regression check (Step 2), not new coverage.

- [ ] **Step 1: Update `rollTrapDetection`'s doc comment**

Change (currently, lines 68-74):

```js
/**
 * Rolls Perception for `seeker` against `hazardActor`'s own detection DC
 * (its Stealth value converted the standard way). Returns
 * `{detected, dc, outcome}` — confirmed live: `actor.perception.roll(...)`
 * is a real, callable PF2e API, same shape as every other check/save roll
 * already used elsewhere in this module.
 */
```

to:

```js
/**
 * Rolls Perception for `seeker` against `hazardActor`'s own detection DC
 * (its Stealth value converted the standard way). Returns
 * `{detected, dc, outcome}` — confirmed live: `actor.perception.roll(...)`
 * is a real, callable PF2e API, same shape as every other check/save roll
 * already used elsewhere in this module.
 *
 * #755: PF2e's actual rule (confirmed via Archives of Nethys, not assumed)
 * ties a passive check against a hidden hazard's DC to a character
 * specifically using the **Search** exploration activity that turn — one
 * of roughly 15 competing activities (Avoid Notice, Scout, Hustle, ...) a
 * PC picks between, not something every character gets automatically.
 * This module has no general per-character exploration-activity system
 * anywhere to read that choice from (confirmed: #616's own surprise-round
 * feature needed a *temporary*, one-off Avoid Notice grant for exactly
 * this reason, not a real persistent system) — this function instead
 * rolls for whichever party member's token moved, unconditionally.
 * That's strictly more generous than RAW (a non-Searching character
 * should get no check, or a worse one), but it's a deliberate,
 * user-approved simplification consistent with this module's broader
 * "no activity-tracking" design, not an unexamined gap. #794 tracks
 * building a real exploration-activity system, which both this function
 * and #616's own workaround would switch to if it ever lands.
 */
```

- [ ] **Step 2: Update `handleTrapTokenMove`'s doc comment**

Change (currently, lines 182-187):

```js
/** Hook target for `updateToken` (module.mjs, #753). Acts only on a GM
 * client and only for party tokens. Checks every not-yet-triggered trap
 * hazard on the token's scene against the mover's new footprint: overlap
 * triggers it (a disabled trap is marked triggered but doesn't attack),
 * adjacency detects it. The hazard token unhides the moment it's either
 * detected or triggered. `deps` is injectable for tests. */
```

to:

```js
/** Hook target for `updateToken` (module.mjs, #753). Acts only on a GM
 * client and only for party tokens. Checks every not-yet-triggered trap
 * hazard on the token's scene against the mover's new footprint: overlap
 * triggers it (a disabled trap is marked triggered but doesn't attack),
 * adjacency detects it. The hazard token unhides the moment it's either
 * detected or triggered. `deps` is injectable for tests.
 *
 * #755: this rolls a detection check for whichever party member's token
 * moved, not specifically a character using PF2e's Search exploration
 * activity (see `rollTrapDetection`'s own doc comment for the full RAW
 * research and why this module accepts the gap; #794 tracks the real
 * fix). */
```

- [ ] **Step 3: Run the full test suite to confirm no regression**

Run: `npx vitest run`
Expected: PASS — comment-only change, no behavior affected.

- [ ] **Step 4: Bump module.json's version**

Re-check the current version first (concurrent sessions push to this repo):

```bash
git fetch origin main -q && git log origin/main -1 --oneline && grep version module.json
```

Apply a **patch** bump (documentation only), using whatever the fetch above shows as current.

- [ ] **Step 5: Commit**

```bash
git add scripts/trap-combat.mjs module.json
git commit -m "docs(#755): document the RAW gap in automated trap detection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Scope coverage:** #755's own ask ("verify against RAW, decide whether the model needs to change, document the decision") is fully covered: the RAW research is done (Archives of Nethys, cited), the decision is made (user-approved: confirm current behavior, file a follow-up rather than redesign), and Task 1 is exactly that documentation. The follow-up half of the user's own decision (file a tracking ticket) was done directly in this session, not deferred to the plan: **#794**, filed 2026-10-05.

**2. Placeholder scan:** No TBD/TODO. The doc comments are the complete real text, not a description of what to write.

**3. Type consistency:** N/A — no functions, signatures, or types are added or changed.

**4. Review Focus:** All three items (state the real rule, name why the gap is accepted, point to the tracked follow-up) are present verbatim in Task 1's doc-comment text. No gaps found.

---

Plan complete and saved to `docs/superpowers/plans/2026-10-05-trap-detection-raw-documentation.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **Native**, because this is a single, already-written doc-comment edit with zero behavior change and nothing for independent review to meaningfully catch beyond a read-through. Does the plan capture what you want, and which approach should we use?
