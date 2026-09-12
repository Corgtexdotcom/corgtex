import { describe, expect, it } from "vitest";
import { accountNavigationState } from "./view-model";

describe("view-model", () => {
  describe("accountNavigationState", () => {
    it("returns missing state for null account", () => {
      const result = accountNavigationState("ws-1", null);
      expect(result.isMissing).toBe(true);
      expect(result.isArchived).toBe(false);
      expect(result.href).toBeNull();
      expect(result.fallbackHref).toBe("/workspaces/ws-1/leads");
    });

    it("returns archived state for archived account", () => {
      const result = accountNavigationState("ws-1", { id: "acct-1", archivedAt: new Date() });
      expect(result.isMissing).toBe(false);
      expect(result.isArchived).toBe(true);
      expect(result.href).toBeNull();
      expect(result.fallbackHref).toBe("/workspaces/ws-1/leads");
    });

    it("returns archived state for archived account (string date)", () => {
      const result = accountNavigationState("ws-1", { id: "acct-1", archivedAt: new Date().toISOString() });
      expect(result.isMissing).toBe(false);
      expect(result.isArchived).toBe(true);
      expect(result.href).toBeNull();
      expect(result.fallbackHref).toBe("/workspaces/ws-1/leads");
    });

    it("returns active state with exact href for active account", () => {
      const result = accountNavigationState("ws-1", { id: "acct-1", archivedAt: null });
      expect(result.isMissing).toBe(false);
      expect(result.isArchived).toBe(false);
      expect(result.href).toBe("/workspaces/ws-1/leads/accounts/acct-1");
      expect(result.fallbackHref).toBe("/workspaces/ws-1/leads");
    });
  });
});
