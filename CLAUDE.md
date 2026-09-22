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
  merge adds, removes, or rewires a `scripts/`/`tools/agent-loop/` file's
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

- Update an issue's progress table/comment in the same turn the state
  actually changes — chunk start, meaningful progress counts, chunk
  completion, a deferred item, a real bug found — not batched up for later.
- Apply the `in progress` label (create it if the repo doesn't have a
  status label yet) while an issue is actively being worked, and remove it
  when paused or done.
- Claiming an issue and labeling it `in progress` are the same action, not
  two steps — apply the label in the same turn you decide to work an
  issue, before doing any other work on it (reading code, planning,
  editing). An unlabeled issue is fair game for another agent to pick up;
  the label is what tells other agents "already claimed, don't duplicate
  this." Check for an existing `in progress` label before starting work on
  any issue, and pick a different one if it's already there.
- A multi-session effort's issue (like ITEM-18, #16) is the resumable
  source of truth for whoever — or whichever agent — picks it up next. A
  stale table misleads them.
