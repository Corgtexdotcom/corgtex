import { describe, expect, it } from "vitest";
import { workspaceRouteMatches, workspaceStepUrl } from "./onboarding-tour-routing";

describe("onboarding tour routing", () => {
  it("matches localized workspace routes against locale-free tour targets", () => {
    expect(workspaceRouteMatches(
      "/en/workspaces/ws-1",
      workspaceStepUrl("ws-1", "/"),
    )).toBe(true);
    expect(workspaceRouteMatches(
      "/es/workspaces/ws-1/tools?type=TOOL&q=meeting%20recorder",
      workspaceStepUrl("ws-1", "/tools?type=TOOL&q=meeting%20recorder"),
    )).toBe(true);
  });

  it("keeps query strings significant when continuing tour navigation", () => {
    expect(workspaceRouteMatches(
      "/en/workspaces/ws-1/settings?tab=data-sources",
      workspaceStepUrl("ws-1", "/settings?tab=general"),
    )).toBe(false);
  });
});

