// tests/dungeon-combat-npc-self-vocabulary.test.mjs
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeNpcSelfEntries, pf2eDistanceFeet } from '../scripts/dungeon-combat.mjs';

// #934: the Foundry-touching half of the npcSelf vocabulary, against real
// compiled bestiary items (the coverage slice) and effect data mirroring the
// installed system's own bestiary effects.
const { entries: SLICE } = JSON.parse(
  readFileSync(new URL('./fixtures/npc-self-ability-slice.json', import.meta.url), 'utf8'),
);
let nextId = 0;
function realItem(actor, name, overrides = {}) {
  const entry = SLICE.find((e) => e.actor === actor && e.name === name);
  if (!entry) throw new Error(`fixture has no ${actor}: ${name}`);
  const id = `item${nextId++}`;
  const item = structuredClone(entry.item);
  return { ...item, id, uuid: `Actor.npc1.Item.${id}`, slug: null, ...overrides, system: { ...item.system, ...(overrides.system ?? {}) } };
}

const PHALANX = 'Compendium.pf2e.bestiary-effects.Item.l62iAFL3EO7wSsLL';
const THESIS = 'Compendium.pf2e.bestiary-effects.Item.eeZkQOCKjJN5JXZU';
const CONCEALED = 'Compendium.pf2e.conditionitems.Item.DmAIPqOBomZ7H95W';
const ROUND = { expiry: 'turn-start', sustained: false, unit: 'rounds', value: 1 };
const DOCS = {
  [PHALANX]: { slug: 'effect-form-a-phalanx', name: 'Effect: Form a Phalanx', system: { rules: [{ key: 'FlatModifier', selector: 'ac', type: 'circumstance', value: 2 }], duration: ROUND } },
  [THESIS]: {
    slug: 'effect-thesis-shield', name: 'Effect: Thesis Shield',
    system: { rules: [{ key: 'FlatModifier', selector: 'ac', type: 'circumstance', value: 2 }, { inMemoryOnly: true, key: 'GrantItem', uuid: CONCEALED }], duration: ROUND },
  },
  [CONCEALED]: { slug: 'concealed', name: 'Concealed' },
};

beforeEach(() => {
  nextId = 0;
  globalThis.fromUuid = vi.fn(async (uuid) => DOCS[uuid] ?? null);
});

function npc({ items = [], hp = 10, maxHp = 20, effects = [], conditions = [], other = [], melee = [] } = {}) {
  return {
    type: 'npc',
    items: [...items, ...other],
    itemTypes: { action: items, effect: effects, melee },
    conditions,
    system: { attributes: { hp: { value: hp, max: maxHp } } },
  };
}

function setup(actor, opponents = [], { flags = {}, round = 1 } = {}) {
  const combatant = { id: 'c1', actor, token: { x: 0, y: 0, width: 1, height: 1, disposition: -1 }, isDefeated: false };
  const others = opponents.map((o, i) => ({
    id: `o${i}`,
    actor: o.actor,
    isDefeated: false,
    token: { x: o.squares[0] * 100, y: o.squares[1] * 100, width: 1, height: 1, disposition: 1 },
  }));
  const combat = {
    round,
    scene: { grid: { size: 100, distance: 5 } },
    combatants: [combatant, ...others],
    getFlag: (_m, key) => flags[key],
  };
  return { combat, combatant };
}

const pc = (conditions = [], effects = []) => ({ type: 'character', conditions, itemTypes: { effect: effects } });

describe('pf2eDistanceFeet (#934)', () => {
  it('counts every second diagonal double (5-10-5)', () => {
    const at = (x, y) => ({ x: x * 100, y: y * 100, width: 1, height: 1 });
    expect(pf2eDistanceFeet(at(0, 0), at(3, 0), 100)).toBe(15);
    expect(pf2eDistanceFeet(at(0, 0), at(1, 1), 100)).toBe(5);
    expect(pf2eDistanceFeet(at(0, 0), at(2, 2), 100)).toBe(15);
    expect(pf2eDistanceFeet(at(0, 0), at(3, 3), 100)).toBe(20);
  });
});

