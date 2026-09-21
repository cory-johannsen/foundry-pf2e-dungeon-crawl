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
      applySequenceMutation: () => {},
      generateEncounterRoster: () => {},
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
});
