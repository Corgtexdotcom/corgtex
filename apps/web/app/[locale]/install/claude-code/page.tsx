import type { Metadata } from "next";
import { getWorkspaceMcpResource } from "@corgtex/domain";
import { WorkspacePicker } from "../WorkspacePicker";
import { ClaudeCodeInstaller } from "./ClaudeCodeInstaller";
import { buildClaudeCodeCommand } from "@/lib/install-helpers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Corgtex to Claude Code",
  description: "Add Corgtex as an MCP server in Claude Code with one terminal command.",
};

export default async function ConnectClaudeCodePage({ searchParams }: { searchParams: Promise<{ workspaceId?: string }> }) {
  const { workspaceId } = await searchParams;
  if (!workspaceId) return <WorkspacePicker path="/install/claude-code" />;
  const connectorUrl = getWorkspaceMcpResource(workspaceId);
  const command = buildClaudeCodeCommand(connectorUrl);

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 sm:py-16">
      <ClaudeCodeInstaller command={command} fallbackInstallHref={`../claude?workspaceId=${encodeURIComponent(workspaceId)}`} />
    </main>
  );
}
