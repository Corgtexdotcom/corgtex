import { afterEach, describe, expect, it, vi } from "vitest";

import {
  callCandidateWithRetries,
  conceptMatches,
  estimateCost,
  isRetryableRequestError,
  parseCandidates,
  scoreItem,
} from "./azure-foundry-model-eval.mjs";

afterEach(() => {
  delete process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON;
  delete process.env.MODEL_API_KEY;
  delete process.env.MODEL_PRICE_OVERRIDES_JSON;
  vi.unstubAllGlobals();
});

describe("Azure Foundry model eval helpers", () => {
  it("preserves token metrics when candidate pricing is unavailable", () => {
    const cost = estimateCost(
      { provider: "azure-foundry", model: "unpriced-candidate" },
      { prompt_tokens: 12, completion_tokens: 5 },
      "short answer",
      { messages: [{ role: "user", content: "Prompt text" }] },
    );

    expect(cost).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      estimatedInputTokens: false,
      estimatedOutputTokens: false,
      rawProviderCostUsd: null,
    });
  });

  it("rejects invalid price overrides before reporting candidate cost", () => {
    process.env.MODEL_PRICE_OVERRIDES_JSON = JSON.stringify([
      { provider: "azure-foundry", model: "custom-candidate", inputUsdPerToken: -1, outputUsdPerToken: 0 },
    ]);

    expect(() => estimateCost(
      { provider: "azure-foundry", model: "custom-candidate" },
      { prompt_tokens: 2, completion_tokens: 3 },
      "answer",
      { messages: [{ role: "user", content: "Prompt" }] },
    )).toThrow("MODEL_PRICE_OVERRIDES_JSON[0].inputUsdPerToken must be a finite non-negative number");
  });

  it("includes known OpenAI rollback prices in cost estimates", () => {
    const cost = estimateCost(
      { provider: "openai", model: "gpt-4o" },
      { prompt_tokens: 10, completion_tokens: 4 },
      "answer",
      { messages: [{ role: "user", content: "Prompt" }] },
    );

    expect(cost.rawProviderCostUsd).toBe("0.000065");
  });

  it("requires parsed JSON before a JSON-mode case can pass", () => {
    const score = scoreItem({ mode: "json", requiredConcepts: ["ready"] }, "ready");

    expect(score.jsonParsed).toBe(false);
    expect(score.schemaValid).toBe(false);
    expect(score.passed).toBe(false);
  });

  it("requires standalone JSON before a JSON-mode case can pass", () => {
    const score = scoreItem(
      { mode: "json", requiredKeys: ["summary"] },
      "Here is the object: {\"summary\":\"Structured answer\"}",
    );

    expect(score.jsonParsed).toBe(false);
    expect(score.schemaValid).toBe(false);
    expect(score.passed).toBe(false);
  });

  it("scores JSON concepts from parsed values, not field names", () => {
    const score = scoreItem(
      {
        mode: "json",
        requiredKeys: ["unsafeToSend"],
        requiredConcepts: ["unsafe"],
      },
      "{\"unsafeToSend\":false,\"proposedReply\":\"Needs approval before sending.\"}",
    );

    expect(score.schemaValid).toBe(true);
    expect(score.missingConcepts).toEqual(["unsafe"]);
    expect(score.passed).toBe(false);
  });

  it("enforces required JSON values", () => {
    const score = scoreItem(
      {
        mode: "json",
        requiredKeys: ["replyNeeded", "unsafeToSend"],
        requiredJsonValues: {
          replyNeeded: true,
          unsafeToSend: true,
        },
      },
      "{\"replyNeeded\":true,\"unsafeToSend\":false}",
    );

    expect(score.incorrectJsonValues).toEqual(["unsafeToSend"]);
    expect(score.passed).toBe(false);
  });

  it("rejects scalar placeholders for required JSON arrays", () => {
    const item = {
      mode: "json",
      requiredKeys: ["actions"],
      requiredJsonShapes: {
        actions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            requiredKeys: ["title", "owner", "dueDate", "evidence"],
            properties: {
              title: { type: "string" },
              owner: { type: "string" },
              dueDate: { type: "string" },
              evidence: { type: "string" },
            },
          },
        },
      },
    };

    const scalarScore = scoreItem(item, "{\"actions\":\"Jordan buyer shortlist 2026-08-03\"}");
    expect(scalarScore.schemaValid).toBe(false);
    expect(scalarScore.invalidJsonShapes).toEqual(["actions must be an array"]);
    expect(scalarScore.passed).toBe(false);

    const wrongFieldTypeScore = scoreItem(item, "{\"actions\":[{\"title\":[\"Buyer shortlist\"],\"owner\":42,\"dueDate\":\"2026-08-03\",\"evidence\":{\"source\":\"Notes\"}}]}");
    expect(wrongFieldTypeScore.schemaValid).toBe(false);
    expect(wrongFieldTypeScore.invalidJsonShapes).toEqual([
      "actions[0].title must be a string",
      "actions[0].owner must be a string",
      "actions[0].evidence must be a string",
    ]);
    expect(wrongFieldTypeScore.passed).toBe(false);

    const nestedScore = scoreItem(item, "{\"actions\":[{\"title\":\"Buyer shortlist\",\"owner\":\"Jordan\",\"dueDate\":\"2026-08-03\",\"evidence\":\"Notes\"}]}");
    expect(nestedScore.schemaValid).toBe(true);
    expect(nestedScore.invalidJsonShapes).toEqual([]);
  });

  it("defaults OpenAI evaluation candidates to MODEL_API_KEY", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "OpenAI rollback",
        provider: "openai",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
      },
    ]);

    expect(parseCandidates()[0]).toMatchObject({
      provider: "openai",
      apiKeyEnv: "MODEL_API_KEY",
    });
  });

  it("rejects non-HTTPS evaluation candidate base URLs", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "OpenAI rollback",
        provider: "openai",
        model: "gpt-4o",
        baseUrl: "http://api.openai.test/v1",
      },
    ]);

    expect(() => parseCandidates()).toThrow("AZURE_FOUNDRY_EVAL_CANDIDATES_JSON[0].baseUrl must be an HTTPS URL");
  });

  it("rejects managed identity for non-Azure evaluation candidates", () => {
    process.env.AZURE_FOUNDRY_EVAL_CANDIDATES_JSON = JSON.stringify([
      {
        label: "OpenRouter rollback",
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        baseUrl: "https://openrouter.ai/api/v1",
        authMode: "managed_identity",
      },
    ]);

    expect(() => parseCandidates()).toThrow("authMode managed_identity is only supported for Azure candidates");
  });

  it("does not treat negated forbidden phrases as forbidden mentions", () => {
    const score = scoreItem({
      mode: "text",
      forbiddenConcepts: ["ready to send now"],
    }, "This is not ready to send now because legal approval is missing.");

    expect(score.forbiddenMentions).toEqual([]);
    expect(score.passed).toBe(true);
  });

  it("still catches unnegated forbidden phrases", () => {
    const score = scoreItem({
      mode: "text",
      forbiddenConcepts: ["ready to send now"],
    }, "The message is ready to send now.");

    expect(score.forbiddenMentions).toEqual(["ready to send now"]);
    expect(score.passed).toBe(false);
  });

  it("does not let a separate no-claim negate a forbidden assertion", () => {
    const score = scoreItem({
      mode: "text",
      forbiddenConcepts: ["ready to send now"],
    }, "No blockers remain and it is ready to send now.");

    expect(score.forbiddenMentions).toEqual(["ready to send now"]);
    expect(score.passed).toBe(false);
  });

  it("keeps polarity handling scoped to forbidden matching", () => {
    expect(conceptMatches(["ready to send now"], "not ready to send now")).toBe(true);
    expect(conceptMatches(["ready to send now"], "not ready to send now", { polarityAware: true })).toBe(false);
  });

  it("matches concepts on token boundaries", () => {
    expect(conceptMatches(["45"], "RidgeWorks has 145 operators")).toBe(false);
    expect(conceptMatches(["45 operators"], "RidgeWorks has 145 operators")).toBe(false);
    expect(conceptMatches(["45 operators"], "RidgeWorks has 45 operators")).toBe(true);
  });

  it("retries transient fetch network failures", () => {
    expect(isRetryableRequestError(new TypeError("fetch failed"))).toBe(true);
  });

  it("includes retry time in reported evaluation latency", async () => {
    process.env.MODEL_API_KEY = "model-key";
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "retry succeeded" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callCandidateWithRetries({
      label: "OpenAI rollback",
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://api.openai.test/v1",
      authMode: "api_key",
      apiKeyEnv: "MODEL_API_KEY",
      maxTokenParameter: "max_tokens",
      scope: "https://cognitiveservices.azure.com/.default",
      temperature: 0,
    }, {
      id: "retry-case",
      flow: "retry behavior",
      prompt: "Retry once.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.attempts).toBe(2);
    expect(result.retryCount).toBe(1);
    expect(result.latencyMs).toBeGreaterThanOrEqual(200);
    expect(result.finalAttemptLatencyMs).toBeLessThanOrEqual(result.latencyMs);
  });

  it("normalizes multipart candidate responses before scoring", async () => {
    process.env.MODEL_API_KEY = "model-key";
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{
        message: {
          content: [
            { type: "text", text: "{\"summary\":" },
            { type: "text", text: "\"Structured answer\"}" },
          ],
        },
      }],
      usage: { prompt_tokens: 2, completion_tokens: 3 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callCandidateWithRetries({
      label: "OpenAI rollback",
      provider: "openai",
      model: "gpt-4o",
      baseUrl: "https://api.openai.test/v1",
      authMode: "api_key",
      apiKeyEnv: "MODEL_API_KEY",
      maxTokenParameter: "max_tokens",
      scope: "https://cognitiveservices.azure.com/.default",
      temperature: 0,
    }, {
      id: "multipart-case",
      flow: "multipart response",
      prompt: "Return JSON.",
    });

    expect(result.text).toBe("{\"summary\":\n\"Structured answer\"}");
    expect(scoreItem({
      mode: "json",
      requiredKeys: ["summary"],
      requiredConcepts: ["Structured"],
    }, result.text).passed).toBe(true);
  });
});
