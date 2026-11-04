import { describe, expect, it } from "vitest";
import { newspaperClickContinuation } from "./newspaper-click-continuation";

describe("newspaper click login continuation", () => {
  it("accepts only the exact relative click endpoint", () => {
    expect(newspaperClickContinuation("/api/newspaper/click/Ab0_-token")).toBe("/api/newspaper/click/Ab0_-token");
  });
  it.each([
    null, undefined, [], "/workspaces", "https://evil.test/api/newspaper/click/token",
    "//evil.test/api/newspaper/click/token", "/\\evil.test", "/es/api/newspaper/click/token",
    "/api/newspaper/click/", "/api/newspaper/click/token?next=https://evil.test",
    "/api/newspaper/click/token#fragment", "/api/newspaper/click/%2F%2Fevil.test",
    "/api/newspaper/click/token/..", "/api/newspaper/click/token\n", "/api/newspaper/click/" + "a".repeat(129),
  ])("rejects unsafe or unrelated continuation %j", (value) => {
    expect(newspaperClickContinuation(value)).toBeNull();
  });
});
