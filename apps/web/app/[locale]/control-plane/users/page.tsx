import { notFound } from "next/navigation";
import { getControlPlaneClientOptions, requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { UsersClient } from "./_components/users-client";
import { ClientContextSwitcher } from "../_components/client-context-switcher";
import { ControlPlanePageHeader } from "../_components/control-plane-ui";

export const dynamic = "force-dynamic";

export default async function ControlPlaneUsersPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | undefined>>;
}) {
  const raw = await searchParams;
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  const [users, clientOptions] = await Promise.all([
    // Fetch real users and their memberships from Prisma PostgreSQL database
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        memberships: {
          include: {
            workspace: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
      },
    }),
    getControlPlaneClientOptions(actor),
  ]);
  const selectedWorkspaceId = clientOptions.find((client) => client.id === raw?.client)?.managedWorkspaceId ?? null;
  const scopedUsers = raw?.client && selectedWorkspaceId
    ? users.filter((user: any) => user.memberships.some((membership: any) => membership.workspace.id === selectedWorkspaceId))
    : raw?.client
      ? []
      : users;

  const formattedUsers = scopedUsers.map((u: any) => ({
    id: u.id,
    name: u.displayName || "Unnamed Actor",
    email: u.email,
    role: u.globalRole,
    membershipsCount: u.memberships.length,
    lastActive: u.updatedAt ? u.updatedAt.toLocaleString() : "Never",
    memberships: u.memberships.map((m: any) => ({
      workspaceId: m.workspace.id,
      workspaceName: m.workspace.name,
      workspaceSlug: m.workspace.slug,
      role: m.role,
    })),
  }));

  return (
    <div className="space-y-5">
      <ControlPlanePageHeader
        eyebrow="Operate and manage"
        title="Platform User Directory"
        description="Search administrators, support engineers, and customer workspace members across deployments."
        actions={
          <div className="rounded-lg border border-line bg-bg-alt p-3">
            <ClientContextSwitcher
              clients={clientOptions}
              selectedClientId={raw?.client ?? ""}
              mode="filter"
              label="Client"
            />
          </div>
        }
      />

      <UsersClient users={formattedUsers} />

    </div>
  );
}
