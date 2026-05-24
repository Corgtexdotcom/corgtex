import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
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

  const format = await getFormatter();

  // If DB is empty, seed realistic mock admin/member records
  const formattedUsers = users.length > 0
    ? users.map((u: any) => ({
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
      }))
    : [
        {
          id: "u1",
          name: "Jan Brezina",
          email: "jan@corgtex.local",
          role: "ADMIN",
          membershipsCount: 2,
          lastActive: "Active now",
          memberships: [
            { workspaceId: "1", workspaceName: "Atlas Workspace", workspaceSlug: "atlas", role: "OWNER" },
            { workspaceId: "2", workspaceName: "Beacon Manufacturing", workspaceSlug: "beacon-manufacturing", role: "ADMIN" },
          ],
        },
        {
          id: "u2",
          name: "Alex Miller",
          email: "alex@corgtex.local",
          role: "USER",
          membershipsCount: 1,
          lastActive: "2h ago",
          memberships: [
            { workspaceId: "1", workspaceName: "Atlas Workspace", workspaceSlug: "atlas", role: "MEMBER" },
          ],
        },
        {
          id: "u3",
          name: "Staging Daemon",
          email: "system+corgtex@corgtex.local",
          role: "ADMIN",
          membershipsCount: 3,
          lastActive: "1d ago",
          memberships: [
            { workspaceId: "1", workspaceName: "Atlas Workspace", workspaceSlug: "atlas", role: "ADMIN" },
            { workspaceId: "2", workspaceName: "Beacon Manufacturing", workspaceSlug: "beacon-manufacturing", role: "ADMIN" },
            { workspaceId: "3", workspaceName: "Summit Media", workspaceSlug: "summit-media", role: "ADMIN" },
          ],
        },
      ];

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
        <p className="text-xs text-slate-400 mt-1 max-w-2xl">
          Search and review platform administrators, support engineers, and customer-specific workspace member accounts across all deployments.
        </p>
      </div>

      {/* Render Client Users directory */}
      <UsersClient users={formattedUsers} />

    </div>
  );
}
