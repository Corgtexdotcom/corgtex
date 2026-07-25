import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deploymentWorkspaceScopeSlug,
  filterWorkspacesForDeploymentScope,
} from "./deployment-workspace-scope";

const WORKSPACES = [
  { id: "ws-validation", slug: "corgtex-validation", name: "Corgtex Internal Validation" },
  { id: "ws-customer-alpha", slug: "customer-alpha", name: "Customer Alpha" },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("deployment workspace scope", () => {
  it("does not filter shared app workspaces even when a local seed slug is present", () => {
    vi.stubEnv("APP_URL", "https://app.corgtex.com");
    vi.stubEnv("WORKSPACE_SLUG", "customer-alpha");

    expect(deploymentWorkspaceScopeSlug()).toBeNull();
    expect(filterWorkspacesForDeploymentScope(WORKSPACES)).toEqual(WORKSPACES);
  });

  it("does not filter local development workspaces when WORKSPACE_SLUG is present", () => {
    vi.stubEnv("APP_URL", "http://localhost:3000");
    vi.stubEnv("WORKSPACE_SLUG", "customer-alpha");

    expect(deploymentWorkspaceScopeSlug()).toBeNull();
    expect(filterWorkspacesForDeploymentScope(WORKSPACES)).toEqual(WORKSPACES);
  });

  it("keeps only the configured workspace on dedicated customer deployments", () => {
    vi.stubEnv("APP_URL", "https://customer-alpha.corgtex.test");
    vi.stubEnv("WORKSPACE_SLUG", "customer-alpha");

    expect(deploymentWorkspaceScopeSlug()).toBe("customer-alpha");
    expect(filterWorkspacesForDeploymentScope(WORKSPACES)).toEqual([
      { id: "ws-customer-alpha", slug: "customer-alpha", name: "Customer Alpha" },
    ]);
  });

  it("does not filter Ops control-plane deployments", () => {
    vi.stubEnv("APP_URL", "https://ops.corgtex.com");
    vi.stubEnv("CONTROL_PLANE_MODE", "true");
    vi.stubEnv("WORKSPACE_SLUG", "customer-alpha");

    expect(deploymentWorkspaceScopeSlug()).toBeNull();
    expect(filterWorkspacesForDeploymentScope(WORKSPACES)).toEqual(WORKSPACES);
  });
});
