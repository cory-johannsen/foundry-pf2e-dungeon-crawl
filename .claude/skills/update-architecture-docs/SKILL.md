---
name: update-architecture-docs
description: Use as part of the per-merge checklist alongside the module.json version bump (#69) — regenerates docs/architecture.md's dependency diagram from the current scripts/ import graph and checks whether the subsystem prose still describes reality. Run before merging any PR that adds, removes, or rewires a scripts/ or tools/agent-loop/ file's imports.
---

# Update architecture docs

`docs/architecture.md` is a living view of how `scripts/`'s ~40 files
relate to each other — see #69. It stays honest only if this runs as part
of the same discipline `CLAUDE.md`'s "Versioning" section already requires
for the version bump: whoever merges bumps the version *and* runs this,
in the same pass.

## Steps

1. Run `node tools/generate-architecture-graph.mjs` (or `npm run
   architecture:graph`).
2. Diff its output against the ` ```mermaid ` block currently embedded in
   `docs/architecture.md`'s "Dependency graph" section.
   - No change → nothing to do, stop here.
   - Changed → replace that block with the new output verbatim. Don't
     hand-edit the diagram; it must always be exactly what the script
     produced, or it stops being trustworthy.
3. Look at what actually changed (new/removed files, new/removed edges)
   and ask: does any subsystem grouping in `docs/architecture.md`'s
   "Subsystems" section, or in `tools/generate-architecture-graph.mjs`'s
   own `GROUPS` table, still make sense?
   - A new file with no clear home shows up in the generated diagram's
     "Other" subgraph — that's the signal to either add it to an existing
     group (edit `GROUPS` in the script) or write a new subsystem section
     in the doc's prose, not to leave it stranded in "Other" indefinitely.
   - A file that moved subsystems (e.g. a pure-logic file gained a
     Foundry-glue sibling, or an existing pair split apart) may need its
     prose description updated too, not just its `GROUPS` entry.
4. Re-read the "Two intentional circular imports" section — if a new
   circular pair appeared (or one of the two existing ones was resolved),
   update that section to match. A new circular import between two files
   isn't automatically wrong (the two documented pairs are deliberate),
   but it's worth a beat of thought about whether it's intentional before
   just noting it.
5. Commit `docs/architecture.md` (and `tools/generate-architecture-graph.mjs`
   if you changed its `GROUPS` table) alongside whatever change prompted
   the refresh — same commit or same PR as the version bump, not a
   separate follow-up.
