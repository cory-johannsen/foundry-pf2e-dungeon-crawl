/**
 * The generator this module falls back to when nothing else registers one
 * — today's dungeon-deck.mjs/encounter-roster.mjs logic, unchanged, just
 * exposed through the generator-registry.mjs contract instead of being
 * imported directly.
 */
import {
  buildRoomSequence,
  buildRoomGraph,
  insertRestRoom,
  attachHiddenPaths,
  findOutcomeTemplate,
  resolveRoomOutcome,
  revealTravelTimeEffect,
} from './dungeon-deck.mjs';
import { resolveEncounterRoster } from './encounter-roster.mjs';

export const DefaultGenerator = {
  buildRoomSequence,
  // #93: startDungeonRun's full-graph pregeneration calls these through
  // getGenerator(), same indirection as buildRoomSequence above.
  buildRoomGraph,
  // #93 post-merge fix (Task 2 addendum): mid-dungeon rest room pass,
  // run between buildRoomGraph and attachHiddenPaths.
  insertRestRoom,
  attachHiddenPaths,
  findOutcomeTemplate,
  resolveRoomOutcome,
  revealTravelTimeEffect,
  generateEncounterRoster: resolveEncounterRoster,
};
