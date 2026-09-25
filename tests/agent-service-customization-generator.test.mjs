import { describe, it, expect, vi } from "vitest";

vi.mock("node:fs", () => ({
  readFileSync: () => {
    throw new Error("ENOENT: no such file");
  },
}));

const { generateCustomization } = await import("../tools/agent-service/customization-generator.mjs");

function fakeFetch(toolArgs, { ok = true, status = 200 } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    text: async () => JSON.stringify({ error: "boom" }),
    json: async () => ({
      choices: [
        { message: { tool_calls: [{ function: { name: "customize", arguments: JSON.stringify(toolArgs) } }] } },
      ],
    }),
  });
}

const OPTS = { baseUrl: "http://litellm:4000/v1", fetchImpl: null };

describe("generateCustomization", () => {
  it("generates a trap name and description at the fast tier", async () => {
    const fetchImpl = fakeFetch({ name: "The Weeping Door", description: "A door that drips illusory blood." });
    const result = await generateCustomization(
      "trap",
      { actorId: "actor1", trapLevel: 3, partyLevel: 2 },
      { ...OPTS, fetchImpl },
    );
    expect(result).toEqual({ name: "The Weeping Door", description: "A door that drips illusory blood." });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://litellm:4000/v1/chat/completions");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("fast");
    expect(body.tools[0].function.parameters.required).toEqual(["name", "description"]);
  });

  it("generates a treasure room name and summary at the fast tier", async () => {
    const fetchImpl = fakeFetch({ name: "The Cairn of the Unnamed", summary: "A quiet burial mound." });
    const result = await generateCustomization(
      "treasure",
      { sceneId: "s1", roomId: "r1", locationTag: null },
      { ...OPTS, fetchImpl },
    );
    expect(result).toEqual({ name: "The Cairn of the Unnamed", summary: "A quiet burial mound." });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("fast");
  });

  it("generates skill-challenge flavor at the reasoning tier, scoped to skillFlavor only", async () => {
    const fetchImpl = fakeFetch({
      name: "The Silent Vault",
      summary: "A vault sealed by an old ward.",
      skillFlavor: { athletics: "Force the ward apart.", arcana: "Unweave the ward." },
    });
    const result = await generateCustomization(
      "skill_challenge",
      { sceneId: "s1", roomId: "r1", specialtySkills: ["athletics", "arcana"], locationTag: "vault" },
      { ...OPTS, fetchImpl },
    );
    expect(result.skillFlavor).toEqual({ athletics: "Force the ward apart.", arcana: "Unweave the ward." });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("reasoning");
  });

  it("generates narrative content at the reasoning tier, scoped to the entry's own archetype fields", async () => {
    const fetchImpl = fakeFetch({
      name: "A Fork in the Tunnel",
      summary: "Two passages, one choice.",
      options: [
        { label: "Take the low path", consequence: "Faster, riskier." },
        { label: "Take the high path", consequence: "Slower, safer." },
      ],
    });
    const result = await generateCustomization(
      "narrative",
      { sceneId: "s1", roomId: "r1", archetype: "choice" },
      { ...OPTS, fetchImpl },
    );
    expect(result.options).toHaveLength(2);
    expect(result.revealText).toBeUndefined();
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("reasoning");
  });

  it("tells the model the archetype-to-field mapping for narrative entries", async () => {
    const fetchImpl = fakeFetch({
      name: "The Weeping Statue",
      summary: "An old statue remembers the fall of the keep.",
      revealText: "The keep fell not to siege, but to betrayal from within.",
    });
    await generateCustomization("narrative", { sceneId: "s1", roomId: "r1", archetype: "lore" }, { ...OPTS, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0].function.description).toMatch(/"lore"[^.]*revealText/);
  });

  it("sends an OpenAI-shaped tool-call request", async () => {
    const fetchImpl = fakeFetch({ name: "x", description: "y" });
    await generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "customize",
        description: expect.any(String),
        parameters: expect.objectContaining({ required: ["name", "description"] }),
      },
    });
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "customize" } });
  });

  it("sends a bearer token when an API key is configured", async () => {
    const fetchImpl = fakeFetch({ name: "x", description: "y" });
    await generateCustomization(
      "trap",
      { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
      { ...OPTS, apiKey: "secret-token", fetchImpl },
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer secret-token");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    const fetchImpl = fakeFetch({ name: "x", description: "y" });
    await generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("passes an AbortSignal derived from the configured timeout", async () => {
    const fetchImpl = fakeFetch({ name: "x", description: "y" });
    await generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("throws a clear error for an unknown kind", async () => {
    await expect(
      generateCustomization("not-a-real-kind", {}, { ...OPTS, fetchImpl: vi.fn() }),
    ).rejects.toThrow(/unknown kind/);
  });

  it("throws a clear error when the response is not ok", async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 502 });
    await expect(
      generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl }),
    ).rejects.toThrow(/502/);
  });

  it("throws a clear error when there is no tool call in the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: {} }] }) });
    await expect(
      generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl }),
    ).rejects.toThrow(/no customize tool call/);
  });

  it("throws a clear error when the tool call arguments are not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { tool_calls: [{ function: { name: "customize", arguments: "{not json" } }] } }] }),
    });
    await expect(
      generateCustomization("trap", { actorId: "actor1", trapLevel: 1, partyLevel: 1 }, { ...OPTS, fetchImpl }),
    ).rejects.toThrow(/customization-generator/);
  });
});
