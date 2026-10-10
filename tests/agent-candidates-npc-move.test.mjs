// tests/agent-candidates-npc-move.test.mjs
import { describe, it, expect } from 'vitest';
import {
  buildNpcMoveVocabulary,
  buildNpcMoveCandidates,
  buildCandidateList,
  applyCandidateToTurnState,
  initAgentTurnState,
  NPC_MOVE_VOCABULARY_CAP,
} from '../scripts/agent-candidates.mjs';

// #932: the npcMove vocabulary/candidate builders (pure).

const goblin = { id: 'o1', name: 'Goblin', distanceSquares: 6 };
const fighter = { id: 'o2', name: 'Fighter', distanceSquares: 1 };

function gallop(overrides = {}) {
  return { itemId: 'i1', slug: 'gallop', name: 'Gallop', cost: 2, traits: [], kind: 'move', ...overrides };
}

describe('buildNpcMoveVocabulary', () => {
  it('offers a plain move as approach to an opponent beyond reach, retreat only with a ranged/reach option', () => {
    const vocab = buildNpcMoveVocabulary({ npcMoveEntries: [gallop()], opponents: [goblin, fighter] });
    expect(vocab.map((v) => `${v.posture}:${v.targetId}`)).toEqual(['approach:o1']);
    const withReach = buildNpcMoveVocabulary({ npcMoveEntries: [gallop()], opponents: [goblin, fighter], hasRangedOrReach: true });
    expect(withReach.map((v) => `${v.posture}:${v.targetId}`)).toEqual(['approach:o1', 'retreat:o2']);
    expect(withReach[0]).toMatchObject({ type: 'npcMove', kind: 'move', itemId: 'i1', slug: 'gallop', name: 'Gallop', cost: 2 });
  });

  it('uses the describe callback for the model-facing summary', () => {
    const [entry] = buildNpcMoveVocabulary({
      npcMoveEntries: [gallop()],
      opponents: [goblin],
      describe: (e, { posture, targetName }) => `${e.name}/${posture}/${targetName}`,
    });
    expect(entry.summary).toBe('Gallop/approach/Goblin');
  });

  it('offers a move-plus-Strike only for the (posture, target) pairs the caller found a path for', () => {
    const swoop = { itemId: 'i2', slug: 'swoop', name: 'Swoop', cost: 2, kind: 'strike', strikeOptions: [{ posture: 'approach', targetId: 'o1' }, { posture: 'hitAndRun', targetId: 'o1' }] };
    const vocab = buildNpcMoveVocabulary({ npcMoveEntries: [swoop], opponents: [goblin, fighter] });
    expect(vocab.map((v) => `${v.kind}:${v.posture}:${v.targetId}`)).toEqual(['strike:approach:o1', 'strike:hitAndRun:o1']);
  });

  it('offers a teleport only for the destinations the caller found, and drops a vanished opponent', () => {
    const jaunt = { itemId: 'i3', slug: 'jaunt', name: 'Jaunt', cost: 1, kind: 'teleport', teleportOptions: [{ posture: 'next-to', targetId: 'o1' }, { posture: 'away-from', targetId: 'gone' }] };
    const vocab = buildNpcMoveVocabulary({ npcMoveEntries: [jaunt], opponents: [goblin] });
    expect(vocab.map((v) => `${v.posture}:${v.targetId}`)).toEqual(['next-to:o1']);
  });

  it('drops a flourish ability once this turn already used a flourish', () => {
    const entry = gallop({ traits: ['flourish'] });
    expect(buildNpcMoveVocabulary({ npcMoveEntries: [entry], opponents: [goblin], turnState: { flourishUsed: true } })).toEqual([]);
  });

  it('caps the vocabulary, interleaving abilities so one cannot crowd out the others', () => {
    const opponents = Array.from({ length: 10 }, (_, i) => ({ id: `o${i}`, name: `O${i}`, distanceSquares: 5 }));
    const jaunt = { itemId: 'i3', slug: 'jaunt', name: 'Jaunt', cost: 1, kind: 'teleport', teleportOptions: [{ posture: 'next-to', targetId: 'o0' }] };
    const vocab = buildNpcMoveVocabulary({ npcMoveEntries: [gallop(), jaunt], opponents });
    expect(vocab).toHaveLength(NPC_MOVE_VOCABULARY_CAP);
    expect(vocab.some((v) => v.slug === 'jaunt')).toBe(true);
  });
});

