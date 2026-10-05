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

describe("#753 trap disable template", () => {
  const formAt = template.indexOf('class="pf2edc-dungeon__trap-disable-form"');
  const before = template.slice(0, formAt);

  it("has the trap block and form", () => {
    expect(formAt).toBeGreaterThan(-1);
    expect(template).toContain('data-action="attemptTrapDisable"');
  });

  it("form sits inside an interactive gate (not isGM) and a trap.detected gate", () => {
    expect(template.match(/\{\{#if isGM\}\}/g)?.length ?? 0).toBe(1);
    const blockStart = before.lastIndexOf('<div class="pf2edc-dungeon__trap">');
    expect(blockStart).toBeGreaterThan(-1);
    const inBlock = before.slice(blockStart);
    expect(inBlock).toContain("{{#if interactive}}");
    expect(inBlock).toContain("{{#if trap.detected}}");
    expect(inBlock.indexOf("{{#if interactive}}")).toBeLessThan(
      inBlock.indexOf("{{#if trap.detected}}"),
    );
  });

  it("not-detected hint renders in the else of trap.detected", () => {
    const hint = template.indexOf("PF2EDC.Dungeon.Trap.NotDetectedHint");
    expect(hint).toBeGreaterThan(formAt);
    expect(template.slice(formAt, hint)).toContain("{{else}}");
  });

  it("trap rooms keep the Succeed/Fail footer", () => {
    const trapBlock = template.indexOf('<div class="pf2edc-dungeon__trap">');
    expect(template.indexOf('data-action="succeed"')).toBeGreaterThan(trapBlock);
  });

  it.each([
    "DisableButton",
    "NotDetectedHint",
    "SkillLabel",
    "WhoLabel",
  ])("lang has non-empty PF2EDC.Dungeon.Trap.%s", (k) => {
    const v = lang[`PF2EDC.Dungeon.Trap.${k}`];
    expect(typeof v).toBe("string");
    expect(v.length).toBeGreaterThan(0);
  });
});

describe("#753 wiring", () => {
  it("dungeon-remote registers attemptTrapDisable routed to attemptTrapDisableForScene", () => {
    expect(remoteSource).toMatch(
      /attemptTrapDisable:\s*\(args\)\s*=>\s*attemptTrapDisableForScene\(args\.sceneId, args\.actorId, args\.skill\)/,
    );
  });

  it("dungeon-app registers the action, handler gates null results safely", () => {
    expect(appSource).toContain("attemptTrapDisable: DungeonApp.#onAttemptTrapDisable");
    // the handler never dereferences the (possibly null) roll result
    const h = appSource.slice(appSource.indexOf("static async #onAttemptTrapDisable"));
    const body = h.slice(0, h.indexOf("static async #onAttemptPuzzleStage"));
    expect(body).not.toMatch(/result\./);
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
});
