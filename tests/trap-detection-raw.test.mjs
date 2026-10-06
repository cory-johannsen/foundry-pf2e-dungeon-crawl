import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../scripts/dungeon-runner.mjs", () => ({ applyTrapRoomState: vi.fn() }));

const { handleTrapTokenMove, rollTrapDetection } = await import(
  "../scripts/trap-combat.mjs"
);

const MODULE_ID = "pf2e-dungeon-crawl";
const GRID = 100;

function makeHazardActor({ details = "", stealth = 13, flags = {} } = {}) {
  const f = { ...flags };
  return {
    id: "haz1",
    name: "Spiked Pit",
    flags: f,
    system: { attributes: { stealth: { value: stealth, details } } },
    getFlag: (m, k) => (m === MODULE_ID ? f[k] : undefined),
    setFlag: vi.fn(async (m, k, v) => {
      f[k] = v;
    }),
  };
}

function makeHazardToken(actor, gx, gy = 0) {
  const tok = {
    x: gx * GRID,
    y: gy * GRID,
    width: 1,
    height: 1,
    hidden: true,
    actor,
    flags: {},
    getFlag: (m, k) => (m === MODULE_ID && k === "trapHazard" ? true : tok.flags[k]),
    setFlag: vi.fn(async (m, k, v) => {
      tok.flags[k] = v;
    }),
    update: vi.fn(async (u) => Object.assign(tok, u)),
  };
  return tok;
}

function makeMover(hazards, gx, { gy = 0, actor, gridDistance = 5 } = {}) {
  const scene = { id: "scene1", grid: { size: GRID, distance: gridDistance }, tokens: hazards };
  scene.tokens.filter = Array.prototype.filter.bind(hazards);
  return {
    x: gx * GRID,
    y: gy * GRID,
    width: 1,
    height: 1,
    parent: scene,
    name: "Valeros",
    actor: actor ?? makePc(),
    object: {},
  };
}

function makePc({ id = "pc1", searching = false, rank = 1 } = {}) {
  return {
    id,
    name: "Valeros",
    perception: { rank },
    system: { exploration: searching ? ["s1"] : [] },
    items: [{ id: "s1", slug: "search" }],
  };
}

let detect, announce, whisperGM, base;
beforeEach(() => {
  detect = vi.fn(async () => ({ detected: false, dc: 23, outcome: "failure", total: 12 }));
  announce = vi.fn(async () => {});
  whisperGM = vi.fn(async () => {});
  base = {
    announce,
    whisperGM,
    isGM: () => true,
    isPartyActor: () => true,
    triggerTrap: vi.fn(async () => "success"),
    rollTrapDetection: detect,
    isCombatActive: () => false,
  };
});

const MOVE = { x: 1 };

