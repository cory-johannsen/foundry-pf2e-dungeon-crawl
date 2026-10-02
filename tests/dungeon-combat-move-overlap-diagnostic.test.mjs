import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  reportMoveOverlap,
  stepToward,
  strideByPosture,
} from "../scripts/dungeon-combat.mjs";

// #554: diagnostic-only reporting of moves that end on another combatant.

const G = 100;

function makeCombatant({ id, name = id, x, y, disposition = -1, isDefeated = false }) {
  return {
    id,
    name,
    isDefeated,
    token: {
      x,
      y,
      disposition,
      width: 1,
      height: 1,
      update: vi.fn(async function (c) {
        Object.assign(this, c);
      }),
    },
    actor: { system: { movement: { speeds: { land: { value: 30 } } } } },
  };
}

function makeCombat(combatants) {
  return {
    round: 2,
    turn: 1,
    combatants,
    scene: { id: "s", grid: { size: G, distance: 5 }, tokens: [], walls: { contents: [] } },
    getFlag: () => undefined,
    setFlag: async () => {},
  };
}

let warn;
let created;
beforeEach(() => {
  created = [];
  globalThis.foundry = { utils: {} };
  globalThis.ChatMessage = {
    create: vi.fn(async (d) => created.push(d)),
    getWhisperRecipients: () => [{ id: "gm1" }],
  };
  globalThis.game = {
    user: { isGM: true, flags: { pf2e: { settings: {} } }, update: async () => {} },
    i18n: { format: (k) => k },
    messages: { contents: [] },
    combats: { contents: [] },
    modules: { get: () => ({ version: "9.9.9" }) },
  };
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function args(over = {}) {
  const mover = makeCombatant({ id: "m", name: "Greedspawn", x: 3 * G, y: 0 });
  const other = makeCombatant({ id: "f", name: "Fighter", x: 3 * G, y: 0, disposition: 1 });
  return {
    combat: makeCombat([mover, other]),
    combatant: mover,
    kind: "stepToward",
    posture: "approach",
    targetCombatant: other,
    startCell: { gx: 0, gy: 0 },
    goalCell: { gx: 3, gy: 0 },
    path: [{ gx: 0, gy: 0 }, { gx: 3, gy: 0 }],
    steps: [{ gx: 3, gy: 0 }],
    occupantsSnapshot: [{ gx: 3, gy: 0, gw: 1, gh: 1 }],
    speedSquares: 6,
    stopWithin: 1,
    gridSize: G,
    ...over,
  };
}

describe("reportMoveOverlap (#554)", () => {
  it("warns once and whispers one GM message with the payload on overlap", async () => {
    await reportMoveOverlap(args());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "pf2e-dungeon-crawl | move ended overlapping a combatant",
    );
    expect(created).toHaveLength(1);
    expect(created[0].whisper).toEqual(["gm1"]);
    expect(created[0].content).toContain(
      "Diagnostic #554: Greedspawn ended its stepToward on Fighter",
    );
    expect(created[0].content).toContain("<details>");
    expect(created[0].content).toContain('"kind": "stepToward"');
    expect(created[0].content).toContain('"steps"');
    expect(created[0].content).toContain('"occupantsChanged": false');
    expect(created[0].content).toContain('"finalCellWasPlanned": true');
    expect(created[0].content).toContain("9.9.9");
  });

  it("emits nothing without an overlap (defeated others don't count)", async () => {
    const a = args();
    a.combat.combatants[1].token.x = 5 * G;
    await reportMoveOverlap(a);
    const b = args();
    b.combat.combatants[1].isDefeated = true;
    await reportMoveOverlap(b);
    expect(warn).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("never throws on malformed data", async () => {
    await expect(reportMoveOverlap({})).resolves.toBeUndefined();
    const a = args();
    a.combatant.token = undefined;
    await expect(reportMoveOverlap(a)).resolves.toBeUndefined();
    await expect(
      reportMoveOverlap({ ...args(), combat: { combatants: null } }),
    ).resolves.toBeUndefined();
  });

  it("never throws when the chat post itself fails", async () => {
    ChatMessage.create.mockRejectedValue(new Error("boom"));
    await expect(reportMoveOverlap(args())).resolves.toBeUndefined();
  });

  it("flags occupantsChanged when a live footprint differs from the snapshot", async () => {
    await reportMoveOverlap(
      args({ occupantsSnapshot: [{ gx: 9, gy: 9, gw: 1, gh: 1 }] }),
    );
    expect(created[0].content).toContain('"occupantsChanged": true');
  });

  it("flags finalCellWasPlanned false when the live cell isn't the last step", async () => {
    await reportMoveOverlap(args({ steps: [{ gx: 2, gy: 0 }] }));
    expect(created[0].content).toContain('"finalCellWasPlanned": false');
  });
});

describe("real moves ending on a free cell emit no diagnostic (#554)", () => {
  it("strideByPosture", async () => {
    const mover = makeCombatant({ id: "m", x: 0, y: 0 });
    const target = makeCombatant({ id: "t", x: 8 * G, y: 0, disposition: 1 });
    const combat = makeCombat([mover, target]);
    vi.useFakeTimers();
    const p = strideByPosture(combat, mover, "approach", target);
    await vi.runAllTimersAsync();
    expect(await p).toBe("moved");
    expect(warn).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it("stepToward", async () => {
    const mover = makeCombatant({ id: "m", x: 0, y: 0 });
    const target = makeCombatant({ id: "t", x: 8 * G, y: 0, disposition: 1 });
    const combat = makeCombat([mover, target]);
    vi.useFakeTimers();
    const p = stepToward(combat, mover, target, 8);
    await vi.runAllTimersAsync();
    expect(await p).toBe("moved");
    expect(warn).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });
});
