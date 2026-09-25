/**
 * The generator this module falls back to when nothing else registers one
 * — today's dungeon-deck.mjs/encounter-roster.mjs logic, unchanged, just
 * exposed through the generator-registry.mjs contract instead of being
 * imported directly.
 */
import {
  buildRoomSequence,
  findOutcomeTemplate,
  resolveRoomOutcome,
  revealTravelTimeEffect,
} from './dungeon-deck.mjs';
import { resolveEncounterRoster } from './encounter-roster.mjs';

export const DefaultGenerator = {
  buildRoomSequence,
  findOutcomeTemplate,
  resolveRoomOutcome,
  revealTravelTimeEffect,
  generateEncounterRoster: resolveEncounterRoster,
};
