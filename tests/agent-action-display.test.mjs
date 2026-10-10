import { describe, it, expect } from "vitest";
import {
  describeAgentAction,
  publicActionLabel,
  renderAgentTurnCardHtml,
  escapeHtml,
} from "../scripts/agent-action-display.mjs";

const names = { t1: "Goblin", t2: "Orc", a1: "Cleric" };
const nameOf = (id) => names[id] ?? null;
const describe2 = (candidate, result) => describeAgentAction(candidate, result, { nameOf });

describe("publicActionLabel", () => {
  it("strips target names, the MAP variant, mark annotations and pick rationale from summaries", () => {
    expect(publicActionLabel({ type: "strike", summary: "Dagger vs Goblin (variant 1) [marked: hunt-prey]" })).toBe("Dagger");
    expect(publicActionLabel({ type: "cast", summary: "Fear vs Goblin" })).toBe("Fear");
    expect(publicActionLabel({ type: "castArea", summary: "Fireball (hits Goblin, Orc)" })).toBe("Fireball");
    expect(publicActionLabel({ type: "castHeal", summary: "Heal on Cleric" })).toBe("Heal");
    expect(publicActionLabel({ type: "castDualHeal", summary: "Heal (2 actions) heals Cleric" })).toBe("Heal");
    expect(publicActionLabel({ type: "castDualArea", summary: "Heal (3 actions) harms Zombie; heals Cleric" })).toBe("Heal");
    expect(publicActionLabel({ type: "castTargetCount", summary: "Rebuke Death (2 actions) on Cleric, Fighter" })).toBe("Rebuke Death");
  });

  it("names maneuvers, feats and NPC abilities by their own label/name, never the model-supplied summary", () => {
    expect(publicActionLabel({ type: "maneuver", slug: "trip", summary: "Trip vs Goblin — secret plan" })).toBe("Trip");
    expect(publicActionLabel({ type: "feat", name: "Sudden Charge", summary: "Sudden Charge vs Goblin — secret plan" })).toBe("Sudden Charge");
    expect(publicActionLabel({ type: "npcAbility", name: "Frightful Presence", summary: "Frightful Presence (x) — plan" })).toBe("Frightful Presence");
  });

  it("uses fixed labels for movement, Seek and End turn", () => {
    expect(publicActionLabel({ type: "stride", posture: "approach", summary: "Move toward Goblin" })).toBe("Move toward");
    expect(publicActionLabel({ type: "stride", posture: "reposition" })).toBe("Move away from a hazard");
    expect(publicActionLabel({ type: "seek", summary: "Seek (Rogue)" })).toBe("Seek");
    expect(publicActionLabel({ type: "endTurn", summary: "End turn" })).toBe("End turn");
  });
});

