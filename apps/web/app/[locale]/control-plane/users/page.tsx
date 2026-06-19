import { notFound } from "next/navigation";
import { getControlPlaneClientOptions, requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { normalizeSelectedValues } from "@/lib/filter-query";
import { prisma } from "@corgtex/shared";
import { UsersClient } from "./_components/users-client";
import { ClientContextSwitcher } from "../_components/client-context-switcher";
import { ControlPlanePageHeader } from "../_components/control-plane-ui";

export const dynamic = "force-dynamic";

export default async function ControlPlaneUsersPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const clientFilters = normalizeSelectedValues(raw?.client);
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
  const selectedWorkspaceIds = clientOptions
    .filter((client) => clientFilters.includes(client.id) && client.managedWorkspaceId)
    .map((client) => client.managedWorkspaceId);
  const scopedUsers = clientFilters.length > 0 && selectedWorkspaceIds.length > 0
    ? users.filter((user: any) => user.memberships.some((membership: any) => selectedWorkspaceIds.includes(membership.workspace.id)))
    : clientFilters.length > 0
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
              selectedClientIds={clientFilters}
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
