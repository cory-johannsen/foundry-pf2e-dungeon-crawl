// #910: shared stubs for the applyAgentDecision feat-execution tests.
// Shape copied from dungeon-combat-maneuver-execution.test.mjs and
// dungeon-combat-strike-reach.test.mjs: drives the real
// getPendingAgentTurn rebuild with persisted feat picks, so the chosen feat
// is a real candidate.
import { vi } from "vitest";

export const G = 100;
export const MODULE_ID = "pf2e-dungeon-crawl";

function mergeObject(original, other) {
  for (const [k, v] of Object.entries(other)) {
    if (v && typeof v === "object" && !Array.isArray(v) && original[k] && typeof original[k] === "object") {
      mergeObject(original[k], v);
    } else {
      original[k] = v;
    }
  }
  return original;
}

export function installGlobals() {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.foundry = { utils: { mergeObject } };
  globalThis.ChatMessage = {
    create: vi.fn(async () => {}),
    getWhisperRecipients: () => [{ id: "gm1" }],
  };
  globalThis.CONFIG = {
    Dice: { rolls: [] },
    PF2E: { effectTraits: { emotion: "Emotion", mental: "Mental", stance: "Stance" } },
  };
  globalThis.fromUuid = vi.fn(async () => null);
  globalThis.game = {
    i18n: { format: (key) => key },
    user: { isGM: true, flags: { pf2e: { settings: {} } }, update: vi.fn(async () => {}) },
    messages: { contents: [] },
    combats: { contents: [], has: () => false },
    modules: { get: () => ({ version: "0" }) },
    time: { worldTime: 1000 },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
}

export function makeWeapon({ id, slug, handsHeld = 1, category = "martial" }) {
  return {
    id,
    slug,
    type: "weapon",
    system: { category, range: null, equipped: { carryType: "held", handsHeld }, traits: { value: [] } },
  };
}

/** A ready strike action whose three MAP variants are separate mocks, so a
 * test can assert exactly which variant (MAP step) each Strike rolled. */
export function makeStrike(item, { reach = null } = {}) {
  return {
    type: "strike",
    ready: true,
    slug: item.slug,
    label: item.slug,
    item,
    traits: reach ? [{ name: `reach-${reach}` }] : [],
    variants: [0, 1, 2].map(() => ({ roll: vi.fn(async () => {}) })),
    damage: vi.fn(async () => null),
  };
}

function makeToken({ x, y, disposition, id }) {
  const token = { x, y, disposition, width: 1, height: 1, uuid: `Scene.s.Token.${id}` };
  token.update = vi.fn(async function (changes) {
    Object.assign(this, changes);
  });
  token.move = vi.fn(async function ({ x, y }) {
    Object.assign(this, { x, y });
  });
  return token;
}

export function makeCombatant({ id, gx, gy, disposition, type = "npc", actions = [], speed = 30, action = [], feat = [], effect = [] }) {
  const flags = { agentControlled: true };
  return {
    id,
    name: id,
    isDefeated: false,
    token: makeToken({ x: gx * G, y: gy * G, disposition, id }),
    getFlag: (_m, key) => flags[key],
    actor: {
      id,
      uuid: `Actor.${id}`,
      type,
      conditions: [],
      items: [],
      itemTypes: { weapon: [], action, feat, effect },
      skills: {},
      attributes: { immunities: [] },
      increaseCondition: vi.fn(async () => {}),
      decreaseCondition: vi.fn(async () => {}),
      applyDamage: vi.fn(async () => {}),
      createEmbeddedDocuments: vi.fn(async () => []),
      deleteEmbeddedDocuments: vi.fn(async () => []),
      toggleRollOption: vi.fn(async () => true),
      system: {
        actions,
        traits: { size: { value: "med" } },
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: speed } } },
      },
    },
  };
}

export function makeCombat(attacker, others, { picks, actionsRemaining = 3, mapIncrement = 0, width = 16 }) {
  const flags = {
    dungeonSlot: "slot-1",
    reactionUsed: {},
    agentTurnState: {
      combatantId: attacker.id,
      round: 1,
      turn: 0,
      actionsRemaining,
      mapIncrement,
      maneuverPicks: picks,
      counter: 1,
    },
  };
  return {
    id: "combat-1",
    round: 1,
    turn: 0,
    combatant: attacker,
    combatants: [attacker, ...others],
    getFlag: (_m, key) => flags[key],
    setFlag: async (_m, key, value) => {
      flags[key] = value;
    },
    scene: {
      id: "s",
      grid: { size: G, distance: 5 },
      width: width * G,
      height: 3 * G,
      tokens: [],
      walls: { contents: [] },
      regions: [],
    },
  };
}

export function turnState(combat) {
  return combat.getFlag(MODULE_ID, "agentTurnState");
}
