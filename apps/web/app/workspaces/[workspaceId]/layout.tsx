import { listActorWorkspaces, countUnreadNotifications, listConversations } from "@corgtex/domain";
import { workspaceBranding, prisma } from "@corgtex/shared";
import type { Metadata } from "next";
import { logoutAction, requirePageActor } from "@/lib/auth";
import { ChatInterface } from "./chat/ChatInterface";
import { DemoTour } from "./DemoTour";
import { DemoBanner } from "./DemoBanner";
import { CommandPalette } from "./CommandPalette";
import { CommandMenuButton } from "./CommandMenuButton";
import { ThemeToggle } from "../../ThemeToggle";

export const dynamic = "force-dynamic";

type Workspace = Awaited<ReturnType<typeof listActorWorkspaces>>[number];

import { WORKSPACE_NAV_GROUPS as navGroups } from "@/lib/nav-config";

export async function generateMetadata({ params }: { params: Promise<{ workspaceId: string }> }): Promise<Metadata> {
  const { workspaceId } = await params;
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true, name: true } });
  if (!workspace) return { title: "Corgtex" };
  const branding = workspaceBranding(workspace);
  return { title: branding.pageTitle };
}

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const userId = actor.kind === "user" ? actor.user.id : null;
  const [workspaces, unreadCount, conversationsResult] = await Promise.all([
    listActorWorkspaces(actor),
    userId ? countUnreadNotifications(userId, workspaceId) : Promise.resolve(0),
    listConversations(actor, workspaceId, { take: 30 }).catch(() => ({ items: [], total: 0, take: 30, skip: 0 }))
  ]);
  const current = workspaces.find((w: Workspace) => w.id === workspaceId);
  const conversations = conversationsResult.items;

  return (
    <div className="ws-layout">
      <CommandPalette workspaceId={workspaceId} workspaces={workspaces} />
      <aside className="ws-sidebar">
        <div className="ws-sidebar-header">
          <a href="/" className="ws-logo">{current ? workspaceBranding(current).primaryName : "Corgtex"}</a>
          {current && (
            <div className="ws-workspace-name" style={{ marginTop: "2px", fontWeight: 500, opacity: 0.8, fontSize: "0.8rem", letterSpacing: "0.02em" }}>
              {workspaceBranding(current).secondaryLabel}
            </div>
          )}
        </div>

        <nav className="ws-nav">
          {navGroups.map((group) => (
            <div key={group.label} style={{ marginBottom: "16px" }}>
              <div className="muted" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", padding: "0 12px", marginBottom: "4px", fontWeight: 600 }}>
                {group.label}
              </div>
              {group.items.map((item) => (
                <a
                  key={item.href}
                  href={`/workspaces/${workspaceId}${item.href}`}
                  className="ws-nav-link"
                >
                  <span className="ws-nav-icon">{item.icon}</span>
                  {item.label}
                  {item.href === "" && unreadCount > 0 && (
                    <span className="ws-notif-badge">{unreadCount}</span>
                  )}
                </a>
              ))}
            </div>
          ))}

          {current?.slug === "corgtex" && actor.kind === "user" && actor.user.email === "janbrezina@icloud.com" && (
            <div style={{ marginBottom: "16px" }}>
              <div className="muted" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", padding: "0 12px", marginBottom: "4px", fontWeight: 600 }}>
                Global Admin
              </div>
              <a href={`/workspaces/${workspaceId}/admin`} className="ws-nav-link">
                <span className="ws-nav-icon">✧</span>
                Platform Admin
              </a>
            </div>
          )}
        </nav>

        <div className="ws-sidebar-footer">
          <CommandMenuButton />
          <ThemeToggle />
          
          <form action={logoutAction} style={{ marginTop: "4px" }}>
            <button type="submit" className="ws-nav-link ws-logout-btn">Logout</button>
          </form>
        </div>
      </aside>

      <main className="ws-main">
        <div className="ws-main-content">
          {current?.slug === "jnj-demo" && <DemoBanner />}
          {children}
        </div>
      </main>

      <aside className="ws-agent-sidebar">
        <ChatInterface
          workspaceId={workspaceId}
          conversations={conversations.map((c: any) => ({
            id: c.id,
            topic: c.topic,
            agentKey: c.agentKey,
            status: c.status,
            updatedAt: c.updatedAt.toISOString(),
            lastMessage: c.turns?.[0]?.assistantMessage?.slice(0, 100) ?? null,
          }))}
          activeSessionId={null}
          compact={true}
        />
      </aside>
      {current?.slug === "jnj-demo" && (
        <DemoTour workspaceId={workspaceId} />
      )}
    </div>
  );
}