describe("handleTrapTokenMove detection (#755)", () => {
  it("rolls once per character per hazard however often they move", async () => {
    const actor = makeHazardActor();
    const h = makeHazardToken(actor, 3);
    const pc = makePc();
    for (const gx of [0, 1, 2, 1, 0]) {
      await handleTrapTokenMove(makeMover([h], gx, { actor: pc }), MOVE, base);
    }
    expect(detect).toHaveBeenCalledOnce();
    expect(actor.flags.trapDetectionRolls).toEqual(["pc1"]);
  });

  it("a different character still gets their own roll", async () => {
    const actor = makeHazardActor();
    const h = makeHazardToken(actor, 3);
    await handleTrapTokenMove(makeMover([h], 0, { actor: makePc({ id: "a" }) }), MOVE, base);
    await handleTrapTokenMove(makeMover([h], 0, { actor: makePc({ id: "b" }) }), MOVE, base);
    expect(detect).toHaveBeenCalledTimes(2);
    expect(actor.flags.trapDetectionRolls).toEqual(["a", "b"]);
  });

  it("records the roll before rolling", async () => {
    const actor = makeHazardActor();
    const h = makeHazardToken(actor, 3);
    detect.mockImplementation(async () => {
      expect(actor.flags.trapDetectionRolls).toEqual(["pc1"]);
      return { detected: false, dc: 23, outcome: "failure", total: 1 };
    });
    await handleTrapTokenMove(makeMover([h], 0), MOVE, base);
    expect(detect).toHaveBeenCalledOnce();
  });

  describe("minimum proficiency hazard", () => {
    const details = "<p>(trained)</p>";
    it("Searching + sufficient rank rolls", async () => {
      const h = makeHazardToken(makeHazardActor({ details }), 3);
      await handleTrapTokenMove(
        makeMover([h], 0, { actor: makePc({ searching: true, rank: 1 }) }),
        MOVE,
        base,
      );
      expect(detect).toHaveBeenCalledOnce();
    });

    it("not Searching: no roll, not recorded, rolls later once Searching", async () => {
      const actor = makeHazardActor({ details });
      const h = makeHazardToken(actor, 3);
      const pc = makePc({ searching: false, rank: 2 });
      await handleTrapTokenMove(makeMover([h], 0, { actor: pc }), MOVE, base);
      expect(detect).not.toHaveBeenCalled();
      expect(actor.flags.trapDetectionRolls).toBeUndefined();
      pc.system.exploration = ["s1"];
      await handleTrapTokenMove(makeMover([h], 1, { actor: pc }), MOVE, base);
      expect(detect).toHaveBeenCalledOnce();
    });

    it("Searching but insufficient rank: no roll", async () => {
      const actor = makeHazardActor({ details: "<p>(expert)</p>" });
      const h = makeHazardToken(actor, 3);
      await handleTrapTokenMove(
        makeMover([h], 0, { actor: makePc({ searching: true, rank: 1 }) }),
        MOVE,
        base,
      );
      expect(detect).not.toHaveBeenCalled();
      expect(actor.flags.trapDetectionRolls).toBeUndefined();
    });

    it("an odd details string is treated as no minimum (any character rolls)", async () => {
      const h = makeHazardToken(
        makeHazardActor({ details: "<p>(or 0 if the trapdoor is disabled or broken)</p>" }),
        3,
      );
      await handleTrapTokenMove(makeMover([h], 0), MOVE, base);
      expect(detect).toHaveBeenCalledOnce();
    });
  });

  it("no-minimum hazard: any character rolls once, Search or not", async () => {
    const h = makeHazardToken(makeHazardActor({ details: "" }), 3);
    await handleTrapTokenMove(makeMover([h], 0, { actor: makePc({ searching: false, rank: 0 }) }), MOVE, base);
    expect(detect).toHaveBeenCalledOnce();
  });

  describe("30 ft range", () => {
    it("7 squares away: no roll, not recorded", async () => {
      const actor = makeHazardActor();
      const h = makeHazardToken(actor, 7);
      await handleTrapTokenMove(makeMover([h], 0), MOVE, base);
      expect(detect).not.toHaveBeenCalled();
      expect(actor.flags.trapDetectionRolls).toBeUndefined();
    });
    it("exactly 6 squares away: rolls", async () => {
      const h = makeHazardToken(makeHazardActor(), 6);
      await handleTrapTokenMove(makeMover([h], 0), MOVE, base);
      expect(detect).toHaveBeenCalledOnce();
    });
    it("honours scene.grid.distance (10 ft squares -> 3 squares)", async () => {
      const h = makeHazardToken(makeHazardActor(), 4);
      await handleTrapTokenMove(makeMover([h], 0, { gridDistance: 10 }), MOVE, base);
      expect(detect).not.toHaveBeenCalled();
      const h3 = makeHazardToken(makeHazardActor(), 3);
      await handleTrapTokenMove(makeMover([h3], 0, { gridDistance: 10 }), MOVE, base);
      expect(detect).toHaveBeenCalledOnce();
    });
  });

  it("no roll while a module combat is active", async () => {
    const actor = makeHazardActor();
    const h = makeHazardToken(actor, 3);
    await handleTrapTokenMove(makeMover([h], 0), MOVE, { ...base, isCombatActive: () => true });
    expect(detect).not.toHaveBeenCalled();
    expect(actor.flags.trapDetectionRolls).toBeUndefined();
  });

  it("failure: GM whisper only, nothing public, trap stays hidden/undetected", async () => {
    const actor = makeHazardActor();
    const h = makeHazardToken(actor, 3);
    await handleTrapTokenMove(makeMover([h], 0), MOVE, base);
    expect(whisperGM).toHaveBeenCalledOnce();
    expect(whisperGM.mock.calls[0][0]).toBe("PF2EDC.Dungeon.Trap.DetectionRollGM");
    expect(whisperGM.mock.calls[0][1]).toMatchObject({
      name: "Valeros",
      trap: "Spiked Pit",
      total: 12,
      dc: 23,
      outcome: "failure",
    });
    expect(announce).not.toHaveBeenCalled();
    expect(actor.flags.trapDetected).toBeUndefined();
    expect(h.hidden).toBe(true);
  });

  it("success: whisper + public line, trapDetected set, token unhidden", async () => {
    detect.mockResolvedValue({ detected: true, dc: 23, outcome: "success", total: 25 });
    const actor = makeHazardActor();
    const h = makeHazardToken(actor, 3);
    await handleTrapTokenMove(makeMover([h], 0), MOVE, base);
    expect(whisperGM).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledWith("PF2EDC.Dungeon.Trap.DetectedChat", {
      name: "Valeros",
      trap: "Spiked Pit",
    });
    expect(actor.flags.trapDetected).toBe(true);
    expect(h.hidden).toBe(false);
  });

  it("an already-detected trap is not rolled for", async () => {
    const h = makeHazardToken(makeHazardActor({ flags: { trapDetected: true } }), 3);
    await handleTrapTokenMove(makeMover([h], 0), MOVE, base);
    expect(detect).not.toHaveBeenCalled();
  });

  it("walking onto the trap still triggers it (no detection roll)", async () => {
    const h = makeHazardToken(makeHazardActor(), 1);
    await handleTrapTokenMove(makeMover([h], 1), MOVE, base);
    expect(base.triggerTrap).toHaveBeenCalledOnce();
    expect(detect).not.toHaveBeenCalled();
  });
});

