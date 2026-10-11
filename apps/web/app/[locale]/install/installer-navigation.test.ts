import { describe, expect, it } from "vitest";
import { installerDirectoryHref, installerReturnTo, installerTileHref } from "./installer-navigation";

const selected = "10000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000002";

describe("installer navigation", () => {
  it("keeps the selected non-default workspace and locale across Codex, the directory, and Claude", () => {
    const returnTo = installerReturnTo(`/workspaces/${selected}/settings?tab=ai-workspaces`, selected, "en");
    expect(returnTo).toBe(`/en/workspaces/${selected}/settings?tab=ai-workspaces`);

    const directory = installerDirectoryHref("en", selected, returnTo);
    expect(directory).toBe(`/en/install?workspaceId=${selected}&returnTo=%2Fen%2Fworkspaces%2F${selected}%2Fsettings%3Ftab%3Dai-workspaces`);
    expect(new URL(directory, "https://app.example").searchParams.get("workspaceId")).toBe(selected);
    expect(new URL(directory, "https://app.example").searchParams.get("workspaceId")).not.toBe(other);
    expect(installerTileHref("en", "claude", selected, returnTo)).toBe(
      `/en/install/claude?workspaceId=${selected}&returnTo=%2Fen%2Fworkspaces%2F${selected}%2Fsettings%3Ftab%3Dai-workspaces`,
    );
  });

  it("preserves Spanish and a valid provider on a same-workspace settings return", () => {
    expect(installerReturnTo(`/es/workspaces/${selected}/settings?tab=ai-workspaces&provider=generic_mcp`, selected, "es"))
      .toBe(`/es/workspaces/${selected}/settings?tab=ai-workspaces&provider=generic_mcp`);
    expect(installerDirectoryHref("es", selected)).toBe(`/es/install?workspaceId=${selected}`);
  });

  it("preserves the existing onboarding tour when switching installers", () => {
    const returnTo = installerReturnTo(`/workspaces/${selected}?onboarding=setup`, selected, "en");
    expect(returnTo).toBe(`/en/workspaces/${selected}?onboarding=setup`);
    expect(installerTileHref("en", "claude", selected, returnTo))
      .toContain(`returnTo=%2Fen%2Fworkspaces%2F${selected}%3Fonboarding%3Dsetup`);
    expect(installerReturnTo(`/workspaces/${other}?onboarding=setup`, selected, "en")).toBeNull();
    expect(installerReturnTo(`/workspaces/${selected}?onboarding=setup&next=//evil.example`, selected, "en")).toBeNull();
  });

  it("rejects external, malformed, and foreign-workspace return paths", () => {
    for (const candidate of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      `/?next=/workspaces/${selected}/settings`,
      `/workspaces/${other}/settings?tab=ai-workspaces`,
      `/workspaces/${selected}/settings?tab=members`,
      `/workspaces/${selected}/settings?tab=ai-workspaces&next=https://evil.example`,
      `/workspaces/${selected}/settings?tab=ai-workspaces&tab=members`,
      `/workspaces/${selected}/settings?tab=ai-workspaces#other`,
      `/workspaces/${selected}/settings?tab=ai-workspaces&provider=%2F%2Fevil.example`,
    ]) {
      expect(installerReturnTo(candidate, selected, "en"), candidate).toBeNull();
    }
    expect(installerDirectoryHref("en", selected, installerReturnTo(`/workspaces/${other}/settings?tab=ai-workspaces`, selected, "en")))
      .toBe(`/en/install?workspaceId=${selected}`);
  });
});
