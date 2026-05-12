import type { Metadata } from "next";
import { getMcpPublicUrl } from "@corgtex/domain";
import { ClaudeCodeInstaller } from "./ClaudeCodeInstaller";
import { buildClaudeCodeCommand } from "@/lib/install-helpers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Corgtex to Claude Code",
  description: "Add Corgtex as an MCP server in Claude Code with one terminal command.",
};

export default function ConnectClaudeCodePage({ params }: { params: Promise<{ locale: string }> }) {
  // Await for compatibility but locale only affects the back-link path
  void params;
  const connectorUrl = getMcpPublicUrl();
  const command = buildClaudeCodeCommand(connectorUrl);

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 sm:py-16">
      <ClaudeCodeInstaller command={command} fallbackInstallHref="../claude" />
    </main>
  );
}
