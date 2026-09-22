# CLAUDE.md

## Versioning

Every merge to `main` must bump the `version` field in `module.json`.
Foundry VTT uses this manifest version for update detection, so an
un-bumped version after a merge means installed copies won't see the
change as an update.

- Patch bump (`x.y.Z` → `x.y.Z+1`) for routine fixes and small changes.
- Minor bump (`x.Y.0` → `x.Y+1.0`) for larger features or
  architecture-level changes (e.g. `0.1.2` → `0.2.0` for the
  dependency-direction reversal).
- If several commits land in one push, a single catch-up bump covering
  all of them is fine — it doesn't need to be one bump per commit.

## Issue status

A GitHub issue's tracked status must always reflect the true current state
of the work, not just be updated at the end of a session or a chunk.

- Update an issue's progress table/comment in the same turn the state
  actually changes — chunk start, meaningful progress counts, chunk
  completion, a deferred item, a real bug found — not batched up for later.
- Apply the `in progress` label (create it if the repo doesn't have a
  status label yet) while an issue is actively being worked, and remove it
  when paused or done.
- A multi-session effort's issue (like ITEM-18, #16) is the resumable
  source of truth for whoever — or whichever agent — picks it up next. A
  stale table misleads them.