describe("describeAgentAction", () => {
  it("describes a strike by the actor's attack outcome and names its target", () => {
    const c = { type: "strike", targetId: "t1", summary: "Dagger vs Goblin (variant 0)" };
    expect(describe2(c, "criticalSuccess")).toEqual({
      summary: "Dagger", targetId: "t1", targetName: "Goblin",
      result: { text: "critical hit", tone: "success" }, gmNote: null,
    });
    expect(describe2(c, "success").result).toEqual({ text: "hit", tone: "success" });
    expect(describe2(c, "failure").result).toEqual({ text: "miss", tone: "failure" });
    expect(describe2(c, "criticalFailure").result).toEqual({ text: "critical miss", tone: "failure" });
  });

  it("describes a strike skipped as out of reach", () => {
    const c = { type: "strike", targetId: "t1", summary: "Dagger vs Goblin" };
    expect(describe2(c, { skipped: "target out of reach" }).result).toEqual({ text: "not made (target out of reach)", tone: "neutral" });
  });

  it("describes castAttack like a strike", () => {
    expect(describe2({ type: "castAttack", targetId: "t1", summary: "Ray vs Goblin" }, "success").result)
      .toEqual({ text: "hit", tone: "success" });
  });

  it("describes single-target save spells by the TARGET's save, with the tone from the caster's side", () => {
    for (const type of ["cast", "castDebuff", "castDualHarm"]) {
      const c = { type, targetId: "t1", summary: "Fear vs Goblin" };
      expect(describe2(c, "failure").result).toEqual({ text: "failed save", tone: "success" });
      expect(describe2(c, "criticalSuccess").result).toEqual({ text: "saved (critical)", tone: "failure" });
    }
  });

  it("describes area/multi-target saves per target, naming each, with an aggregate tone", () => {
    for (const type of ["castArea", "castAreaTier", "breathWeapon", "castChain", "castAutoHitAreaTier"]) {
      const d = describe2({ type, summary: "Fireball (hits Goblin, Orc)", targetId: "t1" }, [
        { targetId: "t1", outcome: "failure" },
        { targetId: "t2", outcome: "success" },
      ]);
      expect(d.result).toEqual({ text: "Goblin: failed save; Orc: saved", tone: "neutral" });
      expect(d.targetName).toBeNull();
    }
    expect(describe2({ type: "castArea" }, [{ targetId: "t1", outcome: "criticalFailure" }]).result)
      .toEqual({ text: "Goblin: failed save (critical)", tone: "success" });
  });

  it("describes castAutoHitAreaTier's no-save tier by damage dealt", () => {
    expect(describe2({ type: "castAutoHitAreaTier" }, [{ targetId: "t1", total: 20 }]).result)
      .toEqual({ text: "Goblin: 20 damage", tone: "success" });
  });

  it("describes castDualArea's mixed harm/heal entries and castTargetCount's heal entries", () => {
    expect(describe2({ type: "castDualArea" }, [
      { targetId: "t1", effect: "harm", outcome: "failure" },
      { targetId: "a1", effect: "heal", healed: 9 },
    ]).result).toEqual({ text: "Goblin: failed save; Cleric: healed 9", tone: "success" });
    expect(describe2({ type: "castTargetCount" }, [{ targetId: "a1", healed: null }]).result)
      .toEqual({ text: "Cleric: no healing", tone: "neutral" });
  });

  it("describes a multi-strike bundle one clause per strike", () => {
    expect(describe2({ type: "multiStrike", targetId: "t1", summary: "Frenzy vs Goblin" }, [
      { actionSlug: "claw", outcome: "success" },
      { actionSlug: "claw", outcome: "failure" },
    ]).result).toEqual({ text: "hit, miss", tone: "neutral" });
  });

  it("describes heals by amount and buffs by effect name", () => {
    expect(describe2({ type: "castHeal", targetId: "a1" }, 12).result).toEqual({ text: "healed 12", tone: "success" });
    expect(describe2({ type: "castDualHeal", targetId: "a1" }, 20).result).toEqual({ text: "healed 20", tone: "success" });
    expect(describe2({ type: "castHeal", targetId: "a1" }, null).result).toEqual({ text: "no healing", tone: "neutral" });
    expect(describe2({ type: "castBuff", targetId: "a1" }, "Bless").result).toEqual({ text: "gained Bless", tone: "success" });
    expect(describe2({ type: "castBuff", targetId: "a1" }, null).result).toEqual({ text: "no effect", tone: "neutral" });
  });

  it("describes strides by status; a blocked one carries the GM-only stall note", () => {
    const c = { type: "stride", posture: "approach", targetId: "t1" };
    expect(describe2(c, "moved").result).toEqual({ text: "moved", tone: "neutral" });
    expect(describe2(c, "moved").targetName).toBe("Goblin");
    const blocked = describe2(c, "blocked");
    expect(blocked.result).toEqual({ text: "blocked", tone: "failure" });
    expect(blocked.gmNote).toMatch(/every reachable square is occupied/);
    expect(describe2(c, "no-route").result).toEqual({ text: "no route", tone: "neutral" });
    expect(describe2(c, "no-route").gmNote).toBeNull();
  });

  it("#931: a stride a reaction disrupted reads as 'move disrupted' with a GM-only note", () => {
    const disrupted = describe2({ type: "stride", posture: "approach", targetId: "t1" }, "disrupted");
    expect(disrupted.result).toEqual({ text: "move disrupted", tone: "failure" });
    expect(disrupted.gmNote).toMatch(/reaction disrupted the move/);
  });

  it("describes Seek by how many detection states changed", () => {
    expect(describe2({ type: "seek" }, [{ from: "hidden", to: "observed" }, { from: "hidden", to: "hidden" }]).result)
      .toEqual({ text: "1 detection change", tone: "success" });
    expect(describe2({ type: "seek" }, []).result).toEqual({ text: "found nothing new", tone: "neutral" });
  });

  it("describes a maneuver by its check outcome plus what applyManeuverOutcome returned", () => {
    const c = { type: "maneuver", slug: "trip", targetId: "t1", summary: "Trip vs Goblin — rationale" };
    const d = describe2(c, { outcome: "success", text: "target is Prone" });
    expect(d).toMatchObject({ summary: "Trip", targetName: "Goblin", result: { text: "success: target is Prone", tone: "success" } });
    expect(describe2(c, { outcome: "criticalFailure", text: "attacker falls Prone" }).result.tone).toBe("failure");
    expect(describe2(c, { outcome: null, text: "no check result", gmNote: "resolve manually" }))
      .toMatchObject({ result: { text: "no check result", tone: "neutral" }, gmNote: "resolve manually" });
  });

  it("describes feats by their executor's text, Strike outcomes or effect name", () => {
    const base = { type: "feat", name: "Lunge", targetId: "t1" };
    expect(describe2({ ...base, kind: "composite" }, { performed: true, attacks: 1, strikeOutcomes: ["success"] }).result)
      .toEqual({ text: "hit", tone: "success" });
    expect(describe2({ ...base, kind: "composite" }, { performed: true, attacks: 0, strikeOutcomes: [] }).result)
      .toEqual({ text: "no Strike made", tone: "neutral" });
    expect(describe2({ type: "feat", kind: "selfEffect", name: "Rage", targetId: null }, { performed: true, effectName: "Effect: Rage" }))
      .toMatchObject({ targetName: null, result: { text: "gained Effect: Rage", tone: "success" } });
    expect(describe2({ ...base, kind: "targetedSelfEffect" }, { performed: true, text: "hunts Goblin as prey", gmNote: "d20 = 14" }))
      .toMatchObject({ result: { text: "hunts Goblin as prey", tone: "success" }, gmNote: "d20 = 14" });
  });

  it("describes an NPC ability per target from its executor's results, keeping the GM note", () => {
    const d = describe2(
      { type: "npcAbility", name: "Frightful Presence", affectedIds: ["t1", "t2"] },
      {
        performed: true,
        results: [
          { targetId: "t1", outcome: "failure", applied: "frightened 1" },
          { targetId: "t2", text: "immune" },
        ],
        gmNote: "Will DC 20",
      },
    );
    expect(d.result).toEqual({ text: "Goblin: failed save -- frightened 1; Orc: immune", tone: "neutral" });
    expect(d.gmNote).toBe("Will DC 20");
    expect(d.targetName).toBeNull();
    const single = describe2({ type: "npcAbility", name: "Gaze", targetId: "t1", affectedIds: ["t1"] }, { performed: true, results: [] });
    expect(single.targetName).toBe("Goblin");
  });

  it("describes a movement ability's move and Strike (#932)", () => {
    const cand = { type: "npcMove", kind: "strike", name: "Swoop", targetId: "t1", summary: "Swoop: Fly ... — plan" };
    expect(publicActionLabel(cand)).toBe("Swoop");
    const hit = describe2(cand, { performed: true, moveStatus: "moved", attacks: 1, strikeOutcomes: ["success"], gmNote: "Used its fly Speed" });
    expect(hit).toMatchObject({ summary: "Swoop", targetName: "Goblin", result: { text: "moved; hit", tone: "success" }, gmNote: "Used its fly Speed" });
    expect(describe2(cand, { performed: true, moveStatus: "moved", strikeOutcomes: [], strikeSkipped: "target out of reach" }).result)
      .toEqual({ text: "moved; no Strike (target out of reach)", tone: "neutral" });
    expect(describe2(cand, { performed: true, moveStatus: "disrupted", strikeOutcomes: [], strikeSkipped: "move disrupted" }).result)
      .toEqual({ text: "move disrupted; no Strike (move disrupted)", tone: "failure" });
    expect(describe2({ type: "npcMove", kind: "teleport", name: "Jaunt", targetId: "t1" }, { performed: true, moveStatus: "teleported", strikeOutcomes: [] }).result)
      .toEqual({ text: "teleported", tone: "neutral" });
  });

  it("describes a Strike-plus ability, per target when it has several (#933)", () => {
    const single = { type: "npcStrike", shape: "strikeAgainstGrabbed", name: "Death Roll", targetId: "t1", targetIds: ["t1"], summary: "Death Roll: jaws Strike on grabbed Goblin — r" };
    expect(publicActionLabel(single)).toBe("Death Roll");
    const one = describe2(single, { performed: true, attacks: 1, results: [{ targetId: "t1", text: "hit; prone", tone: "success" }], gmNote: null });
    expect(one).toMatchObject({ summary: "Death Roll", targetName: "Goblin", result: { text: "hit; prone", tone: "success" } });
    const multi = { type: "npcStrike", shape: "singleRollMultiAC", name: "Wide Swing", targetId: "t1", targetIds: ["t1", "t2"] };
    const two = describe2(multi, {
      performed: true,
      results: [
        { targetId: "t1", text: "hit", tone: "success" },
        { targetId: "t2", text: "miss", tone: "failure" },
      ],
      gmNote: "One attack roll (25) compared to each target's AC.",
    });
    expect(two).toMatchObject({ targetName: null, result: { text: "Goblin: hit; Orc: miss", tone: "neutral" }, gmNote: "One attack roll (25) compared to each target's AC." });
  });

  it("describes a monster self-buff or self-heal by its name, with no target (#934)", () => {
    const buff = { type: "npcSelf", family: "selfEffectAction", name: "Form a Phalanx", targetId: null, summary: "Form a Phalanx: self-buff: +ac; lasts 1 rounds — brace" };
    expect(publicActionLabel(buff)).toBe("Form a Phalanx");
    expect(describe2(buff, { performed: true, attacks: 0, text: "gains Effect: Form a Phalanx", tone: "success" }))
      .toMatchObject({ summary: "Form a Phalanx", targetName: null, result: { text: "gains Effect: Form a Phalanx", tone: "success" }, gmNote: null });
    const heal = { type: "npcSelf", family: "selfHeal", name: "Feed on Fear", targetId: null };
    expect(describe2(heal, { performed: true, healed: 5, text: "heals 5 HP", tone: "success", gmNote: "Consume Light recharging (1d4 rounds), per Feed on Fear." }))
      .toMatchObject({ result: { text: "heals 5 HP", tone: "success" }, gmNote: "Consume Light recharging (1d4 rounds), per Feed on Fear." });
    expect(describe2(heal, undefined).result).toEqual({ text: "done", tone: "neutral" });
  });

  it("describes endTurn", () => {
    expect(describe2({ type: "endTurn", summary: "End turn" }, undefined).result).toEqual({ text: "ends turn", tone: "neutral" });
  });

  it("falls back to a neutral 'done' for unknown types and unreadable results, never throwing", () => {
    expect(describe2({ type: "someFutureType", summary: "x" }, "whatever").result).toEqual({ text: "done", tone: "neutral" });
    expect(describe2({ type: "strike", summary: "x" }, { unexpected: true }).result).toEqual({ text: "done", tone: "neutral" });
    expect(describe2({ type: "strike", summary: "x" }, undefined).result).toEqual({ text: "done", tone: "neutral" });
    expect(describe2({ type: "castArea" }, "nonsense").result).toEqual({ text: "done", tone: "neutral" });
    expect(describe2({ type: "maneuver", slug: "trip" }, 7).result).toEqual({ text: "done", tone: "neutral" });
    expect(() => describeAgentAction(null, null)).not.toThrow();
    expect(describeAgentAction({ type: "strike", targetId: "t1" }, "hit", { nameOf: () => { throw new Error("x"); } }).targetName).toBeNull();
  });
});

