import { describe, expect, it } from "vitest";

import {
  AI_WORKSPACE_CAPABILITIES,
  AI_WORKSPACE_PROVIDER_KEYS,
  AI_WORKSPACE_PROVIDER_REGISTRY,
  ENTERPRISE_SERVICE_REGISTRY,
  aiWorkspaceProviderToDb,
  enterpriseServiceToDb,
  isAiWorkspaceProviderKey,
  isEnterpriseServiceKey,
  listAiWorkspaceProviders,
  listEnterpriseServices,
  requireAiWorkspaceProvider,
  requireEnterpriseService,
} from "./ai-workspaces";

describe("AI workspace provider registry", () => {
  it("keeps OpenWork as the recommended free default without excluding BYO providers", () => {
    const providers = listAiWorkspaceProviders();

    expect(providers.map((provider) => provider.key)).toEqual([
      "openwork",
      "chatgpt",
      "claude",
      "gemini",
      "cursor",
      "claude_code",
      "generic_mcp",
    ]);
    expect(AI_WORKSPACE_PROVIDER_REGISTRY.openwork).toMatchObject({
      recommendedDefault: true,
      freeDefault: true,
      setupPath: "guided",
    });
    expect(providers.filter((provider) => provider.recommendedDefault)).toHaveLength(1);
    expect(providers.filter((provider) => provider.category === "BYO").map((provider) => provider.key)).toEqual([
      "chatgpt",
      "claude",
    ]);
  });

  it("declares shared capabilities from a single registry", () => {
    expect(AI_WORKSPACE_CAPABILITIES).toContain("remote_mcp");
    expect(AI_WORKSPACE_CAPABILITIES).toContain("write_back");
    expect(AI_WORKSPACE_PROVIDER_REGISTRY.openwork.capabilities).toContain("skill_install");
    expect(AI_WORKSPACE_PROVIDER_REGISTRY.openwork.capabilities).toContain("hosted_worker");
    expect(AI_WORKSPACE_PROVIDER_REGISTRY.chatgpt.capabilities).toContain("remote_mcp");
    expect(AI_WORKSPACE_PROVIDER_REGISTRY.gemini.description).toContain("Consumer Gemini web support is not assumed");
  });

  it("normalizes provider keys to database enum values", () => {
    expect(AI_WORKSPACE_PROVIDER_KEYS.every((key) => isAiWorkspaceProviderKey(key))).toBe(true);
    expect(isAiWorkspaceProviderKey("cowork")).toBe(false);
    expect(requireAiWorkspaceProvider("claude").label).toBe("Claude");
    expect(aiWorkspaceProviderToDb("generic_mcp")).toBe("GENERIC_MCP");
    expect(() => requireAiWorkspaceProvider("cowork")).toThrow("Unsupported AI workspace provider");
  });
});

describe("enterprise service registry", () => {
  it("tracks managed services separately from execution clients", () => {
    const services = listEnterpriseServices();

    expect(services.map((service) => service.key)).toEqual([
      "meeting_recorder",
      "ai_workspace",
      "integrations",
      "workers",
      "support",
    ]);
    expect(ENTERPRISE_SERVICE_REGISTRY.meeting_recorder.outcome).toContain("meeting evidence");
    expect(ENTERPRISE_SERVICE_REGISTRY.ai_workspace.outcome).toContain("AI workspace plumbing");
    expect(services.every((service) => service.defaultOwnershipMode === "CUSTOMER_MANAGED")).toBe(true);
  });

  it("normalizes enterprise service keys to database enum values", () => {
    expect(isEnterpriseServiceKey("meeting_recorder")).toBe(true);
    expect(isEnterpriseServiceKey("recorder")).toBe(false);
    expect(requireEnterpriseService("workers").label).toBe("Managed workers");
    expect(enterpriseServiceToDb("ai_workspace")).toBe("AI_WORKSPACE");
    expect(() => requireEnterpriseService("recorder")).toThrow("Unsupported enterprise service");
  });
});
