import type { Metadata } from "next";
import { getWorkspaceMcpInstallUrl } from "@corgtex/domain";
import { WorkspacePicker } from "../WorkspacePicker";
import { ClaudeCodeInstaller } from "./ClaudeCodeInstaller";
import { buildClaudeCodeCommand } from "@/lib/install-helpers";
import { firstInstallerParam, installerDirectoryHref, installerReturnTo, installerTileHref } from "../installer-navigation";
import { requireInstallerWorkspace } from "../installer-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Corgtex to Claude Code",
  description: "Add Corgtex as an MCP server in Claude Code with one terminal command.",
};

export default async function ConnectClaudeCodePage({ params, searchParams }: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ workspaceId?: string | string[]; returnTo?: string | string[] }>;
}) {
  const [{ locale }, search] = await Promise.all([params, searchParams]);
  const workspaceId = firstInstallerParam(search.workspaceId);
  if (!workspaceId) return <WorkspacePicker path="/install/claude-code" locale={locale} />;
  await requireInstallerWorkspace(workspaceId);
  const connectorUrl = getWorkspaceMcpInstallUrl(workspaceId);
  const command = buildClaudeCodeCommand(connectorUrl);
  const returnTo = installerReturnTo(search.returnTo, workspaceId, locale);

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 sm:py-16">
      <ClaudeCodeInstaller command={command} fallbackInstallHref={installerTileHref(locale, "claude", workspaceId, returnTo)} integrationsHref={installerDirectoryHref(locale, workspaceId, returnTo)} />
    </main>
  );
}
