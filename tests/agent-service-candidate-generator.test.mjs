// tests/agent-service-candidate-generator.test.mjs
import { describe, it, expect, vi } from "vitest";

const { generateCombatCandidates } = await import("../tools/agent-service/candidate-generator.mjs");

function fakeFetch(toolArgs, { ok = true, status = 200 } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify({ error: "boom" }),
    json: async () => ({
      choices: [
        { message: { tool_calls: [{ function: { name: "propose_candidates", arguments: JSON.stringify(toolArgs) } }] } },
      ],
    }),
  });
}

const OPTS = { baseUrl: "http://litellm:4000/v1" };
const context = { self: { id: "atk1" }, opponents: [{ id: "opp1", name: "Goblin" }], allies: [], roundNumber: 2 };
const vocabulary = [
  { type: "maneuver", slug: "trip", targetId: "opp1" },
  { type: "maneuver", slug: "demoralize", targetId: "opp1" },
];

describe("generateCombatCandidates", () => {
  it("returns the picks array from the tool call, posting to litellm's chat/completions route", async () => {
    const fetchImpl = fakeFetch({ picks: [{ type: "maneuver", slug: "trip", targetId: "opp1", rationale: "Knock it down before it flees." }] });
    const result = await generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl });
    expect(result).toEqual({ picks: [{ type: "maneuver", slug: "trip", targetId: "opp1", rationale: "Knock it down before it flees." }] });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://litellm:4000/v1/chat/completions");
    const body = JSON.parse(options.body);
    expect(body.tools[0].function.name).toBe("propose_candidates");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "propose_candidates" } });
  });

  it("sends the context and vocabulary in the user message content", async () => {
    const fetchImpl = fakeFetch({ picks: [] });
    await generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const content = body.messages[0].content;
    expect(content).toContain("opp1");
    expect(content).toContain("trip");
  });

  it("tells the model how to read a selfEffect entry's effectSummary/durationLabel/frequencyLabel (#914)", async () => {
    const fetchImpl = fakeFetch({ picks: [] });
    await generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl });
    const content = JSON.parse(fetchImpl.mock.calls[0][1].body).messages[0].content;
    expect(content).toContain("effectSummary");
    expect(content).toContain("durationLabel");
    expect(content).toContain("frequencyLabel");
  });

  it("tells the model what a targetedSelfEffect entry (Hunt Prey, Devise a Stratagem) does (#922)", async () => {
    const fetchImpl = fakeFetch({ picks: [] });
    await generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl });
    const content = JSON.parse(fetchImpl.mock.calls[0][1].body).messages[0].content;
    expect(content).toContain('kind "targetedSelfEffect"');
    expect(content).toContain("Hunt Prey");
    expect(content).toContain("Devise a Stratagem");
  });

  it("returns an empty picks array when the model proposes none", async () => {
    const fetchImpl = fakeFetch({ picks: [] });
    const result = await generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl });
    expect(result).toEqual({ picks: [] });
  });

  it("builds the slug enum dynamically from the vocabulary actually sent, not a fixed list", async () => {
    const vocab = [
      { type: "maneuver", slug: "trip", targetId: "opp1" },
      { type: "feat", slug: "rage", targetId: null },
    ];
    const fetchImpl = fakeFetch({ picks: [] });
    await generateCombatCandidates(context, vocab, { ...OPTS, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const itemProps = body.tools[0].function.parameters.properties.picks.items.properties;
    expect(itemProps.slug.enum).toEqual(["trip", "rage"]);
    expect(itemProps.type.enum).toEqual(["maneuver", "feat"]);
    // #910: self-effect feat picks are self-targeted and send targetId null.
    expect(itemProps.targetId.type).toEqual(["string", "null"]);
  });

  it("dedupes repeated slugs/types across multiple vocabulary entries", async () => {
    const vocab = [
      { type: "maneuver", slug: "trip", targetId: "opp1" },
      { type: "maneuver", slug: "trip", targetId: "opp2" },
    ];
    const fetchImpl = fakeFetch({ picks: [] });
    await generateCombatCandidates(context, vocab, { ...OPTS, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const itemProps = body.tools[0].function.parameters.properties.picks.items.properties;
    expect(itemProps.slug.enum).toEqual(["trip"]);
    expect(itemProps.type.enum).toEqual(["maneuver"]);
  });

  it("tells the model how to treat feat/class-action entries (#910)", async () => {
    const fetchImpl = fakeFetch({ picks: [] });
    await generateCombatCandidates(context, [{ type: "feat", slug: "rage", targetId: null }], { ...OPTS, fetchImpl });
    const content = JSON.parse(fetchImpl.mock.calls[0][1].body).messages[0].content;
    expect(content).toMatch(/feat/i);
    expect(content).toMatch(/stance/i);
  });

  it("puts npcAbility in the type enum and tells the model how to read an NPC-ability entry (#915)", async () => {
    const vocab = [{ type: "npcAbility", itemId: "i1", slug: "terrifying-display", targetId: null, affectedIds: ["opp1"], summary: "will DC 27" }];
    const fetchImpl = fakeFetch({ picks: [] });
    await generateCombatCandidates(context, vocab, { ...OPTS, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0].function.parameters.properties.picks.items.properties.type.enum).toEqual(["npcAbility"]);
    const content = body.messages[0].content;
    expect(content).toContain('type "npcAbility"');
    expect(content).toMatch(/affectedIds/);
    expect(content).toMatch(/summary/);
  });

  it("throws when the upstream request fails", async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 500 });
    await expect(generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl })).rejects.toThrow(
      /request failed \(500\)/,
    );
  });

  it("throws when the response carries no propose_candidates tool call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: {} }] }) });
    await expect(generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl })).rejects.toThrow(
      /no propose_candidates tool call/,
    );
  });

  it("throws when the tool call arguments are not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "propose_candidates", arguments: "{not json" } }] } }] }),
    });
    await expect(generateCombatCandidates(context, vocabulary, { ...OPTS, fetchImpl })).rejects.toThrow(
      /not valid JSON/,
    );
  });
});
