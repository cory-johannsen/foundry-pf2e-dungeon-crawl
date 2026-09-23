import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";

vi.mock("node:fs", () => ({
  readFileSync: () => {
    throw new Error("ENOENT: no such file");
  },
}));

const { generateCustomization } =
  await import("../tools/agent-service/customization-generator.mjs");

function fakeClaudeFetch(toolInput) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: "tool_use", name: "customize", input: toolInput }],
    }),
  });
}

describe("generateCustomization", () => {
  it("generates a trap name and description", async () => {
    const fetchImpl = fakeClaudeFetch({
      name: "The Weeping Door",
      description: "A door that drips illusory blood.",
    });
    const result = await generateCustomization(
      "trap",
      { actorId: "actor1", trapLevel: 3, partyLevel: 2 },
      { apiKey: "test-key", fetchImpl },
    );
    expect(result).toEqual({
      name: "The Weeping Door",
      description: "A door that drips illusory blood.",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0].input_schema.required).toEqual([
      "name",
      "description",
    ]);
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("generates a treasure room name and summary", async () => {
    const fetchImpl = fakeClaudeFetch({
      name: "The Cairn of the Unnamed",
      summary: "A quiet burial mound.",
    });
    const result = await generateCustomization(
      "treasure",
      { sceneId: "s1", roomId: "r1", locationTag: null },
      { apiKey: "test-key", fetchImpl },
    );
    expect(result).toEqual({
      name: "The Cairn of the Unnamed",
      summary: "A quiet burial mound.",
    });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.tools[0].input_schema.required).toEqual(["name", "summary"]);
  });

  it("generates skill-challenge flavor scoped to skillFlavor only", async () => {
    const fetchImpl = fakeClaudeFetch({
      name: "The Silent Vault",
      summary: "A vault sealed by an old ward.",
      skillFlavor: {
        athletics: "Force the ward apart.",
        arcana: "Unweave the ward.",
      },
    });
    const result = await generateCustomization(
      "skill_challenge",
      {
        sceneId: "s1",
        roomId: "r1",
        specialtySkills: ["athletics", "arcana"],
        locationTag: "vault",
      },
      { apiKey: "test-key", fetchImpl },
    );
    expect(result.skillFlavor).toEqual({
      athletics: "Force the ward apart.",
      arcana: "Unweave the ward.",
    });
  });

  it("generates narrative content scoped to the entry's own archetype fields", async () => {
    const fetchImpl = fakeClaudeFetch({
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
      { apiKey: "test-key", fetchImpl },
    );
    expect(result.options).toHaveLength(2);
    expect(result.revealText).toBeUndefined();
  });

  it("tells the model the archetype-to-field mapping for narrative entries", async () => {
    const fetchImpl = fakeClaudeFetch({
      name: "The Weeping Statue",
      summary: "An old statue remembers the fall of the keep.",
      revealText: "The keep fell not to siege, but to betrayal from within.",
    });
    await generateCustomization(
      "narrative",
      { sceneId: "s1", roomId: "r1", archetype: "lore" },
      { apiKey: "test-key", fetchImpl },
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const description = body.tools[0].description;
    expect(description).toMatch(/"lore"[^.]*revealText/);
  });

  it("throws a clear error when Claude returns no tool_use block", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [] }),
    });
    await expect(
      generateCustomization(
        "trap",
        { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
        { apiKey: "test-key", fetchImpl },
      ),
    ).rejects.toThrow(/no customize tool call/);
  });
});

function fakeLocalFetch(toolArgs) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "customize",
                  arguments: JSON.stringify(toolArgs),
                },
              },
            ],
          },
        },
      ],
    }),
  });
}

