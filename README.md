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

- **Generate Encounter** — a standalone encounter generator, usable
  outside a dungeon run.
- **Dungeon Crawl** — opens the dungeon tracker; starts a new run or
  resumes/observes one already in progress.

Both are also reachable from script/console via the module API:

```js
game.modules.get('pf2e-dungeon-crawl').api.openDungeon();
game.modules.get('pf2e-dungeon-crawl').api.generateEncounter();
```

### Generate Encounter: multiple forces

The Generate Encounter dialog builds a stand-alone encounter from one or
more **forces**, all sharing a single PF2e XP budget (set by the difficulty
and party size). The first force behaves exactly like the classic
single-force encounter; use **Add force** for more. Each force has:

- **Filters** — include traits, exclude traits, level range (offsets
  relative to the party level), and a rarity.
- **Budget share** — a percentage of the encounter's XP budget (shares
  should total 100; the dialog shows each force's XP allotment and warns
  otherwise). Each force is generated and posted as its own chat card.
- **Hostility** — *Hostile to players* (attacks the party, ignores other
  forces) or *Hostile to all* (attacks the party and every other force).
- **Placement** — near the party (forces are offset so they don't stack),
  or a chosen scene region.

A force that is only hostile to players retaliates at the force level: once
any creature of another force attacks one of its members, the whole force
treats the attacker's force as hostile for the rest of the encounter.
Player attacks never create retaliation edges. Spawned tokens are labelled
and tinted per force (restored when combat ends). The combat ends in victory
when no living enemies remain hostile to each other or the party, and in
defeat if the party falls; XP is awarded once for every force.

Known limitation: PF2e treats every spawned creature as the `opposition`
alliance, so its flank indicator may count creatures of another force as
allies. The module's AI and targeting use the force hostility relation and
are not affected.

### Environment

Encounters can be themed by environment (forest, swamp, underwater, ...).

- **Start Dungeon** has an Environment choice: `Random` (seeded, so the same
  seed gives the same environment), `None` (unchanged behaviour), or a
  specific environment. The choice applies to every combat room in the run.
- The stand-alone **Generate Encounter** dialog has its own Environment
  choice, and each force can override it or use "same as encounter".
- Creature selection relaxes in order: strict match, then adjacent
  environments, then the environment is dropped. A chat-card note says when
  a fallback was used. The trait theme (include/exclude traits) is kept
  before the environment is dropped.
- Creatures are mapped to environments in `data/creature-environments.json`
  (with `data/creature-environments.sources.json` recording where each
  entry came from). Hand edits are never overwritten: `--merge` only adds
  ids that are not already present.
- `npm run audit:environments` rebuilds or checks the map from a local pf2e
  install; set `PF2E_SYSTEM_PACKS_DIR` to point at it.

Coverage is partial: about 48% of creatures are mapped. Creature prose
covers only about 5%, most mapped entries are derived from traits, and the
Monster Core creatures of levels -1..8 were hand-reviewed at about 94%.
Unmapped creatures are only used once the environment has been dropped.

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

### Regenerating party character art

`tools/generate-party-art.mjs` regenerates the Cleric/Thief portrait+token art
with the same ComfyUI pipeline (ComfyUI only, no paid fallback; needs
`.venv` with Pillow and numpy). Candidates, the manifest, the contact sheet and
the files copied into the Foundry data dir live outside the repo (suggested
staging dir `~/src/art-tools/out/party-art/<date>/`) and are **never
committed**.

```bash
node tools/generate-party-art.mjs --subjects subjects.json --out <dir> [--count 4] [--reroll N] [--only id] [--force]
node tools/generate-party-art.mjs --apply --manifest <dir>/manifest.json --pick cleric=2,thief=3 [--dry-run]
node tools/generate-party-art.mjs --revert <dir>/applied.json [--delete-new]
```

Apply copies the pick to a new versioned file (`party-portraits/<id>-vN.webp`),
updates the Actor, prototype token and placed tokens through the `foundry-rest`
skill, and writes `applied.json` for `--revert`. Old files are never deleted.

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
batch finishes or before a minor version bump, not on every PR (the
`_source/*.json` files are unchanged across rebuilds, but the compiled LevelDB
file is rewritten completely, so each rebuild adds about 61 MB of new binary
blobs to git history).

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
