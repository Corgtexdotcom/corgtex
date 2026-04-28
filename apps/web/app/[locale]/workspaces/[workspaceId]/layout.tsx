import { isGlobalOperator, listActorWorkspaces, countUnreadNotifications, listConversations } from "@corgtex/domain";
import { workspaceBranding, prisma } from "@corgtex/shared";
import type { Metadata } from "next";
import { logoutAction, requirePageActor } from "@/lib/auth";
import { ChatInterface } from "./chat/ChatInterface";
import { DemoTour } from "./DemoTour";
import { DemoBanner } from "./DemoBanner";
import { CommandPalette } from "./CommandPalette";
import { CommandMenuButton } from "./CommandMenuButton";
import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeToggle } from "../../../ThemeToggle";
import { filterNavGroupsByFeatureFlags, getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";

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
  const [workspaces, unreadCount, conversationsResult, featureFlags] = await Promise.all([
    listActorWorkspaces(actor),
    userId ? countUnreadNotifications(userId, workspaceId) : Promise.resolve(0),
    listConversations(actor, workspaceId, { take: 30 }).catch(() => ({ items: [], total: 0, take: 30, skip: 0 })),
    getWorkspaceFeatureFlags(workspaceId),
  ]);
  const current = workspaces.find((w: Workspace) => w.id === workspaceId);
  const conversations = conversationsResult.items;
  const visibleNavGroups = filterNavGroupsByFeatureFlags(navGroups, featureFlags);
  const tNav = await getTranslations("nav");
  const tCommon = await getTranslations("common");

  return (
    <div className="ws-layout">
      <CommandPalette workspaceId={workspaceId} workspaces={workspaces} navGroups={visibleNavGroups} />
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
          {visibleNavGroups.map((group) => (
            <div key={group.labelKey} style={{ marginBottom: "16px" }}>
              <div className="muted" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", padding: "0 12px", marginBottom: "4px", fontWeight: 600 }}>
                {tNav(group.labelKey as any)}
              </div>
              {group.items.map((item) => (
                <a
                  key={item.href}
                  href={`/workspaces/${workspaceId}${item.href}`}
                  className="ws-nav-link"
                >
                  <span className="ws-nav-icon">{item.icon}</span>
                  {tNav(item.labelKey as any)}
                  {item.href === "" && unreadCount > 0 && (
                    <span className="ws-notif-badge">{unreadCount}</span>
                  )}
                </a>
              ))}
            </div>
          ))}

          {isGlobalOperator(actor) && (
            <div style={{ marginBottom: "16px" }}>
              <div className="muted" style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.05em", padding: "0 12px", marginBottom: "4px", fontWeight: 600 }}>
                {tNav("globalAdmin")}
              </div>
              <a href={`/workspaces/${workspaceId}/admin`} className="ws-nav-link">
                <span className="ws-nav-icon">✧</span>
                {tNav("platformAdmin")}
              </a>
            </div>
          )}
        </nav>

        <div className="ws-sidebar-footer">
          {featureFlags.MULTILINGUAL && <LanguageSwitcher />}
          <CommandMenuButton />
          <ThemeToggle />
          
          <a href={`/workspaces/${workspaceId}/settings?tab=user`} className="ws-nav-link ws-logout-btn" style={{ marginTop: "4px" }}>
            {tNav("settings")} (User)
          </a>

          <form action={logoutAction} style={{ marginTop: "4px" }}>
            <button type="submit" className="ws-nav-link ws-logout-btn">{tCommon("logout")}</button>
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