describe("renderAgentTurnCardHtml", () => {
  const record = (over = {}) => ({
    index: 0, cost: 1, summary: "Dagger", target: { id: "t1", name: "Goblin" },
    result: { text: "hit", tone: "success" }, gmNote: null, rationale: null, source: "model", visibility: "all",
    ...over,
  });

  it("renders rows in index order with the round", () => {
    const html = renderAgentTurnCardHtml({ round: 3, records: [record({ index: 1, summary: "Second" }), record({ index: 0, summary: "First" })] });
    expect(html).toContain("Round 3");
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
    expect(html).toContain("pf2edc-agent-result-success");
    expect(html).toContain("Goblin");
    expect(html).toContain('<span class="action-glyph">1</span>');
  });

  it("puts rationale and the GM note only inside data-visibility=\"gm\" elements", () => {
    const html = renderAgentTurnCardHtml({ round: 1, records: [record({ rationale: "Closest target.", gmNote: "DC 20\nApply by hand" })] });
    expect(html).toContain('<div data-visibility="gm" class="pf2edc-agent-rationale"><em>Closest target.</em></div>');
    expect(html).toContain('<div data-visibility="gm" class="pf2edc-agent-note">DC 20<br>Apply by hand</div>');
  });

  it("omits rationale/note entirely (no empty element) when absent", () => {
    const html = renderAgentTurnCardHtml({ round: 1, records: [record()] });
    expect(html).not.toContain("data-visibility");
  });

  it("tags fallback decisions GM-only and hides rows whose token was hidden", () => {
    const html = renderAgentTurnCardHtml({ round: 1, records: [record({ source: "fallback", visibility: "gm" })] });
    expect(html).toContain('<li class="pf2edc-agent-action" data-visibility="gm">');
    expect(html).toContain('<span data-visibility="gm" class="pf2edc-agent-fallback">(fallback heuristic)</span>');
  });

  it("escapes hostile text in summary, target, result and rationale", () => {
    const html = renderAgentTurnCardHtml({
      round: 1,
      records: [record({ summary: "<script>a", target: { name: "<b>x" }, result: { text: "<i>", tone: "bogus" }, rationale: "<img onerror=1>" })],
    });
    expect(html).not.toMatch(/<script|<b>|<i>|<img/);
    expect(html).toContain("pf2edc-agent-result-neutral");
    expect(escapeHtml(`<"'&>`)).toBe("&lt;&quot;'&amp;&gt;");
  });
});