describe("generateCustomization — local provider", () => {
  it("generates a trap name and description via a local OpenAI-compatible endpoint", async () => {
    const fetchImpl = fakeLocalFetch({
      name: "The Weeping Door",
      description: "A door that drips illusory blood.",
    });
    const result = await generateCustomization(
      "trap",
      { actorId: "actor1", trapLevel: 3, partyLevel: 2 },
      {
        provider: "local",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5:3b-instruct",
        fetchImpl,
      },
    );
    expect(result).toEqual({
      name: "The Weeping Door",
      description: "A door that drips illusory blood.",
    });
  });

  it("sends an OpenAI-shaped tool-call request to {baseUrl}/chat/completions", async () => {
    const fetchImpl = fakeLocalFetch({ name: "x", description: "y" });
    await generateCustomization(
      "trap",
      { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
      {
        provider: "local",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5:3b-instruct",
        fetchImpl,
      },
    );
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("qwen2.5:3b-instruct");
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "customize",
        description: expect.any(String),
        parameters: expect.objectContaining({
          required: ["name", "description"],
        }),
      },
    });
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "customize" },
    });
  });

  it("sends a bearer token when a local API key is configured", async () => {
    const fetchImpl = fakeLocalFetch({ name: "x", description: "y" });
    await generateCustomization(
      "trap",
      { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
      {
        provider: "local",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5:3b-instruct",
        localApiKey: "secret-token",
        fetchImpl,
      },
    );
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer secret-token",
    );
  });

  it("uses an AbortSignal derived from the configured local timeout", async () => {
    const fetchImpl = fakeLocalFetch({ name: "x", description: "y" });
    await generateCustomization(
      "trap",
      { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
      {
        provider: "local",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5:3b-instruct",
        fetchImpl,
      },
    );
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("throws a clear error when LOCAL_LLM_BASE_URL is missing", async () => {
    await expect(
      generateCustomization(
        "trap",
        { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
        { provider: "local", model: "qwen2.5:3b-instruct", fetchImpl: vi.fn() },
      ),
    ).rejects.toThrow(/LOCAL_LLM_BASE_URL/);
  });

  it("throws a clear error when LOCAL_LLM_MODEL is missing", async () => {
    await expect(
      generateCustomization(
        "trap",
        { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
        {
          provider: "local",
          baseUrl: "http://localhost:11434/v1",
          fetchImpl: vi.fn(),
        },
      ),
    ).rejects.toThrow(/LOCAL_LLM_MODEL/);
  });

  it("throws a clear error for an unknown provider value", async () => {
    await expect(
      generateCustomization(
        "trap",
        { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
        { provider: "bogus", fetchImpl: vi.fn() },
      ),
    ).rejects.toThrow(/unknown.*provider/i);
  });

  it("throws a clear error when the local response has no tool call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: {} }] }),
    });
    await expect(
      generateCustomization(
        "trap",
        { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
        {
          provider: "local",
          baseUrl: "http://localhost:11434/v1",
          model: "qwen2.5:3b-instruct",
          fetchImpl,
        },
      ),
    ).rejects.toThrow(/no customize tool call/);
  });

  it("throws a clear error when the local tool call arguments are not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              tool_calls: [
                { function: { name: "customize", arguments: "{not json" } },
              ],
            },
          },
        ],
      }),
    });
    await expect(
      generateCustomization(
        "trap",
        { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
        {
          provider: "local",
          baseUrl: "http://localhost:11434/v1",
          model: "qwen2.5:3b-instruct",
          fetchImpl,
        },
      ),
    ).rejects.toThrow(/customization-generator/);
  });

  it("round-trips over a real HTTP connection when no fetchImpl is injected", async () => {
    // Regression coverage for a real, confirmed failure mode: Node's
    // built-in global fetch (undici) has its own internal headersTimeout
    // (default 300000ms) that isn't governed by the AbortSignal passed to
    // fetch() — a slow-but-legitimate local-model response can trip that
    // hidden watchdog before our own configured timeout, surfacing as a
    // confusing raw `UND_ERR_HEADERS_TIMEOUT` instead of respecting
    // LOCAL_LLM_TIMEOUT_MS. The local provider's default transport must
    // not be global fetch for this reason; this test exercises that
    // default (no fetchImpl override) against a real socket to prove the
    // wiring works end to end, not just against a mock.
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      function: {
                        name: "customize",
                        arguments: JSON.stringify({
                          name: "Real Door",
                          description: "A real HTTP round trip.",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    try {
      const result = await generateCustomization(
        "trap",
        { actorId: "actor1", trapLevel: 1, partyLevel: 1 },
        {
          provider: "local",
          baseUrl: `http://127.0.0.1:${port}`,
          model: "test-model",
        },
      );
      expect(result).toEqual({
        name: "Real Door",
        description: "A real HTTP round trip.",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
