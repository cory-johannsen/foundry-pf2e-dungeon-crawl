import { describe, it, expect } from "vitest";
import { validateSubjects, seedFor, partyPromptFor, partyNegativeFor, nextVersionedName,
         contactSheetLayout, buildApplyPlan, buildRevertPlan,
         actorReadScript, applyScript, revertScript, BANNED_SCRIPT_WORDS } from "../tools/party-art-lib.mjs";

describe("validateSubjects", () => {
  it("accepts good, rejects bad", () => {
    expect(validateSubjects([{ id: "cleric", who: "a leshy" }]).ok).toBe(true);
    expect(validateSubjects([{ id: "Cleric", who: "x" }]).ok).toBe(false);
    expect(validateSubjects([{ id: "a", who: "" }]).ok).toBe(false);
    expect(validateSubjects([{ id: "a", who: "x" }, { id: "a", who: "y" }]).ok).toBe(false);
    expect(validateSubjects({}).ok).toBe(false);
  });
});
describe("seedFor", () => {
  it("is deterministic, bounded, and varies with index and reroll (long ids too)", () => {
    const long = "a-very-long-party-subject-identifier";
    expect(seedFor("cleric", 0)).toBe(seedFor("cleric", 0));
    expect(new Set([0,1,2,3].map((i) => seedFor("cleric", i))).size).toBe(4);
    expect(seedFor(long, 0, 0)).not.toBe(seedFor(long, 0, 1));
    for (const s of [seedFor(long, 3, 9), seedFor("x", 0)]) { expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThan(2_000_000_000); expect(Number.isSafeInteger(s)).toBe(true); }
  });
});
describe("prompts", () => {
  it("composes from who + style, negative appends avoid", () => {
    expect(partyPromptFor({ who: "a halfling rogue" }, "STYLE")).toBe("Portrait bust of a halfling rogue, STYLE");
    expect(partyNegativeFor({ avoid: "beard" }, "NEG")).toBe("NEG, beard");
    expect(partyNegativeFor({}, "NEG")).toBe("NEG");
  });
});
describe("nextVersionedName", () => {
  it("starts at v2 and skips lookalikes", () => {
    expect(nextVersionedName(["cleric.webp"], "cleric")).toBe("cleric-v2.webp");
    expect(nextVersionedName(["cleric-v2.webp", "cleric-v10.webp", "cleric-vx.webp", "thief-v7.webp"], "cleric")).toBe("cleric-v11.webp");
    expect(nextVersionedName([], "thief")).toBe("thief-v2.webp");
  });
});
describe("contactSheetLayout", () => {
  it("one row per subject, count columns", () => {
    const l = contactSheetLayout([{ id: "a" }, { id: "b" }], 4, 512, 40);
    expect(l.width).toBe(2048); expect(l.height).toBe(2 * (512 + 40)); expect(l.tiles).toHaveLength(8);
    expect(l.tiles[5]).toMatchObject({ id: "b", index: 1, x: 512, y: 552 });
  });
});
describe("buildApplyPlan / buildRevertPlan", () => {
  const manifest = { subjects: { cleric: { candidates: [1,2,3,4] }, thief: { candidates: [1,2,3,4] } } };
  const actors = { cleric: { actorId: "A", tokens: [{ sceneId: "S", tokenId: "T1" }] }, thief: { actorId: "B", tokens: [] } };
  it("plans copies to the next free version and document updates", () => {
    const plan = buildApplyPlan({ picks: { cleric: 2, thief: 3 }, manifest, actors, existingFiles: ["cleric.webp", "thief.webp", "thief-v2.webp"], dataDir: "/d", stagingDir: "/s" });
    expect(plan.errors).toEqual([]);
    expect(plan.copies).toEqual([{ from: "/s/cleric/cand-2.webp", to: "/d/party-portraits/cleric-v2.webp" }, { from: "/s/thief/cand-3.webp", to: "/d/party-portraits/thief-v3.webp" }]);
    expect(plan.documentUpdates[0]).toMatchObject({ actorId: "A", img: "party-portraits/cleric-v2.webp", tokens: [{ sceneId: "S", tokenId: "T1" }] });
  });
  it("refuses unknown candidates and unmapped subjects", () => {
    expect(buildApplyPlan({ picks: { cleric: 9 }, manifest, actors, existingFiles: [], dataDir: "/d", stagingDir: "/s" }).errors.length).toBe(1);
    expect(buildApplyPlan({ picks: { ghost: 1 }, manifest, actors, existingFiles: [], dataDir: "/d", stagingDir: "/s" }).errors.length).toBe(1);
  });
  it("revert restores only ok tokens", () => {
    const r = buildRevertPlan({ entries: [{ id: "cleric", actorId: "A", oldImg: "party-portraits/cleric.webp", newImg: "x", tokens: [{ tokenId: "T1", sceneId: "S", oldSrc: "party-portraits/cleric.webp", ok: true }, { tokenId: "T2", sceneId: "S", oldSrc: "o", ok: false }] }] });
    expect(r.documentUpdates[0].tokens).toEqual([{ tokenId: "T1", sceneId: "S", oldSrc: "party-portraits/cleric.webp" }]);
    expect(r.documentUpdates[0].img).toBe("party-portraits/cleric.webp");
  });
});

describe("foundry-rest script builders", () => {
  const update = { actorId: "A", img: 'party-portraits/we"ird-v2.webp', proto: "party-portraits/old.webp", tokens: [{ sceneId: "S", tokenId: "T1", oldSrc: "party-portraits/old.webp" }] };
  const scripts = {
    read: actorReadScript(["A", "B"]),
    apply: applyScript(update),
    revert: revertScript(update),
  };
  for (const [name, text] of Object.entries(scripts)) {
    it(`${name} script contains no relay-banned word`, () => {
      for (const w of BANNED_SCRIPT_WORDS) expect(text.includes(w), w).toBe(false);
    });
  }
  it("embeds ids and paths via JSON.stringify so quoting cannot break", () => {
    expect(scripts.read).toContain(JSON.stringify(["A", "B"]));
    expect(scripts.apply).toContain(JSON.stringify(update.img));
    expect(scripts.apply).toContain(JSON.stringify("T1"));
    expect(scripts.revert).toContain(JSON.stringify("party-portraits/old.webp"));
  });
  it("apply updates actor img and prototype token, and each token", () => {
    expect(scripts.apply).toContain("prototypeToken.texture.src");
    expect(scripts.apply).toContain('"texture.src"');
  });
});
