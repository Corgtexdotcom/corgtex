import type { Metadata } from "next";
import { getWorkspaceMcpInstallUrl } from "@corgtex/domain";
import { WorkspacePicker } from "../WorkspacePicker";
import { ClaudeInstaller } from "./ClaudeInstaller";
import { firstInstallerParam, installerDirectoryHref, installerReturnTo } from "../installer-navigation";
import { requireInstallerWorkspace } from "../installer-workspace";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Corgtex to Claude",
  description: "Add Corgtex as a custom connector in Claude or Claude Cowork, then approve Corgtex access.",
};

export default async function ConnectClaudePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ workspaceId?: string | string[]; returnTo?: string | string[] }>;
}) {
  const [{ locale }, search] = await Promise.all([params, searchParams]);
  const workspaceId = firstInstallerParam(search.workspaceId);
  if (!workspaceId) return <WorkspacePicker path="/install/claude" locale={locale} />;
  await requireInstallerWorkspace(workspaceId);
  const connectorUrl = getWorkspaceMcpInstallUrl(workspaceId);
  const returnTo = installerReturnTo(search.returnTo, workspaceId, locale);

  return (
    <main className="min-h-screen bg-[var(--bg)] px-4 py-10 sm:py-16">
      <ClaudeInstaller connectorUrl={connectorUrl} workspaceId={workspaceId} returnTo={returnTo} integrationsHref={installerDirectoryHref(locale, workspaceId, returnTo)} />
    </main>
  );
}
