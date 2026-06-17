import { isGlobalOperator, listActorWorkspaces, countUnreadNotifications, listConversations, listDailyCompanyUnderstandingQuestions, requireWorkspaceMembership, getMemberInvitePolicy, getMeetingRecorderConfig, getUserWorkspaceOnboardingState, getAiWorkspaceSelectionState, resolveWorkspaceModuleAccess, SELF_SERVE_WORKSPACE_TOUR_KEY, SELF_SERVE_WORKSPACE_TOUR_VERSION } from "@corgtex/domain";
import { workspaceBranding, prisma } from "@corgtex/shared";
import type { Metadata } from "next";
import { logoutAction, requirePageActor } from "@/lib/auth";
import { DemoTour } from "./DemoTour";
import { DemoBanner } from "./DemoBanner";
import { WorkspaceOnboardingTour } from "./WorkspaceOnboardingTour";
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
import { WorkspaceIntercomMessenger } from "./WorkspaceIntercomMessenger";
import type { AiWorkspaceLaunchState } from "@/lib/ai-workspace-launch";
import { getMobileCaptureActions } from "@/lib/workspace-add-actions";

export const dynamic = "force-dynamic";

type Workspace = Awaited<ReturnType<typeof listActorWorkspaces>>[number];

import { WORKSPACE_NAV_GROUPS as navGroups } from "@/lib/nav-config";

