import { describe, it, expect, beforeEach } from 'vitest';
import { registerGenerator, getGenerator, __resetGeneratorForTests } from '../scripts/generator-registry.mjs';

describe('generator-registry', () => {
  beforeEach(() => {
    __resetGeneratorForTests();
  });

  it('throws if nothing has ever been registered', () => {
    expect(() => getGenerator()).toThrow(/no generator registered/i);
  });

  it('returns the most recently registered generator', () => {
    const stubMethods = {
      findOutcomeTemplate: () => {},
      resolveRoomOutcome: () => {},
      revealTravelTimeEffect: () => {},
      generateEncounterRoster: () => {},
      buildRoomGraph: () => {},
      insertRestRoom: () => {},
      attachHiddenPaths: () => {},
    };
    const genA = { ...stubMethods, buildRoomSequence: () => 'a' };
    const genB = { ...stubMethods, buildRoomSequence: () => 'b' };
    registerGenerator(genA);
    registerGenerator(genB);
    expect(getGenerator()).toBe(genB);
  });

  it('rejects a generator missing a required method', () => {
    expect(() => registerGenerator({ buildRoomSequence: () => {} })).toThrow(
      /findOutcomeTemplate/,
    );
  });

  // #93 post-merge fix (Task 15 item 2): startDungeonRun calls all three
  // graph-generation methods through getGenerator() — a generator missing
  // any of them must fail at registration, not throw at run start.
  it.each(['buildRoomGraph', 'insertRestRoom', 'attachHiddenPaths'])(
    'rejects a generator missing the graph-generation method %s',
    (missingMethod) => {
      const gen = {
        buildRoomSequence: () => {},
        findOutcomeTemplate: () => {},
        resolveRoomOutcome: () => {},
        revealTravelTimeEffect: () => {},
        generateEncounterRoster: () => {},
        buildRoomGraph: () => {},
        insertRestRoom: () => {},
        attachHiddenPaths: () => {},
      };
      delete gen[missingMethod];
      expect(() => registerGenerator(gen)).toThrow(new RegExp(missingMethod));
    },
  );

  it('the default generator satisfies every required method', async () => {
    const { DefaultGenerator } = await import('../scripts/default-generator.mjs');
    expect(() => registerGenerator(DefaultGenerator)).not.toThrow();
  });
});
