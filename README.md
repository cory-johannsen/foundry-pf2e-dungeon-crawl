# PF2e Dungeon Crawl

Foundry VTT v13 module for Pathfinder 2E: procedurally sequenced dungeon
rooms, encounter generation, traps, puzzles, skill challenges and
GM-less-capable combat AI, driven by a swappable generator interface.
Split out of [deck-of-many-more-things](https://github.com/cory-johannsen/foundry-deck-of-many-things)
(see that repo's `docs/superpowers/specs/2026-09-21-dungeon-crawl-module-split-design.md`
for the full design).

**Requires `deck-of-many-more-things` to be installed and enabled
alongside this module.** This module depends on it for shared
infrastructure (Foundry API glue, RNG, data loading, choice prompts, cover
items, placement, treasure, and trap-combat mechanics) declared as a
Foundry module dependency in `module.json`. It also depends on it for
room-art and dungeon-sound assets, which are served from the deck
module's install directory rather than duplicated here.

## Install

Install by manifest URL in Foundry:

```
https://raw.githubusercontent.com/cory-johannsen/foundry-pf2e-dungeon-crawl/main/module.json
```

Requires the `pf2e` system (minimum v6.0.0), Foundry v13, and
`deck-of-many-more-things` (minimum v0.71.0) installed and enabled.

## Usage

Two macros are installed automatically on first load (GM only):

- **DOMMT: Generate Encounter** — a standalone encounter generator, usable
  outside a dungeon run.
- **DOMMT: Dungeon Crawl** — opens the dungeon tracker; starts a new run or
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
setup. Another module (or a future card effect in `deck-of-many-more-things`
itself) can supply its own room/encounter logic instead:

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

### GM-less combat AI (agent loop)

```bash
npm run agent-loop        # poll Foundry for pending agent-controlled turns
npm run agent-bridge-mcp  # MCP server for agent-driven customization
```

See `tools/agent-loop/README.md` for details.
