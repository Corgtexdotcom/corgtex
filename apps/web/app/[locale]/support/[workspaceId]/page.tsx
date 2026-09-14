import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import { getSupportSetup } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { SetupChecklist } from "./SetupChecklist";

export const dynamic = "force-dynamic";

export default async function SupportSetupPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const actor = await requirePageActor();
  const { workspaceId } = await params;
  const setup = await getSupportSetup(actor, workspaceId);
  return <main className="mx-auto max-w-4xl space-y-8 px-4 py-8">
    <header className="space-y-3">
      <Link href="/support" className="text-sm underline">Workspace Support</Link>
      <h1 className="break-words text-2xl font-semibold">{setup.workspace?.name}</h1>
      <p className="text-sm text-[var(--text-muted)]">{setup.role === "FULL" ? "Full Admin" : "Setup Admin"}</p>
    </header>
    <section className="space-y-4 border-t border-[var(--line-subtle)] pt-6">
      <h2 className="text-lg font-semibold">Connections</h2>
      {setup.connections.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No communication connection configured.</p>
        : <ul className="divide-y divide-[var(--line-subtle)]">{setup.connections.map((connection) => <li className="flex justify-between gap-4 py-3 text-sm" key={`${connection.provider}:${connection.status}`}>
          <span>{connection.provider}</span><span>{connection.status}</span>
        </li>)}</ul>}
    </section>
    <section className="space-y-4 border-t border-[var(--line-subtle)] pt-6">
      <SetupChecklist workspaceId={workspaceId} initialVersion={setup.version} initialChecklist={setup.checklist} initialConnectors={setup.connectors} initialSetupRevision={setup.setupRevision} />
    </section>
    {setup.role === "SETUP"
      ? <div className="flex items-center gap-3 border-t border-[var(--line-subtle)] pt-6 text-sm text-[var(--text-muted)]"><LockKeyhole size={18} aria-hidden />Client content is restricted.</div>
      : <Link className="inline-block font-medium underline" href={`/workspaces/${workspaceId}`}>Open workspace</Link>}
  </main>;
}
