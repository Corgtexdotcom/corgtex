import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { getAgentIdentity } from "@corgtex/domain";
import { AgentProfileClient } from "./AgentProfileClient";
import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

export default async function AgentProfilePage({
  params,
}: {
  params: Promise<{ workspaceId: string; agentId: string }>;
}) {
  const { workspaceId, agentId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("agents");

  const agent = await getAgentIdentity(actor, workspaceId, agentId).catch(() => null);
  if (!agent) {
    return notFound();
  }

  // Get last 10 runs
  const recentRuns = await prisma.agentRun.findMany({
    where: { workspaceId, agentKey: agent.agentKey },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, goal: true, status: true, triggerType: true, createdAt: true },
  });

  // Calculate 30-day spend
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const usageStats = await prisma.modelUsage.aggregate({
    where: {
      workspaceId,
      agentRun: { agentKey: agent.agentKey },
      createdAt: { gte: thirtyDaysAgo },
    },
    _sum: { estimatedCostUsd: true },
  });

  const costRaw = usageStats._sum.estimatedCostUsd;
  const thirtyDaySpendUsd = costRaw ? Number(costRaw) : 0;

  // Circles
  const allCircles = await prisma.circle.findMany({
    where: { workspaceId },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  
  const allRoles = await prisma.role.findMany({
    where: { circle: { workspaceId } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return (
    <div className="flex-1 overflow-y-auto bg-stone-50/50">
      <div className="mx-auto max-w-4xl px-4 py-8">
        <Link href={`/workspaces/${workspaceId}/members`} className="mb-6 inline-flex items-center text-sm text-stone-500 hover:text-stone-900 transition-colors">
          <span className="mr-1">&larr;</span>
          {t("backToMembers")}
        </Link>
        <div className="mb-8 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-serif text-stone-900 tracking-tight">{agent.displayName}</h1>
              <span className={`px-2 py-0.5 text-xs font-medium rounded-full border ${agent.memberType === "INTERNAL" ? "bg-amber-50 text-amber-900 border-amber-200" : "bg-purple-50 text-purple-900 border-purple-200"}`}>
                {agent.memberType === "INTERNAL" ? t("builtIn") : t("personalAgent")}
              </span>
              {!agent.isActive && (
                <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-stone-100 text-stone-500 border border-stone-200">
                  {t("inactive")}
                </span>
              )}
            </div>
            <p className="mt-2 text-stone-600 max-w-2xl">{agent.purposeMd || t("noPurpose")}</p>
            {agent.memberType === "EXTERNAL" && agent.createdByUser && (
              <p className="mt-1 text-sm text-stone-500">
                {t("connectedBy", { name: agent.createdByUser.displayName })}
              </p>
            )}
            <p className="mt-1 text-sm text-stone-400 font-mono">{t("key", { key: agent.agentKey })}</p>
          </div>
        </div>

        <AgentProfileClient
          agent={agent}
          workspaceId={workspaceId}
          recentRuns={recentRuns}
          thirtyDaySpendUsd={thirtyDaySpendUsd}
          allCircles={allCircles}
          allRoles={allRoles}
        />
      </div>
    </div>
  );
}
