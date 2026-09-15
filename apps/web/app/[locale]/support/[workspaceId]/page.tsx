import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { getSupportSetup, getSupportConfiguration } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { SetupChecklist } from "./SetupChecklist";
import { ConfigurationManager } from "./ConfigurationManager";

export const dynamic = "force-dynamic";

export default async function SupportSetupPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const actor = await requirePageActor();
  const { workspaceId } = await params;
  const setup = await getSupportSetup(actor, workspaceId);
  const configuration = await getSupportConfiguration(actor, workspaceId);
  return <main className="mx-auto max-w-4xl space-y-8 px-4 py-8">
    <header className="space-y-3">
      <Link href="/support" className="text-sm underline">Workspace Support</Link>
      <h1 className="break-words text-2xl font-semibold">{setup.workspace?.name}</h1>
      <p className="text-sm text-[var(--text-muted)]">{setup.role === "FULL" ? "Full Admin" : "Setup Admin"}</p>
    </header>
    <ConfigurationManager initial={configuration} />
    <details className="space-y-4 border-t border-[var(--line-subtle)] pt-6">
      <summary className="cursor-pointer text-sm font-medium">Optional handoff checklist</summary>
      <SetupChecklist workspaceId={workspaceId} initialVersion={setup.version} initialChecklist={setup.checklist} initialConnectors={setup.connectors} initialSetupRevision={setup.setupRevision} />
    </details>
    {setup.role === "SETUP"
      ? <div className="flex items-center gap-3 border-t border-[var(--line-subtle)] pt-6 text-sm text-[var(--text-muted)]"><LockKeyhole size={18} aria-hidden />Client content is restricted.</div>
      : <Link className="inline-block font-medium underline" href={`/workspaces/${workspaceId}`}>Open workspace</Link>}
  </main>;
}
