import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../scripts/dungeon-runner.mjs", () => ({ applyTrapRoomState: vi.fn() }));

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const template = read("../templates/dungeon-tracker.hbs");
const lang = JSON.parse(read("../lang/en.json"));
const appSource = read("../scripts/ui/dungeon-app.mjs");
const remoteSource = read("../scripts/dungeon-remote.mjs");

const MODULE_ID = "pf2e-dungeon-crawl";
const { attemptTrapDisableForScene } = await import("../scripts/trap-combat.mjs");

describe("#754 tracker disable form removed", () => {
  it("template has no trap block, form or action", () => {
    expect(template).not.toContain("pf2edc-dungeon__trap-disable-form");
    expect(template).not.toContain('<div class="pf2edc-dungeon__trap">');
    expect(template).not.toContain("attemptTrapDisable");
    expect(template).not.toContain("trap.hasHazard");
    expect(template).not.toContain("trap.detected");
    expect(template).not.toContain("trap.disableChecks");
  });

  it("trap rooms keep the Succeed/Fail footer", () => {
    expect(template).toContain('data-action="succeed"');
    expect(template).toContain('data-action="fail"');
  });

  it.each(["DisableButton", "NotDetectedHint", "SkillLabel", "WhoLabel"])(
    "removed lang key PF2EDC.Dungeon.Trap.%s is gone",
    (k) => {
      expect(lang[`PF2EDC.Dungeon.Trap.${k}`]).toBeUndefined();
    },
  );

  it.each(["DetectedChat", "DisableSuccessChat", "DisableFailureChat", "TriggeredChat"])(
    "lang keeps PF2EDC.Dungeon.Trap.%s and uses only {name}/{trap}",
    (k) => {
      const v = lang[`PF2EDC.Dungeon.Trap.${k}`];
      expect(typeof v).toBe("string");
      expect(v.length).toBeGreaterThan(0);
      const used = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(used.sort()).toEqual(["name", "trap"]);
    },
  );
});

describe("#753 remote wiring", () => {
  it("dungeon-remote registers attemptTrapDisable routed to attemptTrapDisableForScene", () => {
    expect(remoteSource).toMatch(
      /attemptTrapDisable:\s*\(args\)\s*=>\s*attemptTrapDisableForScene\(args\.sceneId, args\.actorId, args\.skill, \{\s*requestingUserId: args\.requestingUserId,?\s*\}\)/,
    );
    expect(remoteSource).toMatch(
      /msg\.actionName === "attemptTrapDisable"/,
    );
  });

  it("dungeon-app no longer has the tracker handler, action or imports", () => {
    expect(appSource).not.toContain("onAttemptTrapDisable");
    expect(appSource).not.toContain("attemptTrapDisable");
    expect(appSource).not.toContain("attemptTrapDisableForScene");
    expect(appSource).not.toContain("classifyTrap");
    expect(appSource).not.toContain("hasHazard");
    expect(appSource).toContain("isTrapRoom");
    expect(appSource).toMatch(/name: raw\.name,\s*description: raw\.description,/);
  });
});

describe("attemptTrapDisableForScene", () => {
  let hazardActor;
  let scene;
  beforeEach(() => {
    hazardActor = { getFlag: () => undefined, system: { details: { disable: "" } } };
    const token = {
      getFlag: (m, k) => (m === MODULE_ID && k === "trapHazard" ? true : undefined),
      actor: hazardActor,
    };
    scene = { tokens: { find: (fn) => [token].find(fn) } };
    globalThis.game = {
      scenes: { get: (id) => (id === "s1" ? scene : undefined) },
      actors: { get: (id) => (id === "a1" ? { id: "a1", skills: {} } : undefined) },
    };
  });

  it("null for unknown scene", async () => {
    expect(await attemptTrapDisableForScene("nope", "a1", "thievery")).toBeNull();
  });
  it("null when no hazard token", async () => {
    scene.tokens = { find: () => undefined };
    expect(await attemptTrapDisableForScene("s1", "a1", "thievery")).toBeNull();
  });
  it("null when the hazard already triggered", async () => {
    hazardActor.getFlag = (m, k) => k === "trapTriggered";
    expect(await attemptTrapDisableForScene("s1", "a1", "thievery")).toBeNull();
  });
  it("null when no actor", async () => {
    expect(await attemptTrapDisableForScene("s1", null, "thievery")).toBeNull();
    expect(await attemptTrapDisableForScene("s1", "zz", "thievery")).toBeNull();
  });
  it("null (no throw) when the actor lacks the skill / no disable check", async () => {
    expect(await attemptTrapDisableForScene("s1", "a1", "thievery")).toBeNull();
  });

  describe("disable announcements", () => {
    const run = async (result) => {
      const announce = vi.fn(async () => {});
      hazardActor.name = "Spiked Pit";
      globalThis.game.actors.get = () => ({ id: "a1", name: "Amiri", skills: {} });
      const out = await attemptTrapDisableForScene("s1", "a1", "thievery", {
        rollTrapDisableAttempt: async () => result,
        announce,
      });
      return { out, announce };
    };

    it("announces success", async () => {
      const { out, announce } = await run({ disabled: true });
      expect(out).toEqual({ disabled: true });
      expect(announce).toHaveBeenCalledWith("PF2EDC.Dungeon.Trap.DisableSuccessChat", {
        name: "Amiri",
        trap: "Spiked Pit",
      });
    });
    it("announces failure", async () => {
      const { announce } = await run({ disabled: false });
      expect(announce).toHaveBeenCalledWith("PF2EDC.Dungeon.Trap.DisableFailureChat", {
        name: "Amiri",
        trap: "Spiked Pit",
      });
    });
    it("a null result posts nothing", async () => {
      const { out, announce } = await run(null);
      expect(out).toBeNull();
      expect(announce).not.toHaveBeenCalled();
    });
  });
});

