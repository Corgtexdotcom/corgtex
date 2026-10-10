import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireInstallerWorkspace: vi.fn(),
}));

vi.mock("./installer-workspace", () => ({ requireInstallerWorkspace: mocks.requireInstallerWorkspace }));
vi.mock("@corgtex/domain", () => ({ getWorkspaceMcpInstallUrl: (workspaceId: string) => `https://app.example/mcp/${workspaceId}` }));

import InstallIndexPage from "./page";
import GuidedInstallPage from "./[tool]/page";
import ConnectClaudePage from "./claude/page";
import ConnectClaudeCodePage from "./claude-code/page";

function elementsWithHref(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(elementsWithHref);
  if (!React.isValidElement<{ href?: string; children?: React.ReactNode }>(node)) return [];
  return [node.props.href, ...elementsWithHref(node.props.children)].filter((href): href is string => typeof href === "string");
}

function installerProps(page: React.ReactElement) {
  const main = page.props as { children: React.ReactElement };
  return main.children.props as { integrationsHref: string; returnTo?: string | null; fallbackInstallHref?: string };
}

const selectedWorkspace = "selected-id";
const otherWorkspace = "other-id";
const returnTo = `/workspaces/${selectedWorkspace}/settings?tab=ai-workspaces`;

describe("installer pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("React", React);
    mocks.requireInstallerWorkspace.mockResolvedValue(undefined);
  });

  it("keeps the selected workspace in the Codex, Claude, and Claude Code controls", async () => {
    const searchParams = Promise.resolve({ workspaceId: selectedWorkspace, returnTo });
    const pages = await Promise.all([
      GuidedInstallPage({ params: Promise.resolve({ locale: "en", tool: "codex" }), searchParams }),
      ConnectClaudePage({ params: Promise.resolve({ locale: "en" }), searchParams }),
      ConnectClaudeCodePage({ params: Promise.resolve({ locale: "en" }), searchParams }),
    ]);

    expect(mocks.requireInstallerWorkspace).toHaveBeenCalledTimes(3);
    for (const page of pages) {
      const props = installerProps(page as React.ReactElement);
      expect(props.integrationsHref).toContain(`/en/install?workspaceId=${selectedWorkspace}`);
      expect(props.integrationsHref).not.toContain(otherWorkspace);
    }
    expect(installerProps(pages[2] as React.ReactElement).fallbackInstallHref)
      .toContain(`/en/install/claude?workspaceId=${selectedWorkspace}`);
  });

  it("keeps workspace and locale through all index tiles, even after rejecting a foreign return", async () => {
    const page = await InstallIndexPage({
      params: Promise.resolve({ locale: "es" }),
      searchParams: Promise.resolve({ workspaceId: selectedWorkspace, returnTo: `/workspaces/${otherWorkspace}/settings?tab=ai-workspaces` }),
    });
    expect(mocks.requireInstallerWorkspace).toHaveBeenCalledWith(selectedWorkspace);
    const hrefs = elementsWithHref(page);
    expect(hrefs).toHaveLength(9);
    expect(hrefs).toContain(`/es/install/codex?workspaceId=${selectedWorkspace}`);
    expect(hrefs).toContain(`/es/install/claude?workspaceId=${selectedWorkspace}`);
    expect(hrefs.every((href) => !href.includes("returnTo=") && !href.includes(otherWorkspace))).toBe(true);
  });

  it("keeps direct Spanish entry on the workspace picker without showing a foreign installer", async () => {
    const page = await ConnectClaudePage({ params: Promise.resolve({ locale: "es" }), searchParams: Promise.resolve({}) });
    expect((page as React.ReactElement<{ locale: string }>).props.locale).toBe("es");
    expect(mocks.requireInstallerWorkspace).not.toHaveBeenCalled();
  });
});
