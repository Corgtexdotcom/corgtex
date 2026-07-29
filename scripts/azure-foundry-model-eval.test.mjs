import { afterEach, describe, expect, it } from "vitest";

import {
  conceptMatches,
  estimateCost,
  isRetryableRequestError,
  scoreItem,
} from "./azure-foundry-model-eval.mjs";

afterEach(() => {
  delete process.env.MODEL_PRICE_OVERRIDES_JSON;
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

  it("requires parsed JSON before a JSON-mode case can pass", () => {
    const score = scoreItem({ mode: "json", requiredConcepts: ["ready"] }, "ready");

    expect(score.jsonParsed).toBe(false);
    expect(score.schemaValid).toBe(false);
    expect(score.passed).toBe(false);
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

  it("retries transient fetch network failures", () => {
    expect(isRetryableRequestError(new TypeError("fetch failed"))).toBe(true);
  });
});