describe("#754 attemptTrapDisableForScene outcomes and authorization", () => {
  let hazardActor, hazardToken, scene, pcToken, flags;
  const announce = vi.fn(async () => {});
  const pc = { id: "a1", name: "Amiri", skills: {}, ownership: { u1: 3 } };
  beforeEach(() => {
    announce.mockClear();
    flags = {};
    hazardActor = {
      id: "haz",
      name: "Spiked Pit",
      getFlag: (m, k) => flags[k],
      setFlag: vi.fn(async (m, k, v) => {
        flags[k] = v;
      }),
    };
    const tflags = {};
    hazardToken = {
      actor: hazardActor,
      flags: tflags,
      getFlag: (m, k) => (k === "trapHazard" ? true : tflags[k]),
      setFlag: vi.fn(async (m, k, v) => {
        tflags[k] = v;
      }),
    };
    pcToken = { actor: pc, object: { id: "pcobj" }, getFlag: () => undefined };
    const all = [hazardToken, pcToken];
    scene = { tokens: { find: (fn) => all.find(fn) } };
    globalThis.game = {
      scenes: { get: () => scene },
      actors: { get: () => pc, party: { members: [pc] } },
      users: { get: (id) => ({ id, isGM: false }) },
    };
  });
  const go = (result, extra = {}) => {
    const triggerTrap = vi.fn(async () => "success");
    const rollTrapDisableAttempt = vi.fn(async () => result);
    return attemptTrapDisableForScene("s1", "a1", "thievery", {
      rollTrapDisableAttempt,
      triggerTrap,
      announce,
      ...extra,
    }).then((out) => ({ out, triggerTrap, rollTrapDisableAttempt }));
  };

  it("critical failure triggers once on the attempter's token, marks both spent, announces once", async () => {
    const { triggerTrap } = await go({ disabled: false, outcome: "criticalFailure" });
    expect(triggerTrap).toHaveBeenCalledOnce();
    expect(triggerTrap).toHaveBeenCalledWith(hazardActor, { actor: pc, token: pcToken.object });
    expect(flags.trapTriggered).toBe(true);
    expect(hazardToken.flags.trapSpent).toBe(true);
    expect(announce).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledWith("PF2EDC.Dungeon.Trap.TriggeredChat", {
      name: "Amiri",
      trap: "Spiked Pit",
    });
  });

  it("critical failure cannot double-fire concurrently", async () => {
    const triggerTrap = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const r = { disabled: false, outcome: "criticalFailure" };
    await Promise.all([go(r, { triggerTrap }), go(r, { triggerTrap })]);
    expect(triggerTrap).toHaveBeenCalledOnce();
  });

  it("success marks the hazard token spent and does not trigger", async () => {
    const { triggerTrap } = await go({ disabled: true, outcome: "success" });
    expect(triggerTrap).not.toHaveBeenCalled();
    expect(hazardToken.flags.trapSpent).toBe(true);
    expect(flags.trapTriggered).toBeUndefined();
  });

  it("plain failure leaves the trap clickable", async () => {
    const { triggerTrap } = await go({ disabled: false, outcome: "failure" });
    expect(triggerTrap).not.toHaveBeenCalled();
    expect(hazardToken.flags.trapSpent).toBeUndefined();
    expect(flags.trapTriggered).toBeUndefined();
    expect(announce).toHaveBeenCalledWith("PF2EDC.Dungeon.Trap.DisableFailureChat", expect.anything());
  });

  it("a spent trap is not attempted again", async () => {
    hazardToken.flags.trapSpent = true;
    const { out, rollTrapDisableAttempt } = await go({ disabled: true });
    expect(out).toBeNull();
    expect(rollTrapDisableAttempt).not.toHaveBeenCalled();
  });

  it("null roll posts nothing", async () => {
    const { out } = await go(null);
    expect(out).toBeNull();
    expect(announce).not.toHaveBeenCalled();
  });

  it("omitted requestingUserId is a trusted direct call", async () => {
    const { out } = await go({ disabled: true, outcome: "success" });
    expect(out).not.toBeNull();
  });

  it("relayed owner of a party character is allowed", async () => {
    const { out } = await go({ disabled: true, outcome: "success" }, { requestingUserId: "u1", isHost: () => false });
    expect(out).not.toBeNull();
  });

  it("relayed non-owner is refused: null and no roll", async () => {
    const { out, rollTrapDisableAttempt } = await go({ disabled: true }, { requestingUserId: "u2", isHost: () => false });
    expect(out).toBeNull();
    expect(rollTrapDisableAttempt).not.toHaveBeenCalled();
  });

  it("relayed owner of a non-party actor is refused", async () => {
    globalThis.game.actors.party.members = [];
    const { out, rollTrapDisableAttempt } = await go({ disabled: true }, { requestingUserId: "u1", isHost: () => false });
    expect(out).toBeNull();
    expect(rollTrapDisableAttempt).not.toHaveBeenCalled();
  });
});

describe("#754 populateSlotTrap wiring", () => {
  const sceneSource = read("../scripts/dungeon-scene.mjs");
  it("stores trapDisableChecks on the hazard token after spawn", () => {
    const body = sceneSource.slice(sceneSource.indexOf("export async function populateSlotTrap"));
    expect(body).toContain('"trapDisableChecks"');
    expect(body).toContain("classifyTrap(");
    expect(body).toContain("spawned.tokenId");
  });
});
