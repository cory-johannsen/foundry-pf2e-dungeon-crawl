# CLAUDE.md

## Versioning

Every merge to `main` must bump the `version` field in `module.json`.
Foundry VTT uses this manifest version for update detection, so an
un-bumped version after a merge means installed copies won't see the
change as an update.  Every agent MUST bump the version.  NEVER reuse a version number.

- Patch bump (`x.y.Z` → `x.y.Z+1`) for routine fixes and small changes.
- Minor bump (`x.Y.0` → `x.Y+1.0`) for larger features or
  architecture-level changes (e.g. `0.1.2` → `0.2.0` for the
  dependency-direction reversal).
- If several commits land in one push, a single catch-up bump covering
  all of them is fine — it doesn't need to be one bump per commit.
- Run the `update-architecture-docs` skill in the same pass whenever a
  merge adds, removes, or rewires a `scripts/`/`tools/agent-service/` file's
  imports — `docs/architecture.md` stays honest only if it's refreshed as
  part of the same merge that changed the shape it describes, not as a
  separate follow-up (#69).

## Pull requests

Always automerge PRs once opened, unless the user has instructed otherwise
(in this session or for that specific PR). Don't wait for a separate
merge approval each time.

## Issue status

A GitHub issue's tracked status must always reflect the true current state
of the work, not just be updated at the end of a session or a chunk.

Issues move through a strict, sequential lifecycle that agents must not
skip or bypass: `assigned` → `spec` → `planned` → `in progress` → done
(issue closed). Each label replaces the previous one — an issue carries
at most one lifecycle label at a time.

- **Every piece of real work needs a claimed issue before it starts** —
  not just feature/bug work that already has one filed. This includes
  operational/infrastructure work (deploying a service, standing up local
  tooling, configuring environment/settings) that doesn't touch code in a
  PR-able way. If no issue exists yet for what you're about to do, create
  one first, then claim it, then start — in that order, same turn. The
  point is collision avoidance between concurrent sessions: an unticketed
  task is invisible to everyone else, so nothing stops two sessions from
  doing the same deployment or touching the same shared infrastructure at
  once.
- Update an issue's progress table/comment in the same turn the state
  actually changes — chunk start, meaningful progress counts, chunk
  completion, a deferred item, a real bug found — not batched up for later.
- Claiming an issue: apply the `assigned` label (create it if the repo
  doesn't have one yet) and post a comment naming the agent's session ID,
  in the same turn you decide to work an issue — before doing any other
  work on it (reading code, planning, editing). Check for an existing
  lifecycle label (`assigned`, `spec`, `planned`, or `in progress`) before
  starting work on any issue, and pick a different one if one is already
  present — an unlabeled issue is fair game for another agent to pick up,
  a labeled one means someone already owns it.
- Apply the `spec` label (create it if the repo doesn't have one yet) the
  same turn an issue's spec is fully written and its path is attached to
  the issue (comment or issue body). Remove `assigned`.
- Apply the `planned` label (create it if the repo doesn't have one yet)
  the same turn an issue's implementation plan is fully written and its
  path is attached to the issue. Remove `spec`.
- Apply the `in progress` label (create it if the repo doesn't have one
  yet) only once an agent is actively implementing the plan — writing or
  editing code, not while still drafting the spec or the plan. Remove
  `planned` when this happens, and remove `in progress` when paused or
  done.
- A multi-session effort's issue (like ITEM-18, #16) is the resumable
  source of truth for whoever — or whichever agent — picks it up next. A
  stale table misleads them.
