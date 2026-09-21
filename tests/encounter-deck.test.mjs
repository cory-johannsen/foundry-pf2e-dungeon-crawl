import { describe, it, expect } from 'vitest';
import { buildEncounterDeck, dealEncounter, resolveDraws } from '../scripts/encounter-deck.mjs';

describe('buildEncounterDeck', () => {
  it('produces 20 well-formed slots with unique ids', () => {
    const slots = buildEncounterDeck({ seed: 'alpha' });
    expect(slots).toHaveLength(20);
    expect(new Set(slots.map((s) => s.id)).size).toBe(20);
    for (const s of slots) expect(typeof s.kind).toBe('string');
  });

  it('is deterministic for the same seed', () => {
    const a = buildEncounterDeck({ seed: 'alpha' });
    const b = buildEncounterDeck({ seed: 'alpha' });
    expect(a).toEqual(b);
  });

  it('produces different decks for different seeds', () => {
    const a = buildEncounterDeck({ seed: 'alpha' });
    const b = buildEncounterDeck({ seed: 'beta' });
    expect(a).not.toEqual(b);
  });

  it('includes exactly one friend, one lurker, two twins and one draw_two', () => {
    const slots = buildEncounterDeck({ seed: 'alpha' });
    const count = (kind) => slots.filter((s) => s.kind === kind).length;
    expect(count('friend')).toBe(1);
    expect(count('lurker')).toBe(1);
    expect(count('twin')).toBe(2);
    expect(count('draw_two')).toBe(1);
  });

  it('links the twin pair to each other', () => {
    const slots = buildEncounterDeck({ seed: 'alpha' });
    const [a, b] = slots.filter((s) => s.kind === 'twin');
    expect(a.twinPairId).toBe(b.id);
    expect(b.twinPairId).toBe(a.id);
  });

  it('never changes deck size when noncombat/goal are swapped in', () => {
    // Sweep several seeds so both the swap and no-swap branches are hit.
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
      expect(buildEncounterDeck({ seed })).toHaveLength(20);
    }
  });
});

describe('resolveDraws', () => {
  const FIXTURE = [
    { id: 'c1', kind: 'creature', levelOffset: 0 },
    { id: 'c2', kind: 'creature', levelOffset: 0 },
    { id: 'c3', kind: 'creature', levelOffset: 0 },
    { id: 'friend', kind: 'friend', levelOffset: -1 },
    { id: 'lurker', kind: 'lurker', levelOffset: 0 },
    { id: 'twinA', kind: 'twin', levelOffset: 1, twinPairId: 'twinB' },
    { id: 'twinB', kind: 'twin', levelOffset: 1, twinPairId: 'twinA' },
    { id: 'draw2', kind: 'draw_two' }
  ];

  it('sets Friend aside and draws two extra cards as foes', () => {
    const { resolved } = resolveDraws(FIXTURE, ['friend', 'c1', 'c2'], 1);
    expect(resolved.friend?.id).toBe('friend');
    expect(resolved.foes.map((s) => s.id)).toEqual(['c1', 'c2']);
  });

  it('sets Lurker aside without expanding the draw', () => {
    const { resolved } = resolveDraws(FIXTURE, ['lurker', 'c1'], 2);
    expect(resolved.lurker?.id).toBe('lurker');
    expect(resolved.foes.map((s) => s.id)).toEqual(['c1']);
  });

  it('shuffles a lone twin back and draws a replacement instead', () => {
    const { resolved, remainingIds } = resolveDraws(FIXTURE, ['twinA', 'c1', 'c2'], 2);
    expect(resolved.twins).toBeNull();
    expect(resolved.foes.map((s) => s.id)).toEqual(['c1', 'c2']);
    expect(remainingIds).toContain('twinA');
  });

  it('keeps both twins and bumps their level offset to the pair constant when drawn together', () => {
    const { resolved } = resolveDraws(FIXTURE, ['twinA', 'twinB'], 2);
    expect(resolved.twins).toHaveLength(2);
    expect(resolved.twins.map((s) => s.id).sort()).toEqual(['twinA', 'twinB']);
    for (const t of resolved.twins) expect(t.levelOffset).toBe(0);
  });

  it('permanently discards Draw Two and draws two replacements instead', () => {
    const { resolved } = resolveDraws(FIXTURE, ['draw2', 'c1', 'c2'], 1);
    expect(resolved.permanentlyDiscarded).toEqual(['draw2']);
    expect(resolved.foes.map((s) => s.id)).toEqual(['c1', 'c2']);
  });

  it('never returns a permanently-discarded card in remainingIds', () => {
    const { remainingIds } = resolveDraws(FIXTURE, ['draw2', 'c1', 'c2', 'c3'], 1);
    expect(remainingIds).not.toContain('draw2');
  });
});

describe('dealEncounter', () => {
  it('is deterministic for the same seed', () => {
    const slots = buildEncounterDeck({ seed: 'alpha' });
    const a = dealEncounter(slots, { seed: 'draw-1', partySize: 4 });
    const b = dealEncounter(slots, { seed: 'draw-1', partySize: 4 });
    expect(a).toEqual(b);
  });

  it('produces different draws for different seeds', () => {
    const slots = buildEncounterDeck({ seed: 'alpha' });
    const a = dealEncounter(slots, { seed: 'draw-1', partySize: 4 });
    const b = dealEncounter(slots, { seed: 'draw-2', partySize: 4 });
    expect(a).not.toEqual(b);
  });

  it('honours a supplied remainingIds instead of always starting fresh', () => {
    const slots = buildEncounterDeck({ seed: 'alpha' });
    const allIds = slots.map((s) => s.id);
    const half = allIds.slice(0, 10);
    const { resolved } = dealEncounter(slots, { seed: 'draw-1', partySize: 4, remainingIds: half });
    const drawnIds = [
      ...resolved.foes.map((s) => s.id),
      resolved.friend?.id, resolved.lurker?.id,
      ...(resolved.twins ?? []).map((s) => s.id),
      resolved.noncombat?.id, resolved.goal?.id,
      ...resolved.permanentlyDiscarded
    ].filter(Boolean);
    for (const id of drawnIds) expect(half).toContain(id);
  });
});
