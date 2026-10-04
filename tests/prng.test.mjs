import { describe, it, expect } from "vitest";
import { splitmix32, seedFromString, shuffle } from "../scripts/prng.mjs";

describe("splitmix32", () => {
  it("is deterministic for a given seed", () => {
    const a = splitmix32(42);
    const b = splitmix32(42);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = splitmix32(1);
    const b = splitmix32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("property: every output is within [0, 1) across many seeds and draws", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const rand = splitmix32(seed);
      for (let i = 0; i < 200; i += 1) {
        const value = rand();
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });

  it("property: output distribution across many draws isn't lopsided toward one half", () => {
    const rand = splitmix32(777);
    let below = 0;
    const total = 20000;
    for (let i = 0; i < total; i += 1) if (rand() < 0.5) below += 1;
    // A genuinely broken generator (always low, or a short repeating cycle
    // biased to one half) would land far outside this band; a reasonable
    // PRNG lands close to 50/50 over this many draws.
    expect(below / total).toBeGreaterThan(0.47);
    expect(below / total).toBeLessThan(0.53);
  });
});

describe("seedFromString", () => {
  it("is deterministic for the same string", () => {
    expect(seedFromString("alpha")).toBe(seedFromString("alpha"));
  });

  it("produces 500 distinct seeds for 500 distinct strings (no collisions in a reasonable sample)", () => {
    const seeds = new Set();
    for (let i = 0; i < 500; i += 1) seeds.add(seedFromString(`seed-${i}`));
    expect(seeds.size).toBe(500);
  });

  it("always returns a value in the unsigned 32-bit range", () => {
    for (let i = 0; i < 100; i += 1) {
      const seed = seedFromString(`probe-${i}`);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe("shuffle", () => {
  it("returns a permutation of the input -- same elements, same length", () => {
    const rand = splitmix32(99);
    const input = Array.from({ length: 20 }, (_, i) => i);
    const result = shuffle(input, rand);
    expect(result).toHaveLength(input.length);
    expect([...result].sort((a, b) => a - b)).toEqual(input);
  });

  it("does not mutate the input array", () => {
    const rand = splitmix32(5);
    const input = [1, 2, 3, 4, 5];
    const copy = [...input];
    shuffle(input, rand);
    expect(input).toEqual(copy);
  });

  it("property: over many independent shuffles, the first element doesn't pile into one or two fixed final positions", () => {
    const size = 10;
    const input = Array.from({ length: size }, (_, i) => i);
    const landedPositions = new Set();
    for (let seed = 0; seed < 300; seed += 1) {
      const rand = splitmix32(seed);
      const result = shuffle(input, rand);
      landedPositions.add(result.indexOf(0));
    }
    // A broken shuffle (e.g. one that never moves the first element) would
    // show element 0 landing in only one or two of the 10 possible slots
    // across 300 independent trials; a healthy shuffle spreads it widely.
    expect(landedPositions.size).toBeGreaterThan(5);
  });
});
