import { describe, expect, it } from "vitest";
import { chunkText } from "./chunks";
import { cosineSimilarity } from "@corgtex/shared";

describe("knowledge helpers", () => {
  it("chunks paragraphs while preserving groupings under the max length", () => {
    const chunks = chunkText("Alpha paragraph.\n\nBeta paragraph.", 40);

    expect(chunks).toEqual(["Alpha paragraph.\n\nBeta paragraph."]);
  });

  it("splits oversized paragraphs into multiple chunks", () => {
    const chunks = chunkText("012345678901234567890123456789", 10, 2);

    expect(chunks).toEqual([
      "0123456789",
      "8901234567",
      "6789012345",
      "456789",
    ]);
  });

  it("computes cosine similarity for aligned vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });
});
