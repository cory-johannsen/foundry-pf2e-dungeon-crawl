/**
 * The swappable generator contract this module is driven by. A generator
 * supplies room sequencing and encounter rosters; a dependent module
 * (or any other caller) may register its own, but nothing needs to — see
 * default-generator.mjs, self-registered at ready if no one else has.
 */
const REQUIRED_METHODS = [
  'buildRoomSequence',
  'findOutcomeTemplate',
  'resolveRoomOutcome',
  'revealTravelTimeEffect',
  'generateEncounterRoster',
];

let current = null;

export function registerGenerator(generatorObj) {
  const missing = REQUIRED_METHODS.filter(
    (m) => typeof generatorObj?.[m] !== 'function',
  );
  if (missing.length) {
    throw new Error(
      `registerGenerator: generator is missing required method(s): ${missing.join(', ')}`,
    );
  }
  current = generatorObj;
}

export function getGenerator() {
  if (!current) {
    throw new Error(
      'getGenerator: no generator registered — call registerGenerator first (foundry-pf2e-dungeon-crawl registers DefaultGenerator at ready if nothing else has).',
    );
  }
  return current;
}

/** Test-only: clears the registered generator between test cases. */
export function __resetGeneratorForTests() {
  current = null;
}
