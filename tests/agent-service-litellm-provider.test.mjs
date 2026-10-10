import { describe, it, expect, vi } from "vitest";
import { decide } from "../tools/agent-service/providers/litellm.mjs";

const CONTEXT = {
  self: { name: "Yamaraj", hp: 40, conditions: [] },
  opponents: [{ id: "opp1", name: "Fighter", distanceSquares: 1, hp: 30 }],
  candidates: [
    { id: "strike:claw:opp1", summary: "Claw vs Fighter (variant 0)" },
    { id: "endTurn", summary: "End turn" },
  ],
  roundNumber: 1,
};

function fakeFetch(toolArgs, { ok = true, status = 200, usage, headers } = {}) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    ...(headers ? { headers: new Headers(headers) } : {}),
    text: async () => JSON.stringify({ error: "boom" }),
    json: async () => ({
      ...(usage ? { usage } : {}),
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: "choose_action", arguments: JSON.stringify(toolArgs) } },
            ],
          },
        },
      ],
    }),
  });
}

describe("litellm provider decide()", () => {
  it("sends an OpenAI tool-call request to {baseUrl}/chat/completions with the fast model for a simple turn", async () => {
    const fetchImpl = fakeFetch({ candidateId: "strike:claw:opp1", rationale: "closest target" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://litellm:4000/v1/chat/completions");
    const body = JSON.parse(options.body);
    expect(body.model).toBe("fast");
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "choose_action",
        description: expect.any(String),
        parameters: expect.objectContaining({
          properties: expect.objectContaining({
            candidateId: { type: "string", enum: ["strike:claw:opp1", "endTurn"] },
          }),
        }),
      },
    });
    expect(JSON.stringify(body.messages)).toContain("Yamaraj");
  });

  it("requests the reasoning model when candidates.length is above the threshold", async () => {
    const manyCandidates = Array.from({ length: 10 }, (_, i) => ({ id: `strike:claw:opp${i}`, summary: `Claw vs opp${i}` }));
    const context = { ...CONTEXT, candidates: manyCandidates };
    const fetchImpl = fakeFetch({ candidateId: "strike:claw:opp0", rationale: "closest" });
    await decide(context, { baseUrl: "http://litellm:4000/v1", fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("reasoning");
  });

  it("sends a bearer token when an API key is configured", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", apiKey: "secret", fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe("Bearer secret");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("passes an AbortSignal so a stuck upstream call times out instead of hanging", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the chosen candidateId and rationale", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    const result = await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
    expect(result).toMatchObject({ candidateId: "endTurn", rationale: "no good options" });
  });

  it("throws if litellm picks a candidateId that was never offered", async () => {
    const fetchImpl = fakeFetch({ candidateId: "not-a-real-candidate", rationale: "oops" });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/not offered/);
  });

  it("throws a diagnosable error when the response is not ok", async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 502 });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/502/);
  });

  it("throws a clear error when there is no tool call in the response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: {} }] }),
    });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/no choose_action tool call/);
  });

  it("throws a clear error when the tool call arguments are not valid JSON", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { tool_calls: [{ function: { name: "choose_action", arguments: "{not json" } }] } }],
      }),
    });
    await expect(
      decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl }),
    ).rejects.toThrow(/litellm provider/);
  });

  it("uses an explicit model override instead of tier selection when provided", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", model: "mercury-decide", fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("mercury-decide");
  });

  it("still falls back to tier selection when no model override is given", async () => {
    const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "no good options" });
    await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("fast");
  });

  describe("decision meta (#952)", () => {
    const manyCandidates = {
      ...CONTEXT,
      candidates: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, summary: `Option ${i}` })),
    };

    it("reports the tier it asked for, and the proxy's real upstream model from its header", async () => {
      const fetchImpl = fakeFetch(
        { candidateId: "c3", rationale: "r" },
        { headers: { "x-litellm-model-name": "openrouter/nvidia/nemotron-3.5-lightning:free" } },
      );
      const result = await decide(manyCandidates, { baseUrl: "http://litellm:4000/v1", fetchImpl });
      expect(result.meta).toEqual({ tier: "reasoning", model: "openrouter/nvidia/nemotron-3.5-lightning:free" });
    });

    it("falls back to the tier alias as the model when the proxy sends no model header", async () => {
      const fetchImpl = fakeFetch({ candidateId: "endTurn", rationale: "r" });
      const result = await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
      expect(result.meta).toEqual({ tier: "fast", model: "fast" });
      expect(result.meta.usage).toBeUndefined();
      expect(result.meta.costUsd).toBeUndefined();
    });

    it("normalizes the payload's usage (the live proxy's real shape, cost included)", async () => {
      const fetchImpl = fakeFetch(
        { candidateId: "endTurn", rationale: "r" },
        { usage: { completion_tokens: 64, prompt_tokens: 1830, total_tokens: 1894, completion_tokens_details: {}, cost: 0.0112 } },
      );
      const result = await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
      expect(result.meta.usage).toEqual({ promptTokens: 1830, completionTokens: 64, totalTokens: 1894 });
      expect(result.meta.costUsd).toBe(0.0112);
    });

    it("uses the response-cost header when the payload reports no cost", async () => {
      const fetchImpl = fakeFetch(
        { candidateId: "endTurn", rationale: "r" },
        { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, headers: { "x-litellm-response-cost": "0.0004" } },
      );
      const result = await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
      expect(result.meta.costUsd).toBe(0.0004);
    });

    it("ignores a non-numeric cost header rather than reporting NaN", async () => {
      const fetchImpl = fakeFetch(
        { candidateId: "endTurn", rationale: "r" },
        { headers: { "x-litellm-response-cost": "n/a" } },
      );
      const result = await decide(CONTEXT, { baseUrl: "http://litellm:4000/v1", fetchImpl });
      expect(result.meta).not.toHaveProperty("costUsd");
    });
  });
});
