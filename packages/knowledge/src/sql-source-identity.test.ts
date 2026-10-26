import { describe, expect, it } from "vitest";
import { sqlKnowledgeSourceId } from "./sql-source-identity";

describe("native SQL Knowledge source identity", () => {
  it("distinguishes colon-delimited table and key tuples", () => {
    expect(sqlKnowledgeSourceId("source", "public.a:b", "c")).not.toBe(sqlKnowledgeSourceId("source", "public.a", "b:c"));
    expect(sqlKnowledgeSourceId("source", "a", "b:c")).not.toBe(sqlKnowledgeSourceId("source:a", "b", "c"));
  });
  it("preserves a stable archive prefix and bounded ordinary identity", () => {
    const identity = sqlKnowledgeSourceId("source", "public.rows", "1");
    expect(identity).toMatch(/^byodb:source:v2:[a-f0-9]{64}$/);
    expect(sqlKnowledgeSourceId("source", "public.rows", "1")).toBe(identity);
    expect(sqlKnowledgeSourceId("other", "public.rows", "1")).not.toBe(identity);
  });
  it("retains exact case, Unicode, quotes, backslashes and empty tuple components", () => {
    const tuples = [["a", "b:c"], ["a:b", "c"], ["a", "B:c"], ["a", "b:cé"],
      ['a"', "b\\c"], ["a", '"b\\c'], ["", ":"], [":", ""], ["a", "é"], ["a", "e\u0301"]];
    expect(new Set(tuples.map(([table, key]) => sqlKnowledgeSourceId("source", table, key))).size).toBe(tuples.length);
  });
});
