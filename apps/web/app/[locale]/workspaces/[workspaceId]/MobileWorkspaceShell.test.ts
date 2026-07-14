import { describe, expect, it } from "vitest";

import { WORKSPACE_NAV_GROUPS, type NavGroup } from "@/lib/nav-config";
import {
  buildMobileNavModel,
  containsActiveNavItem,
  isActiveWorkspacePath,
  shouldHideMobileBottomNavForWorkspacePath,
} from "./mobile-nav-model";

function withoutModules(navGroups: NavGroup[], moduleKeys: string[]) {
  const hidden = new Set(moduleKeys);
  return navGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !hidden.has(item.moduleKey)),
    }))
    .filter((group) => group.items.length > 0);
}

describe("mobile workspace nav model", () => {
  it("derives primary mobile slots from registry-backed nav metadata", () => {
    const model = buildMobileNavModel(WORKSPACE_NAV_GROUPS, { reserveMoreSlot: true });

    expect(model.primaryItems.map((item) => item.moduleKey)).toEqual([
      "home",
      "tensions",
      "actions",
      "notifications",
    ]);
    expect(model.overflowGroups.flatMap((group) => group.items).map((item) => item.moduleKey)).toContain("proposals");
  });

  it("fills primary slots from visible registry order when priority modules are hidden", () => {
    const navGroups = withoutModules(WORKSPACE_NAV_GROUPS, ["tensions", "actions", "notifications"]);
    const model = buildMobileNavModel(navGroups, { reserveMoreSlot: true });

    expect(model.primaryItems.map((item) => item.moduleKey)).toEqual([
      "home",
      "proposals",
      "goals",
      "brain",
    ]);
  });

  it("matches active workspace paths with desktop exact/subpath semantics", () => {
    expect(isActiveWorkspacePath("/en/workspaces/ws-1/actions", "ws-1", "/actions")).toBe(true);
    expect(isActiveWorkspacePath("/en/workspaces/ws-1/actions/123", "ws-1", "/actions")).toBe(true);
    expect(isActiveWorkspacePath("/en/workspaces/ws-1/actions-archive", "ws-1", "/actions")).toBe(false);
    expect(isActiveWorkspacePath("/en/workspaces/ws-1", "ws-1", "")).toBe(true);
    expect(isActiveWorkspacePath("/en/workspaces/ws-1/actions", "ws-1", "")).toBe(false);
  });

  it("reports active overflow items for the More tab state", () => {
    const model = buildMobileNavModel(WORKSPACE_NAV_GROUPS, { reserveMoreSlot: true });

    expect(containsActiveNavItem(model.overflowGroups, "/workspaces/ws-1/proposals/new", "ws-1")).toBe(true);
    expect(containsActiveNavItem(model.overflowGroups, "/workspaces/ws-1/actions", "ws-1")).toBe(false);
  });

  it("hides the bottom nav on focused Action routes without hiding normal lists", () => {
    expect(shouldHideMobileBottomNavForWorkspacePath("/en/workspaces/ws-1/actions", "ws-1")).toBe(false);
    expect(shouldHideMobileBottomNavForWorkspacePath("/en/workspaces/ws-1/actions/action-1", "ws-1")).toBe(true);
    expect(shouldHideMobileBottomNavForWorkspacePath("/en/workspaces/ws-1/actions/action-1/edit", "ws-1")).toBe(true);
    expect(shouldHideMobileBottomNavForWorkspacePath("/en/workspaces/ws-1/add", "ws-1", "action")).toBe(true);
    expect(shouldHideMobileBottomNavForWorkspacePath("/en/workspaces/ws-1/add", "ws-1", "tension")).toBe(false);
    expect(shouldHideMobileBottomNavForWorkspacePath("/en/workspaces/ws-2/actions/action-1", "ws-1")).toBe(false);
  });
});
