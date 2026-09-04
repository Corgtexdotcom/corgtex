import { describe, expect, it } from "vitest";
import { releaseBuild } from "./write-release-build.mjs";
describe("image build identity", () => {
  it("binds the exact role and SHA at build time", () => {
    for (const role of ["web", "worker"]) expect(releaseBuild(role, { CORGTEX_RELEASE_GIT_SHA: "a".repeat(40) })).toEqual({ schemaVersion: 1, role, gitSha: "a".repeat(40) });
  });
  it("does not invent identity for local builds and rejects invalid build metadata", () => {
    expect(releaseBuild("web", {})).toEqual({ schemaVersion: 1, role: "web", gitSha: null });
    expect(() => releaseBuild("web", { CORGTEX_RELEASE_GIT_SHA: "main" })).toThrow();
    expect(() => releaseBuild("other", {})).toThrow();
  });
});
