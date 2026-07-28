import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import {
  activateMobileAskTab,
  activateMobileMode,
  activateMobileWorkspaceMode,
  coreRouteCatalog,
  demoAddGuardRouteSuffix,
  isFindAccountUrl,
  isWorkspaceUrl,
  labelConsoleEntry,
  localePrefixFromUrl,
  optionalRouteCatalog,
  resolveSelectedWorkspace,
  submitLoginForm,
  visibleLoginErrorMessage,
  waitForLoginResult,
  workspacePathFromUrl,
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

  it("recognizes account-picker redirects and extracts localized workspace paths", () => {
    expect(isFindAccountUrl("http://localhost/find-account")).toBe(true);
    expect(isFindAccountUrl("http://localhost/en/find-account")).toBe(true);
    expect(isFindAccountUrl("http://localhost/en/workspaces/workspace-1")).toBe(false);
    expect(localePrefixFromUrl("http://localhost/en/find-account")).toBe("/en");
    expect(localePrefixFromUrl("http://localhost/workspaces/workspace-1")).toBe("");
    expect(workspacePathFromUrl("http://localhost/en/workspaces/workspace-1/settings")).toBe("/workspaces/workspace-1");
    expect(workspacePathFromUrl("http://localhost/en/find-account")).toBe(null);
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

  it("returns after authenticated account-picker navigation", async () => {
    const fakePage = page({ url: "http://localhost/en/find-account" });

    await expect(waitForLoginResult(fakePage)).resolves.toBeUndefined();
    expect(fakePage.waitForLoadState).toHaveBeenCalledWith("domcontentloaded", { timeout: 5000 });
    expect(fakePage.screenshot).not.toHaveBeenCalled();
  });

  it("selects the explicit validation workspace after an account-picker redirect", async () => {
    const previousSlug = process.env.CLIENT_READINESS_WORKSPACE_SLUG;
    try {
      process.env.CLIENT_READINESS_WORKSPACE_SLUG = "corgtex-validation";
      const fakePage = {
        request: {
          get: vi.fn(async () => ({
            ok: () => true,
            json: async () => ({
              workspaces: [
                { id: "customer-1", slug: "customer", name: "Customer" },
                { id: "validation-1", slug: "corgtex-validation", name: "Validation" },
              ],
            }),
          })),
        },
      };

      await expect(resolveSelectedWorkspace(fakePage, null)).resolves.toEqual({
        workspacePath: "/workspaces/validation-1",
        workspaceSlug: "corgtex-validation",
        selected: true,
      });
    } finally {
      if (previousSlug === undefined) {
        delete process.env.CLIENT_READINESS_WORKSPACE_SLUG;
      } else {
        process.env.CLIENT_READINESS_WORKSPACE_SLUG = previousSlug;
      }
    }
  });

  it("requires an explicit tenant when the account picker has multiple workspaces", async () => {
    const previousSlug = process.env.CLIENT_READINESS_WORKSPACE_SLUG;
    const previousId = process.env.CLIENT_READINESS_WORKSPACE_ID;
    try {
      delete process.env.CLIENT_READINESS_WORKSPACE_SLUG;
      delete process.env.CLIENT_READINESS_WORKSPACE_ID;
      const fakePage = {
        request: {
          get: vi.fn(async () => ({
            ok: () => true,
            json: async () => ({
              workspaces: [
                { id: "workspace-1", slug: "one", name: "One" },
                { id: "workspace-2", slug: "two", name: "Two" },
              ],
            }),
          })),
        },
      };

      await expect(resolveSelectedWorkspace(fakePage, null)).rejects.toThrow(
        "Set CLIENT_READINESS_WORKSPACE_ID or CLIENT_READINESS_WORKSPACE_SLUG",
      );
    } finally {
      if (previousSlug === undefined) {
        delete process.env.CLIENT_READINESS_WORKSPACE_SLUG;
      } else {
        process.env.CLIENT_READINESS_WORKSPACE_SLUG = previousSlug;
      }
      if (previousId === undefined) {
        delete process.env.CLIENT_READINESS_WORKSPACE_ID;
      } else {
        process.env.CLIENT_READINESS_WORKSPACE_ID = previousId;
      }
    }
  });

  it("adds route labels to console and page error entries", () => {
    expect(labelConsoleEntry({ type: "pageerror", text: "boom" }, "desktop-settings")).toEqual({
      type: "pageerror",
      text: "boom",
      routeLabel: "desktop-settings",
    });
    expect(labelConsoleEntry({ type: "error", text: "boom" }, "")).toEqual({
      type: "error",
      text: "boom",
    });
  });

  it("builds a demo Add route guard check with the selected workspace path", () => {
    expect(demoAddGuardRouteSuffix("/workspaces/ws-1")).toBe(
      "/add?kind=upload_file&returnTo=%2Fworkspaces%2Fws-1%2Fbrain",
    );
  });

  it("does not include deleted Finance subroutes in readiness sweeps", () => {
    expect(coreRouteCatalog).not.toContainEqual(["finance-clients", "/finance/clients"]);
    expect(optionalRouteCatalog).not.toContainEqual(["finance-clients", "/finance/clients"]);
  });
});

describe("client readiness mobile mode handling", () => {
  function mobileModePage({ visibleAfterClicks = 1 } = {}) {
    let clicks = 0;
    const button = {
      waitFor: vi.fn(async () => null),
      click: vi.fn(async () => {
        clicks += 1;
      }),
    };
    const expected = {
      waitFor: vi.fn(async () => null),
      isVisible: vi.fn(async () => clicks >= visibleAfterClicks),
    };
    return {
      button,
      expected,
      page: {
        locator: vi.fn((selector) => ({
          first: vi.fn(() => (selector.endsWith("button") ? button : expected)),
        })),
        screenshot: vi.fn(async () => null),
        url: vi.fn(() => "http://localhost/workspaces/workspace-1"),
        waitForTimeout: vi.fn(async () => null),
      },
    };
  }

  it("retries the mobile mode switch until the expected mode is visible", async () => {
    const findings = [];
    const { button, page } = mobileModePage({ visibleAfterClicks: 2 });

    await expect(activateMobileMode(page, {
      buttonText: /AI|IA/,
      expectedSelector: ".mobile-ai-workbench",
      label: "mobile-shell-iphone-modern-ai",
      findings,
      timeoutMs: 3,
      retryDelayMs: 1,
    })).resolves.toBe(true);

    expect(button.click).toHaveBeenCalledTimes(2);
    expect(findings).toEqual([]);
    expect(page.screenshot).not.toHaveBeenCalled();
  });

  it("records a finding instead of throwing when mobile mode never becomes visible", async () => {
    const findings = [];
    const { button, page } = mobileModePage({ visibleAfterClicks: 10 });

    await expect(activateMobileMode(page, {
      buttonText: /AI|IA/,
      expectedSelector: ".mobile-ai-workbench",
      label: "mobile-shell-iphone-modern-ai",
      findings,
      timeoutMs: 3,
      retryDelayMs: 1,
    })).resolves.toBe(false);

    expect(button.click).toHaveBeenCalledTimes(3);
    expect(findings).toEqual([{
      name: "mobile-shell-iphone-modern-ai",
      route: "http://localhost/workspaces/workspace-1",
      status: "mode-switch-timeout",
      selector: ".mobile-ai-workbench",
    }]);
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({
      path: expect.stringContaining("mobile-shell-iphone-modern-ai-missing.png"),
    }));
  });

  it("returns to workspace mode before checking the bottom navigation", async () => {
    const findings = [];
    const { button, page } = mobileModePage({ visibleAfterClicks: 1 });

    await expect(activateMobileWorkspaceMode(page, {
      label: "mobile-shell-pixel-workspace-mode",
      findings,
      timeoutMs: 3,
      retryDelayMs: 1,
    })).resolves.toBe(true);

    expect(page.locator).toHaveBeenCalledWith(".mobile-mode-switch button", { hasText: /Workspace|Espacio/ });
    expect(page.locator).toHaveBeenCalledWith(".mobile-bottom-nav");
    expect(button.click).toHaveBeenCalledTimes(1);
    expect(findings).toEqual([]);
  });

  it("activates the Ask tab before checking mobile chat controls", async () => {
    const findings = [];
    const { button, page } = mobileModePage({ visibleAfterClicks: 1 });

    await expect(activateMobileAskTab(page, {
      label: "mobile-shell-pixel-ai-ask",
      findings,
      timeoutMs: 3,
      retryDelayMs: 1,
    })).resolves.toBe(true);

    expect(page.locator).toHaveBeenCalledWith(".mobile-ai-tabs button", { hasText: /Ask|Preguntar/ });
    expect(page.locator).toHaveBeenCalledWith(".mobile-ai-pane-ask .chat-input");
    expect(button.click).toHaveBeenCalledTimes(1);
    expect(findings).toEqual([]);
  });

  it("records a finding when the Ask tab does not reveal chat controls", async () => {
    const findings = [];
    const { button, page } = mobileModePage({ visibleAfterClicks: 10 });

    await expect(activateMobileAskTab(page, {
      label: "mobile-shell-pixel-ai-ask",
      findings,
      timeoutMs: 3,
      retryDelayMs: 1,
    })).resolves.toBe(false);

    expect(button.click).toHaveBeenCalledTimes(3);
    expect(findings).toEqual([{
      name: "mobile-shell-pixel-ai-ask",
      route: "http://localhost/workspaces/workspace-1",
      status: "mode-switch-timeout",
      selector: ".mobile-ai-pane-ask .chat-input",
    }]);
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({
      path: expect.stringContaining("mobile-shell-pixel-ai-ask-missing.png"),
    }));
  });
});

describe("client readiness mobile stylesheet contract", () => {
  it("keeps the mobile shell default hidden rule before the mobile breakpoint override", async () => {
    const [globalsCss, componentsCss] = await Promise.all([
      readFile("apps/web/app/globals.css", "utf8"),
      readFile("apps/web/app/styles/components.css", "utf8"),
    ]);

    expect(globalsCss).not.toContain(".mobile-shell,\n.mobile-ai-workbench {\n  display: none;\n}");

    const defaultHiddenIndex = componentsCss.indexOf(".mobile-shell,\n.mobile-ai-workbench {\n  display: none;\n}");
    const mobileBreakpointIndex = componentsCss.indexOf("@media (max-width: 720px)");
    const mobileVisibleIndex = componentsCss.indexOf(".mobile-shell {\n    display: block;\n  }", mobileBreakpointIndex);

    expect(defaultHiddenIndex).toBeGreaterThanOrEqual(0);
    expect(mobileBreakpointIndex).toBeGreaterThan(defaultHiddenIndex);
    expect(mobileVisibleIndex).toBeGreaterThan(mobileBreakpointIndex);
  });
});
