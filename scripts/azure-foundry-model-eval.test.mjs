import { describe, expect, it } from "vitest";

import {
  conceptMatches,
  estimateCost,
  isRetryableRequestError,
  scoreItem,
} from "./azure-foundry-model-eval.mjs";

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

  it("keeps polarity handling scoped to forbidden matching", () => {
    expect(conceptMatches(["ready to send now"], "not ready to send now")).toBe(true);
    expect(conceptMatches(["ready to send now"], "not ready to send now", { polarityAware: true })).toBe(false);
  });

  it("retries transient fetch network failures", () => {
    expect(isRetryableRequestError(new TypeError("fetch failed"))).toBe(true);
  });
});