describe('buildNpcMoveCandidates', () => {
  const vocab = [
    { type: 'npcMove', kind: 'move', itemId: 'i1', slug: 'gallop', name: 'Gallop', cost: 2, posture: 'approach', targetId: 'o1', traits: [], summary: 'Stride twice toward Goblin' },
    { type: 'npcMove', kind: 'move', itemId: 'i1', slug: 'gallop', name: 'Gallop', cost: 2, posture: 'retreat', targetId: 'o2', traits: [], summary: 'Stride twice away from Fighter' },
    { type: 'npcMove', kind: 'teleport', itemId: 'i3', slug: 'jaunt', name: 'Jaunt', cost: 1, posture: 'next-to', targetId: 'o1', traits: [], summary: 'next to' },
    { type: 'npcMove', kind: 'teleport', itemId: 'i3', slug: 'jaunt', name: 'Jaunt', cost: 1, posture: 'away-from', targetId: 'o1', traits: [], summary: 'away' },
  ];

  it('turns a (slug, targetId) pick into one candidate per offered posture', () => {
    const candidates = buildNpcMoveCandidates({ npcMoveVocabulary: vocab, picks: [{ type: 'npcMove', slug: 'jaunt', targetId: 'o1', rationale: 'flank' }], opponents: [goblin] });
    expect(candidates.map((c) => c.id)).toEqual(['npcMove:i3:next-to:o1', 'npcMove:i3:away-from:o1']);
    expect(candidates[0]).toMatchObject({ type: 'npcMove', kind: 'teleport', posture: 'next-to', targetId: 'o1', cost: 1, summary: 'Jaunt: next to — flank' });
  });

  it('drops picks that are not in the vocabulary, of another type, or whose target is gone', () => {
    const picks = [
      { type: 'npcMove', slug: 'gallop', targetId: 'o9' },
      { type: 'feat', slug: 'gallop', targetId: 'o1' },
      { type: 'npcMove', slug: 'gallop', targetId: 'o1', itemId: 'other' },
      null,
    ];
    expect(buildNpcMoveCandidates({ npcMoveVocabulary: vocab, picks, opponents: [goblin] })).toEqual([]);
    expect(buildNpcMoveCandidates({ npcMoveVocabulary: vocab, picks: [{ type: 'npcMove', slug: 'gallop', targetId: 'o2' }], opponents: [goblin] })).toEqual([]);
  });

  it('returns [] before the turn has picks', () => {
    expect(buildNpcMoveCandidates({ npcMoveVocabulary: vocab, picks: null, opponents: [] })).toEqual([]);
  });

  it('is part of buildCandidateList', () => {
    const list = buildCandidateList({
      opponents: [goblin], readyActions: [], turnState: { ...initAgentTurnState(), maneuverPicks: [] },
      maneuverPicks: [{ type: 'npcMove', slug: 'gallop', targetId: 'o1' }], npcMoveVocabulary: vocab,
    });
    expect(list.some((c) => c.id === 'npcMove:i1:approach:o1')).toBe(true);
  });
});

describe('applyCandidateToTurnState (npcMove)', () => {
  it("spends the ability's cost and adds the Strikes it really made to MAP", () => {
    const next = applyCandidateToTurnState(initAgentTurnState(), { type: 'npcMove', cost: 2, attacks: 1, traits: [] });
    expect(next).toMatchObject({ actionsRemaining: 1, mapIncrement: 1 });
    const moved = applyCandidateToTurnState(initAgentTurnState(), { type: 'npcMove', cost: 1, traits: ['flourish'] });
    expect(moved).toMatchObject({ actionsRemaining: 2, mapIncrement: 0, flourishUsed: true });
  });
});
