import type { Metadata } from "next";
import { installerWorkspaceUrl, WorkspaceMcpPicker } from "../WorkspaceMcpPicker";
import { ClaudeInstaller } from "./ClaudeInstaller";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Corgtex to Claude",
  description: "Add Corgtex as a custom connector in Claude or Claude Cowork. No terminal, no install — three clicks.",
};

function safeReturnTo(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return null;
  return candidate;
}

export default async function ConnectClaudePage({
  searchParams,
}: {
  searchParams: Promise<{ workspaceId?: string | string[]; returnTo?: string | string[] }>;
}) {
  const search = await searchParams;
  const workspaceId = Array.isArray(search.workspaceId) ? search.workspaceId[0] : search.workspaceId ?? null;
  if (!workspaceId) return <WorkspaceMcpPicker tool="claude" />;
  const connectorUrl = await installerWorkspaceUrl(workspaceId);
  const returnTo = safeReturnTo(search.returnTo);

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 sm:py-16">
      <p className="mx-auto mb-4 max-w-xl break-all">Connection name: Corgtex - {workspaceId}</p>
      <ClaudeInstaller connectorUrl={connectorUrl} workspaceId={workspaceId} returnTo={returnTo} />
    </main>
  );
}
