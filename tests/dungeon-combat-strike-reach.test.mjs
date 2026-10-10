import { afterCandidateRebuild } from "./helpers/after-candidate-rebuild.mjs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyAgentDecision,
  chebyshevSquares,
  rollAndApplyStrike,
} from "../scripts/dungeon-combat.mjs";

// #551: AI melee Strikes must not land beyond the attacker's actual reach.

const G = 100;

beforeEach(() => {
  globalThis.CONST = {
    WALL_MOVEMENT_TYPES: { NONE: 0, NORMAL: 20 },
    WALL_DOOR_TYPES: { NONE: 0, DOOR: 1, SECRET: 2 },
    WALL_DOOR_STATES: { CLOSED: 0, OPEN: 1, LOCKED: 2 },
  };
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = {
    create: vi.fn(async () => {}),
    getWhisperRecipients: () => [{ id: "gm1" }],
  };
  globalThis.game = {
    user: { isGM: true, flags: { pf2e: { settings: {} } }, update: async () => {} },
    i18n: { format: (k) => k },
    messages: { contents: [] },
    combats: { contents: [], has: () => false },
    modules: { get: () => ({ version: "0" }) },
  };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

describe("chebyshevSquares is footprint-aware (#551)", () => {
  const t = (gx, gy, w = 1, h = 1) => ({ x: gx * G, y: gy * G, width: w, height: h });

  it("keeps 1x1 behavior", () => {
    expect(chebyshevSquares(t(0, 0), t(1, 0), G)).toBe(1);
    expect(chebyshevSquares(t(0, 0), t(1, 1), G)).toBe(1);
    expect(chebyshevSquares(t(0, 0), t(3, 1), G)).toBe(3);
    expect(chebyshevSquares({ x: 0, y: 0 }, { x: 250, y: 50 }, G)).toBe(2.5);
  });

  it("a 2x2 token reaches a target adjacent to its far (+x) edge", () => {
    expect(chebyshevSquares(t(0, 0, 2, 2), t(2, 0), G)).toBe(1);
  });

  it("a target on the -x side is unchanged", () => {
    expect(chebyshevSquares(t(2, 0, 2, 2), t(1, 0), G)).toBe(1);
    expect(chebyshevSquares(t(2, 0, 2, 2), t(0, 0), G)).toBe(2);
  });

  it("2x2 vs 2x2 uses nearest cells", () => {
    expect(chebyshevSquares(t(0, 0, 2, 2), t(3, 0, 2, 2), G)).toBe(2);
    expect(chebyshevSquares(t(0, 0, 2, 2), t(2, 2, 2, 2), G)).toBe(1);
  });

  it("overlapping footprints are 0", () => {
    expect(chebyshevSquares(t(0, 0, 2, 2), t(1, 1), G)).toBe(0);
  });
});

function strikeAction({ slug = "claw", reach = null, rangeFt = null } = {}) {
  return {
    type: "strike",
    ready: true,
    slug,
    label: slug,
    traits: reach ? [{ name: `reach-${reach}` }] : [],
    variants: [{ roll: vi.fn(async () => {}) }],
    damage: vi.fn(async () => null),
    item: {
      slug,
      isRanged: !!rangeFt,
      system: rangeFt ? { range: { increment: rangeFt } } : {},
    },
  };
}

function mk(id, gx, gy, disposition, actions = []) {
  const flags = { agentControlled: true };
  return {
    id,
    name: id,
    isDefeated: false,
    token: {
      x: gx * G,
      y: gy * G,
      disposition,
      width: 1,
      height: 1,
      update: vi.fn(async function (c) {
        Object.assign(this, c);
      }),
    },
    getFlag: (_m, k) => flags[k],
    actor: {
      type: "npc",
      conditions: [],
      items: [],
      system: {
        actions,
        attributes: { hp: { value: 20, max: 20 } },
        movement: { speeds: { land: { value: 30 } } },
      },
    },
  };
}

function mkCombat(combatants, current) {
  const flags = { dungeonSlot: "slot-1", reactionUsed: {} };
  return {
    id: "c1",
    round: 2,
    turn: 3,
    combatant: current,
    combatants,
    getFlag: (_m, k) => flags[k],
    setFlag: async () => {},
    scene: {
      id: "s",
      grid: { size: G, distance: 5 },
      width: 12 * G,
      height: 3 * G,
      tokens: [],
      walls: { contents: [] },
      regions: [],
    },
  };
}

const diagnosticCalls = () =>
  ChatMessage.create.mock.calls.map(([m]) => m).filter((m) => m?.content?.includes("Diagnostic #551"));

describe("applyAgentDecision re-checks reach before a Strike (#551)", () => {
  it("skips the roll and whispers a diagnostic when the target moved out of reach", async () => {
    const claw = strikeAction();
    const me = mk("atk", 0, 0, -1, [claw]);
    const foe = mk("foe", 1, 0, 1);
    const combat = mkCombat([me, foe], me);
    // The target "moves" away right after the candidate list was rebuilt.
    afterCandidateRebuild(combat, () => {
      foe.token.x = 4 * G;
    });

    await applyAgentDecision(combat, "atk", "strike:claw:foe");

    expect(claw.variants[0].roll).not.toHaveBeenCalled();
    const diagnostics = diagnosticCalls();
    expect(diagnostics).toHaveLength(1);
    const msg = diagnostics[0];
    expect(msg.whisper).toEqual(["gm1"]);
    expect(msg.content).toContain("Diagnostic #551");
    expect(msg.content).toContain("4 squares away (reach 1)");
    expect(msg.content).toContain("<details>");
    const payload = JSON.parse(
      msg.content.match(/<pre>([\s\S]*)<\/pre>/)[1].replace(/&quot;/g, '"'),
    );
    expect(payload).toMatchObject({
      attacker: { id: "atk", name: "atk", x: 0, y: 0, width: 1, height: 1 },
      target: { id: "foe", name: "foe", x: 4 * G, y: 0, width: 1, height: 1 },
      candidateId: "strike:claw:foe",
      actionSlug: "claw",
      distance: 4,
      reach: 1,
      round: 2,
      turn: 3,
    });
    expect(console.warn).toHaveBeenCalledWith(
      "pf2e-dungeon-crawl | strike skipped: target out of reach",
      expect.any(Object),
    );
  });

  it("rolls with no diagnostic when in reach", async () => {
    const claw = strikeAction();
    const me = mk("atk", 0, 0, -1, [claw]);
    const foe = mk("foe", 1, 0, 1);
    const combat = mkCombat([me, foe], me);

    await applyAgentDecision(combat, "atk", "strike:claw:foe");

    expect(claw.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(diagnosticCalls()).toHaveLength(0);
  });

  it("a ranged action (range 120 ft) at 6 squares is in reach", async () => {
    const bow = strikeAction({ slug: "bow", rangeFt: 120 });
    const me = mk("atk", 0, 0, -1, [bow]);
    const foe = mk("foe", 6, 0, 1);
    const combat = mkCombat([me, foe], me);

    await applyAgentDecision(combat, "atk", "strike:bow:foe");

    expect(bow.variants[0].roll).toHaveBeenCalledTimes(1);
    expect(diagnosticCalls()).toHaveLength(0);
  });
});

describe("rollAndApplyStrike (heuristic) respects reach (#551)", () => {
  it("returns null without rolling or whispering when a melee-only actor is 3 squares away", async () => {
    const claw = strikeAction();
    const me = mk("atk", 0, 0, -1, [claw]);
    const foe = mk("foe", 3, 0, 1);
    const combat = mkCombat([me, foe], me);

    expect(await rollAndApplyStrike(combat, me, foe)).toBeNull();
    expect(claw.variants[0].roll).not.toHaveBeenCalled();
    expect(ChatMessage.create).not.toHaveBeenCalled();
  });

  it("rolls when the melee target is adjacent", async () => {
    const claw = strikeAction();
    const me = mk("atk", 0, 0, -1, [claw]);
    const foe = mk("foe", 1, 1, 1);
    const combat = mkCombat([me, foe], me);

    await rollAndApplyStrike(combat, me, foe);
    expect(claw.variants[0].roll).toHaveBeenCalledTimes(1);
  });

  it("picks the ranged strike over melee when the target is 4 squares away", async () => {
    const claw = strikeAction();
    const bow = strikeAction({ slug: "bow", rangeFt: 60 });
    const me = mk("atk", 0, 0, -1, [claw, bow]);
    const foe = mk("foe", 4, 0, 1);
    const combat = mkCombat([me, foe], me);

    await rollAndApplyStrike(combat, me, foe);
    expect(claw.variants[0].roll).not.toHaveBeenCalled();
    expect(bow.variants[0].roll).toHaveBeenCalledTimes(1);
  });
});
