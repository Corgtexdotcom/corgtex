import { notFound } from "next/navigation";
import { getControlPlaneClientOptions, requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { UsersClient } from "./_components/users-client";
import { ClientContextSwitcher } from "../_components/client-context-switcher";

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
    <div className="space-y-6 animate-in fade-in duration-300">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <span className="text-[10px] font-bold tracking-widest text-brand-400 uppercase">
            Operate & Manage
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-white mt-1">
            Platform User Directory
          </h1>
          <p className="text-xs text-muted mt-1 max-w-2xl">
            Search and review platform administrators, support engineers, and customer-specific workspace member accounts across all deployments.
          </p>
        </div>
        <ClientContextSwitcher
          clients={clientOptions}
          selectedClientId={raw?.client ?? ""}
          mode="filter"
          className="bg-bg-alt border border-line rounded-xl p-4"
          label="Client"
        />
      </div>

      {/* Render Client Users directory */}
      <UsersClient users={formattedUsers} />

    </div>
  );
}
