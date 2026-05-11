import { isGlobalOperator, listActorWorkspaces, countUnreadNotifications, listConversations, requireWorkspaceMembership, getMemberInvitePolicy } from "@corgtex/domain";
import { workspaceBranding, prisma } from "@corgtex/shared";
import type { Metadata } from "next";
import { logoutAction, requirePageActor } from "@/lib/auth";
import { DemoTour } from "./DemoTour";
import { DemoBanner } from "./DemoBanner";
import { getTranslations } from "next-intl/server";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { ThemeToggle } from "../../../ThemeToggle";
import { DesktopWorkspaceNav } from "./DesktopWorkspaceNav";
import { buildWorkspaceCapabilities } from "@/lib/workspace-capabilities";
import { filterNavGroupsByWorkspaceAccess, getWorkspaceFeatureFlags } from "@/lib/workspace-feature-flags";
import { MobileWorkspaceShell } from "./MobileWorkspaceShell";
import { getControlPlaneHref } from "@/lib/control-plane-url";
import { WorkspaceAddMenu } from "./WorkspaceAddMenu";
import { WorkspaceChatRail } from "./WorkspaceChatRail";

export const dynamic = "force-dynamic";

type Workspace = Awaited<ReturnType<typeof listActorWorkspaces>>[number];

import { WORKSPACE_NAV_GROUPS as navGroups } from "@/lib/nav-config";

export async function generateMetadata({ params }: { params: Promise<{ locale: string; workspaceId: string }> }): Promise<Metadata> {
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
  params: Promise<{ locale: string; workspaceId: string }>;
}) {
  const { locale, workspaceId } = await params;
  const actor = await requirePageActor();
  const userId = actor.kind === "user" ? actor.user.id : null;
  const [workspaces, unreadCount, conversationsResult, featureFlags, membership, invitePolicy] = await Promise.all([
    listActorWorkspaces(actor),
    userId ? countUnreadNotifications(userId, workspaceId) : Promise.resolve(0),
    listConversations(actor, workspaceId, { take: 30 }).catch(() => ({ items: [], total: 0, take: 30, skip: 0 })),
    getWorkspaceFeatureFlags(workspaceId),
    requireWorkspaceMembership({ actor, workspaceId }),
    getMemberInvitePolicy(workspaceId).catch(() => null),
  ]);
  const current = workspaces.find((w: Workspace) => w.id === workspaceId);
  const conversations = conversationsResult.items;
  const capabilities = buildWorkspaceCapabilities({ featureFlags, role: membership?.role ?? null });
  const visibleNavGroups = filterNavGroupsByWorkspaceAccess(navGroups, featureFlags, capabilities);
  const tNav = await getTranslations("nav");
  const tCommon = await getTranslations("common");
  const currentBranding = current ? workspaceBranding(current) : { primaryName: "Corgtex", secondaryLabel: "Workspace" };
  const controlPlaneHref = getControlPlaneHref("/control-plane", locale);
  const conversationSummaries = conversations.map((c: any) => ({
    id: c.id,
    topic: c.topic,
    agentKey: c.agentKey,
    status: c.status,
    updatedAt: c.updatedAt.toISOString(),
    lastMessage: c.turns?.[0]?.assistantMessage?.slice(0, 100) ?? null,
  }));

  return (
    <div className="ws-layout">
      <MobileWorkspaceShell
        workspaceId={workspaceId}
        workspaceName={currentBranding.primaryName}
        workspaceLabel={currentBranding.secondaryLabel}
        navGroups={visibleNavGroups}
        unreadCount={unreadCount}
        conversations={conversationSummaries}
      />
      <aside className="ws-sidebar">
        <div className="ws-sidebar-header">
          <a href="/" className="ws-logo">{currentBranding.primaryName}</a>
          {current && (
            <div className="ws-workspace-name" style={{ marginTop: "2px", fontWeight: 500, opacity: 0.8, fontSize: "0.8rem", letterSpacing: "0.02em" }}>
              {currentBranding.secondaryLabel}
            </div>
          )}
        </div>

        <DesktopWorkspaceNav
          workspaceId={workspaceId}
          navGroups={visibleNavGroups}
          unreadCount={unreadCount}
          showPlatformAdmin={isGlobalOperator(actor)}
          controlPlaneHref={controlPlaneHref}
        />

        <div className="ws-sidebar-footer">
          {featureFlags.MULTILINGUAL && <LanguageSwitcher />}
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
        <WorkspaceAddMenu
          workspaceId={workspaceId}
          featureFlags={featureFlags}
          role={membership?.role ?? null}
          invitePolicy={invitePolicy}
          isDemo={current?.slug === "jnj-demo"}
        />
        <div className="ws-main-content">
          {current?.slug === "jnj-demo" && <DemoBanner />}
          {children}
        </div>
      </main>

      <WorkspaceChatRail workspaceId={workspaceId} conversations={conversationSummaries} />
      {current?.slug === "jnj-demo" && (
        <DemoTour workspaceId={workspaceId} />
      )}
    </div>
  );
}