async function hasWorkspaceInitialKnowledge(workspaceId: string) {
  const [documentCount, brainSourceCount, meetingCount, knowledgeChunkCount] = await Promise.all([
    prisma.document.count({
      where: { workspaceId, archivedAt: null },
    }),
    prisma.brainSource.count({
      where: {
        workspaceId,
        archivedAt: null,
        sourceType: { in: ["FILE_UPLOAD", "DOC", "ARTICLE", "MEETING"] },
      },
    }),
    prisma.meeting.count({
      where: {
        workspaceId,
        archivedAt: null,
        OR: [
          { transcript: { not: null } },
          { summaryMd: { not: null } },
        ],
      },
    }),
    prisma.knowledgeChunk.count({
      where: {
        workspaceId,
        sourceType: { in: ["DOCUMENT", "MEETING"] },
      },
    }),
  ]);
  return documentCount + brainSourceCount + meetingCount + knowledgeChunkCount > 0;
}

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
  const [workspaces, unreadCount, conversationsResult, dailyQuestions, featureFlags, membership, invitePolicy, workspaceRuntime, onboardingState, hasInitialKnowledge] = await Promise.all([
    listActorWorkspaces(actor),
    userId ? countUnreadNotifications(userId, workspaceId) : Promise.resolve(0),
    listConversations(actor, workspaceId, { take: 30 }).catch(() => ({ items: [], total: 0, take: 30, skip: 0 })),
    userId ? listDailyCompanyUnderstandingQuestions(actor, { workspaceId, take: 3 }).catch(() => []) : Promise.resolve([]),
    getWorkspaceFeatureFlags(workspaceId),
    requireWorkspaceMembership({ actor, workspaceId }),
    getMemberInvitePolicy(workspaceId).catch(() => null),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } }),
    actor.kind === "user" ? getUserWorkspaceOnboardingState(actor, {
      workspaceId,
      tourKey: SELF_SERVE_WORKSPACE_TOUR_KEY,
      tourVersion: SELF_SERVE_WORKSPACE_TOUR_VERSION,
    }).catch(() => null) : Promise.resolve(null),
    hasWorkspaceInitialKnowledge(workspaceId).catch(() => false),
  ]);
  const current = workspaces.find((w: Workspace) => w.id === workspaceId);
  const conversations = conversationsResult.items;
  const capabilities = buildWorkspaceCapabilities({ featureFlags, role: membership?.role ?? null });
  const moduleAccess = await resolveWorkspaceModuleAccess({
    workspaceId,
    memberId: membership?.id ?? null,
    role: membership?.role ?? null,
  }).catch(() => undefined);
  const visibleNavGroups = filterNavGroupsByWorkspaceAccess(navGroups, featureFlags, capabilities, moduleAccess);
  const tNav = await getTranslations("nav");
  const tCommon = await getTranslations("common");
  const currentBranding = current ? workspaceBranding(current) : { primaryName: "Corgtex", secondaryLabel: "Workspace" };
  const controlPlaneHref = getControlPlaneHref("/control-plane", locale);
  const isDemo = current?.slug === "jnj-demo";
  const showSelfServeOnboarding = !isDemo && workspaceRuntime?.plan !== "ENTERPRISE_MANAGED" && Boolean(onboardingState);
  const meetingRecorderConfig = !isDemo && featureFlags.MEETING_RECORDERS
    ? await getMeetingRecorderConfig(actor, workspaceId).catch(() => null)
    : null;
  const meetingRecorderEnabled = Boolean(
    featureFlags.MEETING_RECORDERS && meetingRecorderConfig?.featureEnabled && meetingRecorderConfig.config.enabled,
  );
  const aiWorkspaceSelection = await getAiWorkspaceSelectionState(actor, workspaceId)
    .catch(() => ({ activeProviderKey: null, providers: [], connections: [] }));
  const aiWorkspaceState: AiWorkspaceLaunchState = {
    activeProviderKey: aiWorkspaceSelection.activeProviderKey,
    connections: aiWorkspaceSelection.connections.map((connection) => ({
      providerKey: connection.providerKey,
      healthStatus: connection.healthStatus,
      isDefault: connection.isDefault,
      connectedAt: connection.connectedAt?.toISOString() ?? null,
      lastCheckedAt: connection.lastCheckedAt?.toISOString() ?? null,
      verificationSource: connection.verificationSource,
    })),
    providers: aiWorkspaceSelection.providers.map((provider) => ({
      key: provider.key,
      label: provider.label,
      shortLabel: provider.shortLabel,
      outcome: provider.outcome,
      description: provider.description,
      recommendedDefault: provider.recommendedDefault,
      freeDefault: provider.freeDefault,
      setupVariants: provider.setupVariants.map((variant) => ({
        variantKey: variant.variantKey,
        label: variant.label,
        audience: variant.audience,
        primaryAction: variant.primaryAction,
        manualSteps: [...variant.manualSteps],
        limitations: [...variant.limitations],
        verificationPrompt: variant.verificationPrompt,
      })),
    })),
  };
  const captureActions = getMobileCaptureActions({
    workspaceId,
    featureFlags,
    role: membership?.role ?? null,
    invitePolicy,
    meetingRecorderEnabled,
    isDemo,
  });
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
        aiWorkspaceState={aiWorkspaceState}
        captureActions={captureActions}
      />
      <aside className="ws-sidebar">
        <div className="ws-sidebar-header">
          <a href="/" className="ws-logo">{currentBranding.primaryName}</a>
          {current && (
            <div className="ws-workspace-name">
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
          <WorkspaceIntercomMessenger locale={locale} workspaceId={workspaceId} />
          
          <a href={`/workspaces/${workspaceId}/settings?tab=user`} className="ws-nav-link ws-logout-btn mt-1">
            {tNav("settings")} (User)
          </a>

          <form action={logoutAction} className="mt-1">
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
          meetingRecorderEnabled={meetingRecorderEnabled}
          isDemo={isDemo}
        />
        <div className="ws-main-content">
          {isDemo && <DemoBanner />}
          {children}
        </div>
      </main>

      <WorkspaceChatRail
        workspaceId={workspaceId}
        conversations={conversationSummaries}
        companyQuestions={dailyQuestions.map((question) => ({
          id: question.id,
          questionText: question.questionText,
          confidence: question.confidence,
          priority: question.priority,
          relatedConversationId: question.relatedConversationId,
          createdAt: question.createdAt.toISOString(),
        }))}
        aiWorkspaceState={aiWorkspaceState}
      />
      {isDemo && (
        <DemoTour workspaceId={workspaceId} />
      )}
      {showSelfServeOnboarding && (
        <WorkspaceOnboardingTour
          workspaceId={workspaceId}
          tourKey={SELF_SERVE_WORKSPACE_TOUR_KEY}
          tourVersion={SELF_SERVE_WORKSPACE_TOUR_VERSION}
          initialCompletedAt={onboardingState?.completedAt?.toISOString() ?? null}
          hasInitialKnowledge={hasInitialKnowledge}
          featureFlags={featureFlags}
          capabilities={capabilities}
        />
      )}
    </div>
  );
}
