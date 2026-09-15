import Link from "next/link";
import { env, prisma } from "@corgtex/shared";
import { requirePageActor } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function SupportWorkspacesPage() {
  const actor = await requirePageActor();
  const grants = actor.kind === "user" ? await prisma.workspaceSupportGrant.findMany({
    where: { userId: actor.user.id, isActive: true, ...(env.DEPLOYMENT_WORKSPACE_SCOPE_SLUG ? { workspace: { slug: env.DEPLOYMENT_WORKSPACE_SCOPE_SLUG } } : {}) },
    select: { role: true, workspace: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  }) : [];
  return <main className="mx-auto max-w-4xl space-y-6 px-4 py-8">
    <h1 className="text-2xl font-semibold">Workspace Support</h1>
    {grants.length === 0 && <p className="text-sm text-[var(--text-muted)]">No active support grants.</p>}
    <ul className="divide-y divide-[var(--line-subtle)]">
      {grants.map(({ workspace, role }) => <li key={workspace.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
        <Link className="font-medium underline" href={`/support/${workspace.id}`}>{workspace.name}</Link>
        <span className="text-sm text-[var(--text-muted)]">{role === "FULL" ? "Full Admin" : "Setup Admin"}</span>
      </li>)}
    </ul>
  </main>;
}
