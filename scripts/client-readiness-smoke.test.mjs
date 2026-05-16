import { describe, expect, it, vi } from "vitest";

import {
  isWorkspaceUrl,
  submitLoginForm,
  visibleLoginErrorMessage,
  waitForLoginResult,
} from "./client-readiness-smoke.mjs";

function locator(items) {
  return {
    count: vi.fn(async () => items.length),
    nth: vi.fn((index) => ({
      isVisible: vi.fn(async () => Boolean(items[index]?.visible)),
      textContent: vi.fn(async () => items[index]?.text ?? null),
    })),
  };
}

function page({ url = "http://localhost/login", errors = [] } = {}) {
  return {
    url: vi.fn(() => url),
    locator: vi.fn(() => locator(errors)),
    screenshot: vi.fn(async () => null),
    waitForLoadState: vi.fn(async () => null),
    waitForTimeout: vi.fn(async () => null),
    click: vi.fn(async () => null),
  };
}

describe("client readiness smoke login handling", () => {
  it("recognizes localized workspace URLs", () => {
    expect(isWorkspaceUrl("http://localhost/workspaces/workspace-1")).toBe(true);
    expect(isWorkspaceUrl("http://localhost/es/workspaces/workspace-1/settings")).toBe(true);
    expect(isWorkspaceUrl("http://localhost/login")).toBe(false);
  });

  it("ignores empty visible alert regions and returns the first visible message", async () => {
    await expect(
      visibleLoginErrorMessage(page({
        errors: [
          { visible: true, text: "" },
          { visible: false, text: "Hidden error" },
          { visible: true, text: "Invalid email or password." },
        ],
      })),
    ).resolves.toBe("Invalid email or password.");
  });

  it("reports visible login errors instead of timing out on workspace navigation", async () => {
    const fakePage = page({
      errors: [{ visible: true, text: "Invalid email or password." }],
    });

    await expect(waitForLoginResult(fakePage)).rejects.toThrow("Login failed: Invalid email or password.");
    expect(fakePage.screenshot).toHaveBeenCalledWith(expect.objectContaining({
      path: expect.stringContaining("login-failed.png"),
    }));
  });

  it("enforces login failure handling while the submit click is still pending", async () => {
    const fakePage = page({
      errors: [{ visible: true, text: "Invalid email or password." }],
    });
    fakePage.click = vi.fn(() => new Promise(() => {}));

    await expect(submitLoginForm(fakePage)).rejects.toThrow("Login failed: Invalid email or password.");
    expect(fakePage.click).toHaveBeenCalledWith('button[type="submit"]', { noWaitAfter: true });
  });

  it("returns after workspace navigation", async () => {
    const fakePage = page({ url: "http://localhost/es/workspaces/workspace-1" });

    await expect(waitForLoginResult(fakePage)).resolves.toBeUndefined();
    expect(fakePage.waitForLoadState).toHaveBeenCalledWith("domcontentloaded", { timeout: 5000 });
    expect(fakePage.screenshot).not.toHaveBeenCalled();
  });
});