describe('computeNpcSelfEntries (#934)', () => {
  it('offers Form a Phalanx with its effect summary, duration and no target', async () => {
    const item = realItem('Skeleton Infantry', 'Form a Phalanx');
    const { combat, combatant } = setup(npc({ items: [item] }));
    expect(await computeNpcSelfEntries(combat, combatant, 3)).toEqual([
      expect.objectContaining({
        itemId: item.id, slug: 'form-a-phalanx', name: 'Form a Phalanx', family: 'selfEffectAction', cost: 1,
        traits: [], hpFraction: null, effectSummary: '+ac', durationLabel: '1 rounds',
        summary: 'self-buff: +ac; lasts 1 rounds',
      }),
    ]);
  });

  it('is NPC-only (a character\'s selfEffect actions are the feat vocabulary\'s)', async () => {
    const item = realItem('Skeleton Infantry', 'Form a Phalanx');
    const { combat, combatant } = setup({ ...npc({ items: [item] }), type: 'character' });
    expect(await computeNpcSelfEntries(combat, combatant, 3)).toEqual([]);
  });

  it('returns [] for an NPC with no action items at all', async () => {
    const { combat, combatant } = setup(npc());
    expect(await computeNpcSelfEntries(combat, combatant, 3)).toEqual([]);
  });

  it('excludes an ability costing more than the actions remaining (Reef Armor: 2 actions, 1 left)', async () => {
    const item = realItem('Coral Dragon (Ancient)', 'Reef Armor', { system: { frequency: { max: 1, per: 'day', value: 1 } } });
    DOCS[item.system.selfEffect.uuid] = { slug: 'effect-reef-armor', system: { rules: [{ key: 'TempHP', value: 80 }], duration: { unit: 'minutes', value: 1 } } };
    const { combat, combatant } = setup(npc({ items: [item] }));
    expect(await computeNpcSelfEntries(combat, combatant, 1)).toEqual([]);
    expect(await computeNpcSelfEntries(combat, combatant, 2)).toHaveLength(1);
  });

  it('excludes an ability with no frequency uses left', async () => {
    const item = realItem('Coral Dragon (Ancient)', 'Reef Armor', { system: { frequency: { max: 1, per: 'day', value: 0 } } });
    const { combat, combatant } = setup(npc({ items: [item] }));
    expect(await computeNpcSelfEntries(combat, combatant, 3)).toEqual([]);
  });

  it('excludes an ability still recharging (shared abilityRecharge store)', async () => {
    const item = realItem('Canopy Elder', 'Vine Splint');
    const { combat, combatant } = setup(npc({ items: [item] }), [], { flags: { abilityRecharge: { c1: { 'vine-splint': { availableAtRound: 4 } } } }, round: 2 });
    expect(await computeNpcSelfEntries(combat, combatant, 3)).toEqual([]);
  });

  it('excludes an effect already active from the same item or with the same slug', async () => {
    const item = realItem('Skeleton Infantry', 'Form a Phalanx');
    const fromItem = { slug: 'x', system: { context: { origin: { item: item.uuid } } } };
    const sameSlug = { slug: 'effect-form-a-phalanx', system: {} };
    for (const effect of [fromItem, sameSlug]) {
      const { combat, combatant } = setup(npc({ items: [item], effects: [effect] }));
      expect(await computeNpcSelfEntries(combat, combatant, 3)).toEqual([]);
    }
  });

  it('excludes an ability whose linked effect does not resolve', async () => {
    const item = realItem('Skeleton Infantry', 'Form a Phalanx');
    globalThis.fromUuid = vi.fn(async () => null);
    const { combat, combatant } = setup(npc({ items: [item] }));
    expect(await computeNpcSelfEntries(combat, combatant, 3)).toEqual([]);
  });

  it('offers Thesis Shield only because its effect really grants the Concealed its prose names', async () => {
    const item = realItem('Zhuraita', 'Thesis Shield');
    const { combat, combatant } = setup(npc({ items: [item] }));
    expect(await computeNpcSelfEntries(combat, combatant, 3)).toHaveLength(1);
    DOCS[THESIS] = { ...DOCS[THESIS], system: { ...DOCS[THESIS].system, rules: [{ key: 'FlatModifier', selector: 'ac', value: 2 }] } };
    expect(await computeNpcSelfEntries(combat, combatant, 3)).toEqual([]);
  });

  it('excludes a heal at full HP and offers it when hurt, with the HP fraction', async () => {
    const item = realItem('Adamant Sentinel', 'Self-Repair');
    const full = setup(npc({ items: [item], hp: 20, maxHp: 20 }));
    expect(await computeNpcSelfEntries(full.combat, full.combatant, 3)).toEqual([]);
    const hurt = setup(npc({ items: [item], hp: 5, maxHp: 20 }));
    expect(await computeNpcSelfEntries(hurt.combat, hurt.combatant, 3)).toEqual([
      expect.objectContaining({ family: 'selfHeal', hpFraction: 0.25, summary: 'heals itself 30 HP (now at 25% HP)' }),
    ]);
  });

  describe("Feed on Fear's enemyWithin requirement (15 ft, under a fear effect or Dying)", () => {
    const item = () => realItem("Will-o'-Wisp", 'Feed on Fear', { system: { frequency: { max: 1, per: 'round', value: 1 } } });
    const offered = async (opponents) => {
      const { combat, combatant } = setup(npc({ items: [item()] }), opponents);
      return (await computeNpcSelfEntries(combat, combatant, 3)).length === 1;
    };

    it('holds for a dying enemy 15 ft away, not one 20 ft away (3 diagonals = 20 ft in PF2e)', async () => {
      expect(await offered([{ actor: pc([{ slug: 'dying' }]), squares: [3, 0] }])).toBe(true);
      expect(await offered([{ actor: pc([{ slug: 'dying' }]), squares: [3, 3] }])).toBe(false);
    });

    it('holds for a frightened enemy or one with a fear-trait effect', async () => {
      expect(await offered([{ actor: pc([{ slug: 'frightened' }]), squares: [1, 0] }])).toBe(true);
      expect(await offered([{ actor: pc([], [{ system: { traits: { value: ['fear', 'mental'] } } }]), squares: [1, 0] }])).toBe(true);
    });

    it('fails for an enemy in range that is neither afraid nor dying', async () => {
      expect(await offered([{ actor: pc([{ slug: 'prone' }]), squares: [1, 0] }])).toBe(false);
      expect(await offered([])).toBe(false);
    });
  });

  it("checks Spear Parry's wielding requirement against the NPC's own Strikes", async () => {
    const item = realItem('Kholo Pragmatist', 'Spear Parry');
    DOCS[item.system.selfEffect.uuid] = { slug: 'effect-spear-parry', system: { rules: [{ key: 'FlatModifier', selector: 'ac', value: 1 }], duration: ROUND } };
    const withSpear = setup(npc({ items: [item], melee: [{ name: 'Longspear' }] }));
    expect(await computeNpcSelfEntries(withSpear.combat, withSpear.combatant, 3)).toHaveLength(1);
    const without = setup(npc({ items: [item], melee: [{ name: 'Jaws' }] }));
    expect(await computeNpcSelfEntries(without.combat, without.combatant, 3)).toEqual([]);
  });

  it("checks Patch and Set's hand-free requirement against held items' hands", async () => {
    const item = realItem('Warmonger', 'Patch and Set', { system: { frequency: { max: 1, per: 'day', value: 1 } } });
    const twoHanded = { name: 'Greataxe', system: { equipped: { carryType: 'held', handsHeld: 2 } } };
    const busy = setup(npc({ items: [item], other: [twoHanded] }));
    expect(await computeNpcSelfEntries(busy.combat, busy.combatant, 3)).toEqual([]);
    const oneHanded = { name: 'Battle Axe', system: { equipped: { carryType: 'held', handsHeld: 1 } } };
    const free = setup(npc({ items: [item], other: [oneHanded] }));
    expect(await computeNpcSelfEntries(free.combat, free.combatant, 3)).toHaveLength(1);
  });

  it('skips an item whose data throws, keeping the rest', async () => {
    const bad = { id: 'bad', name: 'Bad', type: 'action', get system() { throw new Error('boom'); } };
    const good = realItem('Skeleton Infantry', 'Form a Phalanx');
    const { combat, combatant } = setup(npc({ items: [bad, good] }));
    expect((await computeNpcSelfEntries(combat, combatant, 3)).map((e) => e.itemId)).toEqual([good.id]);
  });
});
