import { notFound } from "next/navigation";
import { requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { UsersClient } from "./_components/users-client";

export const dynamic = "force-dynamic";

export default async function ControlPlaneUsersPage() {
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  // Fetch real users and their memberships from Prisma PostgreSQL database
  const users = await prisma.user.findMany({
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
  });

  const formattedUsers = users.map((u: any) => ({
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

      {/* Render Client Users directory */}
      <UsersClient users={formattedUsers} />

    </div>
  );
}
