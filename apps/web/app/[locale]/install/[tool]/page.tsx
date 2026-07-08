import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getMcpPublicUrl } from "@corgtex/domain";
import { installerProviderSlug, type InstallerProviderKey } from "@/lib/install-helpers";
import { GuidedProviderInstaller } from "./GuidedProviderInstaller";

export const dynamic = "force-dynamic";

const PAGE_TITLES: Record<InstallerProviderKey, string> = {
  openwork: "Connect Corgtex to OpenWork",
  claude: "Connect Corgtex to Claude",
  chatgpt: "Connect Corgtex to ChatGPT",
  cursor: "Connect Corgtex to Cursor",
  copilot: "Connect Corgtex to GitHub Copilot",
  gemini: "Connect Corgtex to Gemini CLI",
  "claude-code": "Connect Corgtex to Claude Code",
  "generic-mcp": "Connect Corgtex to any MCP client",
};

function safeReturnTo(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return null;
  return candidate;
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value ?? null;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ tool: string }>;
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
  params: Promise<{ tool: string }>;
  searchParams: Promise<{ workspaceId?: string | string[]; returnTo?: string | string[] }>;
}) {
  const [{ tool }, search] = await Promise.all([params, searchParams]);
  const providerKey = installerProviderSlug(tool);
  if (!providerKey || providerKey === "claude" || providerKey === "claude-code") notFound();

  const connectorUrl = getMcpPublicUrl();
  const workspaceId = firstParam(search.workspaceId);
  const returnTo = safeReturnTo(search.returnTo);

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 sm:py-16">
      <GuidedProviderInstaller
        providerKey={providerKey}
        connectorUrl={connectorUrl}
        workspaceId={workspaceId}
        returnTo={returnTo}
      />
    </main>
  );
}
