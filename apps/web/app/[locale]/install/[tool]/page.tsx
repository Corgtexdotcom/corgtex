import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getWorkspaceMcpInstallUrl } from "@corgtex/domain";
import { WorkspacePicker } from "../WorkspacePicker";
import { installerProviderSlug, type InstallerProviderKey } from "@/lib/install-helpers";
import { GuidedProviderInstaller } from "./GuidedProviderInstaller";
import { firstInstallerParam, installerDirectoryHref, installerReturnTo } from "../installer-navigation";
import { requireInstallerWorkspace } from "../installer-workspace";

export const dynamic = "force-dynamic";

const PAGE_TITLES: Record<InstallerProviderKey, string> = {
  openwork: "Connect Corgtex to OpenWork",
  claude: "Connect Corgtex to Claude",
  chatgpt: "Connect Corgtex to ChatGPT",
  codex: "Connect Corgtex to Codex",
  cursor: "Connect Corgtex to Cursor",
  copilot: "Connect Corgtex to GitHub Copilot",
  gemini: "Connect Corgtex to Gemini CLI",
  "claude-code": "Connect Corgtex to Claude Code",
  "generic-mcp": "Connect Corgtex to any MCP client",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; tool: string }>;
}): Promise<Metadata> {
  const { tool } = await params;
  const providerKey = installerProviderSlug(tool);
  if (!providerKey) {
    return {
      title: "Connect Corgtex to your AI tool",
    };
  }

  return {
    title: PAGE_TITLES[providerKey],
    description: "Use the Corgtex-guided installer before finishing setup in the selected AI tool.",
  };
}

export default async function GuidedInstallPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; tool: string }>;
  searchParams: Promise<{ workspaceId?: string | string[]; returnTo?: string | string[] }>;
}) {
  const [{ locale, tool }, search] = await Promise.all([params, searchParams]);
  const providerKey = installerProviderSlug(tool);
  if (!providerKey || providerKey === "claude" || providerKey === "claude-code") notFound();

  const workspaceId = firstInstallerParam(search.workspaceId);
  if (!workspaceId) return <WorkspacePicker path={`/install/${providerKey}`} locale={locale} />;
  await requireInstallerWorkspace(workspaceId);
  const connectorUrl = getWorkspaceMcpInstallUrl(workspaceId);
  const returnTo = installerReturnTo(search.returnTo, workspaceId, locale);

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 sm:py-16">
      <GuidedProviderInstaller
        providerKey={providerKey}
        connectorUrl={connectorUrl}
        workspaceId={workspaceId}
        returnTo={returnTo}
        integrationsHref={installerDirectoryHref(locale, workspaceId, returnTo)}
      />
    </main>
  );
}
