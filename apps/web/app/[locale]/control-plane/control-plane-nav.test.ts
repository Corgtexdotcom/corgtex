import { describe, expect, it } from "vitest";
import { controlPlaneNavGroups, getControlPlaneBreadcrumbs, isControlPlaneNavItemActive } from "./control-plane-nav";

describe("workspace-first operations navigation", () => {
  const items = controlPlaneNavGroups.flatMap((group) => group.items);
  const workspaces = items.find((item) => item.key === "dashboard")!;
  const deployments = items.find((item) => item.key === "customers")!;

  it("leads with workspaces and keeps deployments independently reachable", () => {
    expect(items[0]).toBe(workspaces);
    expect(workspaces.href).toBe("/control-plane");
    expect(deployments.href).toBe("/control-plane/deployments");
    expect(items.find((item) => item.key === "selfServe")?.href).toBe("/control-plane/self-serve");
  });

  it.each(["", "/en", "/es"])("resolves workspace and retained deployment details with locale %s", (locale) => {
    for (const path of ["/control-plane", "/control-plane/workspaces", "/control-plane/workspaces/local-id"]) {
      expect(isControlPlaneNavItemActive(`${locale}${path}`, workspaces)).toBe(true);
      expect(isControlPlaneNavItemActive(`${locale}${path}`, deployments)).toBe(false);
    }
    expect(isControlPlaneNavItemActive(`${locale}/control-plane/deployments/remote-id`, deployments)).toBe(true);
    expect(isControlPlaneNavItemActive(`${locale}/control-plane/deployments/remote-id`, workspaces)).toBe(false);
    expect(getControlPlaneBreadcrumbs(`${locale}/control-plane/workspaces/local-id`).at(-1))
      .toEqual({ labelKey: "nav.details", href: "/control-plane/workspaces/local-id" });
  });
});