describe("rollTrapDetection (#755)", () => {
  const passthrough = { suppress: (fn) => fn() };
  const seekerWith = (roll) => ({ perception: { roll: vi.fn(async () => roll) } });

  it("rolls secretly (createMessage:false) vs 10 + stealth", async () => {
    const seeker = seekerWith({ total: 20, degreeOfSuccess: 2 });
    const res = await rollTrapDetection(makeHazardActor({ stealth: 13 }), seeker, passthrough);
    expect(seeker.perception.roll).toHaveBeenCalledWith({
      dc: { value: 23 },
      createMessage: false,
    });
    expect(res).toEqual({ detected: true, dc: 23, outcome: "success", total: 20 });
  });

  it.each([
    [0, "criticalFailure", false],
    [1, "failure", false],
    [2, "success", true],
    [3, "criticalSuccess", true],
  ])("maps degreeOfSuccess %s to %s", async (degree, outcome, detected) => {
    const res = await rollTrapDetection(
      makeHazardActor(),
      seekerWith({ total: 5, degreeOfSuccess: degree }),
      passthrough,
    );
    expect(res.outcome).toBe(outcome);
    expect(res.detected).toBe(detected);
  });

  it("falls back to total vs DC when degreeOfSuccess is missing", async () => {
    // DC 23: <=13 crit fail, <23 fail, >=23 success, >=33 crit success
    const out = async (total) =>
      (await rollTrapDetection(makeHazardActor(), seekerWith({ total }), passthrough)).outcome;
    expect(await out(13)).toBe("criticalFailure");
    expect(await out(22)).toBe("failure");
    expect(await out(23)).toBe("success");
    expect(await out(33)).toBe("criticalSuccess");
  });

  it("does not read the outcome from chat messages", async () => {
    globalThis.game = { messages: { contents: [{ flags: { pf2e: { context: { outcome: "criticalSuccess" } } } }] } };
    try {
      const res = await rollTrapDetection(
        makeHazardActor(),
        seekerWith({ total: 1, degreeOfSuccess: 1 }),
        passthrough,
      );
      expect(res.outcome).toBe("failure");
    } finally {
      delete globalThis.game;
    }
  });
});

describe("lang (#755)", () => {
  const lang = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  it("has the GM whisper line with the placeholders the code passes", () => {
    const text = lang["PF2EDC.Dungeon.Trap.DetectionRollGM"];
    expect(text).toBeTruthy();
    for (const p of ["{name}", "{trap}", "{total}", "{dc}", "{outcome}"]) {
      expect(text).toContain(p);
    }
  });
  it("keeps the public success line", () => {
    expect(lang["PF2EDC.Dungeon.Trap.DetectedChat"]).toContain("{trap}");
  });
});
