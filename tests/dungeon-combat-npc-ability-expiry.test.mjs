// tests/dungeon-combat-npc-ability-expiry.test.mjs
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sweepExpiredNpcAbilityConditions,
  settleNpcAbilityConditionsAtCombatEnd,
  getNpcAbilityImmunityUntil,
  setNpcAbilityImmunityUntil,
} from '../scripts/dungeon-combat.mjs';

// #915: a sibling of #911's maneuver-rider sweep (same combatStub helper and
// the same two expiry shapes), under its own `npcAbilityExpiry` flag.

const MODULE_ID = 'pf2e-dungeon-crawl';

function combatStub({ round = 1, turn = 0, flags = {} } = {}) {
  const store = { ...flags };
  return {
    round,
    turn,
    combatants: [],
    getFlag: (_m, key) => store[key],
    setFlag: vi.fn(async (_m, key, value) => {
      store[key] = value;
    }),
  };
}

const timed = (targetId, slug, round, turn, extra = {}) => ({
  targetId, conditionSlug: slug, expiry: { untilRoundTurn: { round, turn } }, ...extra,
});

beforeEach(() => {
  globalThis.game = { user: { isGM: true }, time: { worldTime: 1000 } };
  globalThis.ChatMessage = { create: vi.fn(async () => {}), getWhisperRecipients: () => [{ id: 'gm' }] };
  globalThis.foundry = { utils: {} };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('sweepExpiredNpcAbilityConditions (#915)', () => {
  it('does nothing when nothing is tracked, and never throws on a bare stub', async () => {
    const combat = combatStub();
    await sweepExpiredNpcAbilityConditions(combat);
    expect(combat.setFlag).not.toHaveBeenCalled();
    await expect(sweepExpiredNpcAbilityConditions(null)).resolves.toBeUndefined();
    await expect(sweepExpiredNpcAbilityConditions({ round: 2 })).resolves.toBeUndefined();
  });

  it('removes a timed condition once its (round, turn) is reached, and drops the entry', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({ round: 2, turn: 1, flags: { npcAbilityExpiry: [timed('c1', 'dazzled', 2, 1)] } });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredNpcAbilityConditions(combat);
    expect(decreaseCondition).toHaveBeenCalledWith('dazzled', { forceRemove: true });
    expect(combat.getFlag(MODULE_ID, 'npcAbilityExpiry')).toEqual([]);
  });

  it('leaves an unexpired entry in place', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({ round: 2, turn: 0, flags: { npcAbilityExpiry: [timed('c1', 'dazzled', 2, 1)] } });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredNpcAbilityConditions(combat);
    expect(decreaseCondition).not.toHaveBeenCalled();
    expect(combat.setFlag).not.toHaveBeenCalled();
  });

  it('keeps sweeping the rest when one removal throws', async () => {
    const bad = vi.fn(async () => { throw new Error('boom'); });
    const good = vi.fn();
    const combat = combatStub({ round: 3, turn: 0, flags: { npcAbilityExpiry: [timed('c1', 'dazzled', 2, 0), timed('c2', 'fleeing', 2, 0)] } });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition: bad } }, { id: 'c2', actor: { decreaseCondition: good } });
    await sweepExpiredNpcAbilityConditions(combat);
    expect(good).toHaveBeenCalledWith('fleeing', { forceRemove: true });
    expect(combat.getFlag(MODULE_ID, 'npcAbilityExpiry')).toEqual([]);
  });

  it('never touches #911\'s maneuverRiderExpiry entries', async () => {
    const decreaseCondition = vi.fn();
    const combat = combatStub({ round: 5, turn: 0, flags: { maneuverRiderExpiry: [timed('c1', 'fleeing', 2, 0)] } });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredNpcAbilityConditions(combat);
    expect(decreaseCondition).not.toHaveBeenCalled();
  });

  it('only runs on the GM', async () => {
    globalThis.game.user.isGM = false;
    const decreaseCondition = vi.fn();
    const combat = combatStub({ round: 5, turn: 0, flags: { npcAbilityExpiry: [timed('c1', 'dazzled', 2, 0)] } });
    combat.combatants.push({ id: 'c1', actor: { decreaseCondition } });
    await sweepExpiredNpcAbilityConditions(combat);
    expect(decreaseCondition).not.toHaveBeenCalled();
  });
});

describe('settleNpcAbilityConditionsAtCombatEnd (#915)', () => {
  it('removes conditions whose game-clock end has passed or that were turn-scoped, and whispers the GM the rest', async () => {
    const dazzled = vi.fn();
    const fleeing = vi.fn();
    const stupefied = vi.fn();
    const combat = combatStub({
      flags: {
        npcAbilityExpiry: [
          timed('c1', 'dazzled', 9, 0, { expiresAtWorldTime: 990 }),
          { targetId: 'c2', conditionSlug: 'fleeing', expiry: { untilRoundTurn: { round: 2, turn: 0 } }, expiresAtWorldTime: null },
          timed('c3', 'stupefied', 600, 0, { expiresAtWorldTime: 4600 }),
        ],
      },
    });
    combat.combatants.push(
      { id: 'c1', name: 'Amiri', actor: { decreaseCondition: dazzled } },
      { id: 'c2', name: 'Kyra', actor: { decreaseCondition: fleeing } },
      { id: 'c3', name: 'Ezren', actor: { decreaseCondition: stupefied } },
    );
    await settleNpcAbilityConditionsAtCombatEnd(combat);
    expect(dazzled).toHaveBeenCalledWith('dazzled', { forceRemove: true });
    expect(fleeing).toHaveBeenCalledWith('fleeing', { forceRemove: true });
    expect(stupefied).not.toHaveBeenCalled();
    const content = ChatMessage.create.mock.calls[0][0].content;
    expect(content).toMatch(/Ezren/);
    expect(content).toMatch(/stupefied/);
    expect(content).toMatch(/60 minutes/);
  });

  it('does nothing (no whisper) when nothing is tracked', async () => {
    await settleNpcAbilityConditionsAtCombatEnd(combatStub());
    expect(ChatMessage.create).not.toHaveBeenCalled();
  });
});

describe('npcAbility immunity tracking (#915)', () => {
  it('reads back 0 when nothing has been set, round-trips a set value, and keeps (itemId, targetId) pairs separate', async () => {
    const combat = combatStub();
    expect(getNpcAbilityImmunityUntil(combat, 'ability1', 'opp1')).toBe(0);
    await setNpcAbilityImmunityUntil(combat, 'ability1', 'opp1', 1600);
    expect(getNpcAbilityImmunityUntil(combat, 'ability1', 'opp1')).toBe(1600);
    expect(getNpcAbilityImmunityUntil(combat, 'ability1', 'opp2')).toBe(0);
    expect(getNpcAbilityImmunityUntil(combat, 'ability2', 'opp1')).toBe(0);
  });
});
