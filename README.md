# PF2e Dungeon Crawl

Foundry VTT v14 module for Pathfinder 2E: procedurally sequenced dungeon
rooms, encounter generation, traps, puzzles, skill challenges and
GM-less-capable combat AI, driven by a swappable generator interface.

## Install

Install by manifest URL in Foundry:

```
https://raw.githubusercontent.com/cory-johannsen/foundry-pf2e-dungeon-crawl/main/module.json
```

Requires the `pf2e` system (minimum v6.0.0) and Foundry v14. No other
module is required.

## Usage

Two macros are installed automatically on first load (GM only):

- **PF2EDC: Generate Encounter** — a standalone encounter generator, usable
  outside a dungeon run.
- **PF2EDC: Dungeon Crawl** — opens the dungeon tracker; starts a new run or
  resumes/observes one already in progress.

Both are also reachable from script/console via the module API:

```js
game.modules.get('pf2e-dungeon-crawl').api.openDungeon();
game.modules.get('pf2e-dungeon-crawl').api.generateEncounter();
```

### The generator interface

Room sequencing and encounter rosters are produced by whatever generator
is currently registered, not hardcoded. A `DefaultGenerator` (this
module's own `dungeon-deck.mjs`/`encounter-roster.mjs` logic) self-registers
automatically at startup, so the module works standalone with no extra
setup. Another module (such as a card effect in a dependent module) can
supply its own room/encounter logic instead:

```js
game.modules.get('pf2e-dungeon-crawl').api.registerGenerator({
  buildRoomSequence({ seed, roomCount, setpieceIds, narrativeSetpieceIds }) { /* ... */ },
  findOutcomeTemplate(outcomeSlotId) { /* ... */ },
  resolveRoomOutcome(outcomeSlotTemplate, succeeded) { /* ... */ },
  applySequenceMutation(rooms, currentIndex, mutation, ctx) { /* ... */ },
  generateEncounterRoster({ resolved, api, partyLevel, traits, excludeTraits, levelOffsetBias, requireTrait, partySize }) { /* ... */ },
});
```

See `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`
in this repo for the GM-less combat-AI design, and the deck repo's split
design doc (linked above) for the generator interface's full rationale.

## Development

```bash
npm install
npm test                       # Vitest — dungeon-crawl logic + generator interface
npm run validate:dungeon       # ajv schema validation for dungeon setpieces
npm run validate:creature-art  # ajv schema validation for creature art
```

### Regenerating token art

Creature token art lives under `assets/creature-art/`, generated via a
ComfyUI server:

```bash
npm run tokens          # generate missing entries
npm run tokens:check    # verify existing entries
```

Art files live in per-source folders: `assets/creature-art/<source>/<slug>.webp`
(`<source>` = the entry's compendium `pack` without `pf2e.`; a file used by more
than one pack goes in `shared/`), and `data/creature-art.json` ids are prefixed
`<source>__` (`shared__<pack source>__` for files in `shared/`). New or flat art added by other tooling is normalized into that
layout with `npm run art:normalize` (idempotent; safe to re-run), and
`npm run validate:creature-art` plus `tests/creature-art-layout.test.mjs` fail
until it has been run. Note: tokens already placed in an existing world keep the
old flat path and show broken images until recreated; new spawns use the new path.

### Compendium pack

`packs/generated-creature-art/` is a shipped Actor compendium ("Generated
Creature Art") holding one copy of each pf2e creature in
`data/creature-art.json` with its generated art applied. It is derived data:
never edit it by hand.

```bash
npm run packs:build    # rebuild; needs a local pf2e install
npm run packs:check    # offline staleness report (add -- --strict to exit 1 if stale)
```

`packs:build` reads the pf2e system packs from `PF2E_SYSTEM_PACKS_DIR`
(default `/srv/foundry/data/Data/systems/pf2e/packs`); it copies them first
and never modifies the install. Rebuild and commit the result when an art
batch finishes or before a minor version bump, not on every PR (each rebuild
adds about 61 MB to git history).

### GM-less combat AI (hosted agent service)

GM-less combat decisions and flavor-text customization are served by a
persistent hosted HTTP service under `tools/agent-service/`, not a
local-process poller. Run it locally with:

```bash
npm run agent-service   # starts the hosted agent service (tools/agent-service/entrypoint.mjs)
```

Point a running Foundry world at it via the module's `agentServiceUrl` and
`agentServiceApiKey` settings (client-scoped — each GM sets them in their
own browser). See [`tools/agent-service/README.md`](tools/agent-service/README.md)
for deployment (Docker), Foundry configuration, and troubleshooting, and
`docs/superpowers/specs/2026-09-22-hosted-agent-service-design.md` for the
full design.
