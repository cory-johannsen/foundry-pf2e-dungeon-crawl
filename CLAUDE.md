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

## Generated creature-art compendium pack

`packs/generated-creature-art/` (the compiled LevelDB pack plus its
`_source/*.json`) is a derived artifact of `data/creature-art.json`. Never
hand-edit it. Regenerate it with `npm run packs:build` (needs a local pf2e
install; see `PF2E_SYSTEM_PACKS_DIR` in the README) and commit the result
when an art batch/series finishes or before a minor version bump -- NOT on
every PR that touches `data/creature-art.json`: the `_source/*.json` files
are unchanged across rebuilds (git dedupes them) but the compiled LevelDB
file is rewritten completely, so each rebuild adds about 61 MB of new
binary blobs to git history. Run
`npm run packs:check` (offline, add `-- --strict` to exit 1 when stale) to
see how far the pack lags `data/creature-art.json`.

## Pull requests

Always automerge PRs once opened, unless the user has instructed otherwise
(in this session or for that specific PR). Don't wait for a separate
merge approval each time.

## Issue status

A GitHub issue's tracked status must always reflect the true current state
of the work, not just be updated at the end of a session or a chunk.

Ownership and state are tracked by two kinds of label:

- `claimed` — an agent owns this ticket. It applies across *any* ticket
  state and stays on for as long as the agent owns the issue. It replaces
  the old "Claimed by session …" comment; no claim comment is needed.
- A lifecycle label saying what the owner is doing. Issues move through a
  strict, sequential lifecycle that agents must not skip or bypass:
  `in spec` → `spec` → `in planning` → `planned` → `in progress` → done
  (issue closed). Each lifecycle label replaces the previous one — an
  issue carries at most one lifecycle label at a time (plus `claimed`).

`claimed` + the lifecycle label together define who owns a ticket and what
they're doing. `in progress` is reserved for an agent actively
implementing; never use it just to mean "someone has this".

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
- Claiming an issue: apply the `claimed` label (create it if the repo
  doesn't have one yet) in the same turn you decide to work an issue —
  before doing any other work on it (reading code, planning, editing).
  Check for an existing `claimed` label before starting work on any issue,
  and pick a different one if it is present — an unclaimed issue is fair
  game for another agent to pick up, a `claimed` one means someone already
  owns it. Remove `claimed` when you stop owning the issue (handed off,
  abandoned, or closed).
- Apply `in spec` (create it if missing) when you start writing the spec.
  Apply the `spec` label (create it if missing) the same turn the spec is
  fully written and its path is attached to the issue (comment or issue
  body). Remove `in spec`.
- Apply `in planning` (create it if missing) when you start writing the
  implementation plan. Remove `spec`.
- Apply the `planned` label (create it if the repo doesn't have one yet)
  the same turn an issue's implementation plan is fully written and its
  path is attached to the issue. Remove `in planning`.
- Apply the `in progress` label (create it if the repo doesn't have one
  yet) only once an agent is actively implementing the plan — writing or
  editing code, not while still drafting the spec or the plan. Remove
  `planned` when this happens, and remove `in progress` when paused or
  done.
- A multi-session effort's issue (like ITEM-18, #16) is the resumable
  source of truth for whoever — or whichever agent — picks it up next. A
  stale table misleads them.
