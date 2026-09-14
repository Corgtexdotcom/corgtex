import Link from "next/link";
import { getWorkspaceMcpPublicUrl, listActorWorkspaces, requireWorkspaceMembership } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { filterWorkspacesForDeploymentScope } from "@/lib/deployment-workspace-scope";

export async function installerWorkspaceUrl(workspaceId: string) {
  const actor = await requirePageActor();
  await requireWorkspaceMembership({ actor, workspaceId });
  return getWorkspaceMcpPublicUrl(workspaceId);
}

export async function WorkspaceMcpPicker({ tool = "" }: { tool?: string }) {
  const actor = await requirePageActor();
  const candidates = filterWorkspacesForDeploymentScope(await listActorWorkspaces(actor));
  const workspaces = [];
  for (const workspace of candidates) {
    try { await requireWorkspaceMembership({ actor, workspaceId: workspace.id }); workspaces.push(workspace); }
    catch { /* Setup-only grants cannot authorize a content connector. */ }
  }
  return <main className="mx-auto max-w-xl space-y-4 p-8">
    <h1 className="text-xl font-semibold">Connect a workspace</h1>
    <ul className="space-y-4">
      {workspaces.map((workspace) => <li key={workspace.id}>
        <Link className="text-link" href={`/install${tool ? `/${tool}` : ""}?workspaceId=${encodeURIComponent(workspace.id)}`}>
          {workspace.name} <span className="break-all text-sm">({workspace.id})</span>
        </Link>
      </li>)}
    </ul>
    {workspaces.length === 0 && <p>No workspaces available for MCP access.</p>}
  </main>;
}
