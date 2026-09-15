import Link from "next/link";
import { requirePageActor } from "@/lib/auth";
import { listActorWorkspaces } from "@corgtex/domain";
import { filterWorkspacesForDeploymentScope } from "@/lib/deployment-workspace-scope";

export async function WorkspacePicker({ path }: { path: string }) {
  const actor = await requirePageActor();
  const workspaces = filterWorkspacesForDeploymentScope(await listActorWorkspaces(actor));
  return <main className="mx-auto max-w-xl space-y-6 px-4 py-12">
    <h1 className="text-2xl font-semibold">Connect a Corgtex workspace</h1>
    <ul className="divide-y divide-[var(--line)]">
      {workspaces.map(workspace => <li key={workspace.id}>
        <Link className="block py-4" href={`${path}?workspaceId=${encodeURIComponent(workspace.id)}`}>
          <span className="font-medium">{workspace.name}</span>
          <code className="mt-1 block break-all text-xs text-[var(--text-muted)]">{workspace.id}</code>
        </Link>
      </li>)}
    </ul>
    {workspaces.length === 0 ? <p>No available workspaces.</p> : null}
  </main>;
}
