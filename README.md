# PF2e Dungeon Crawl

Foundry VTT v13 module for Pathfinder 2E: procedurally sequenced dungeon
rooms, encounter generation, traps, puzzles, skill challenges and
GM-less-capable combat AI, driven by a swappable generator interface.
Fully self-contained — no other module is required. (Originally split out
of [deck-of-many-more-things](https://github.com/cory-johannsen/foundry-deck-of-many-things);
that repo now depends on this one instead, rather than the other way
around.)

## Install

Install by manifest URL in Foundry:

```
https://raw.githubusercontent.com/cory-johannsen/foundry-pf2e-dungeon-crawl/main/module.json
```

Requires the `pf2e` system (minimum v6.0.0) and Foundry v13. No other
module is required.

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

### GM-less combat AI (agent loop)

```bash
npm run agent-loop        # poll Foundry for pending agent-controlled turns
npm run agent-bridge-mcp  # MCP server for agent-driven customization
```

See `tools/agent-loop/README.md` for details.
