import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { Link } from "@/i18n/routing";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  User,
  ShieldCheck,
  Calendar,
  Layers,
  Clock,
  ArrowRight,
  TrendingUp,
} from "lucide-react";

export const dynamic = "force-dynamic";

function statusTone(status?: string | null) {
  if (status === "ok" || status === "active" || status === "connected" || status === "COMPLETED") return "text-emerald-400 border-emerald-500/20 bg-emerald-500/10";
  if (status === "attention" || status === "degraded" || status === "provisioning" || status === "configured" || status === "pending" || status === "IN_PROGRESS") return "text-amber-400 border-amber-500/20 bg-amber-500/10";
  return "text-rose-400 border-rose-500/20 bg-rose-500/10";
}

export default async function ControlPlaneOperationsPage() {
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  // Fetch real operations audit logs from database using Prisma SupportOperation
  const operations = await prisma.supportOperation.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      deployment: {
        select: {
          id: true,
          label: true,
          customerSlug: true,
        },
      },
      actor: {
        select: {
          id: true,
          displayName: true,
          email: true,
        },
      },
    },
  });

  const format = await getFormatter();

  // If DB is empty, provide realistic mock entries for immediate support visual verification
  const formattedOps = operations.length > 0
    ? operations.map((op: any) => ({
        id: op.id,
        type: op.action,
        status: op.status,
        description: op.reason || "Support operation executed",
        isBreakGlass: op.action === "BREAK_GLASS" || op.action.includes("BREAK_GLASS") || op.action.includes("emergency"),
        isMutating: op.action.includes("create") || op.action.includes("update") || op.action.includes("set") || op.action.includes("deploy") || op.action.includes("revoke") || op.action.includes("configure"),
        customerName: op.deployment?.label || "Global System",
        customerId: op.deployment?.id,
        actorName: op.actor?.displayName || op.actor?.email || op.actorLabel || "System Daemon",
        createdAt: op.createdAt.toLocaleString(),
        error: op.error,
      }))
    : [
        { id: "o1", type: "WORKSPACE_CREATE", status: "COMPLETED", description: "Create workspace for Beacon Manufacturing", isBreakGlass: false, isMutating: true, customerName: "Beacon Manufacturing", customerId: "2", actorName: "ops@corgtex.local", createdAt: "10 mins ago" },
        { id: "o2", type: "DEPLOY", status: "COMPLETED", description: "Deploy latest stable release tag", isBreakGlass: false, isMutating: true, customerName: "Atlas Workspace", customerId: "1", actorName: "system", createdAt: "2h ago" },
        { id: "o3", type: "HEALTH_CHECK", status: "FAILED", description: "Probing live environment endpoint", isBreakGlass: false, isMutating: false, customerName: "Beacon Manufacturing", customerId: "2", actorName: "system", createdAt: "4h ago", error: "Connection timeout on endpoint" },
        { id: "o4", type: "USER_SUSPEND", status: "COMPLETED", description: "Suspend direct infrastructure access key", isBreakGlass: true, isMutating: true, customerName: "Summit Media", customerId: "3", actorName: "support@corgtex.local", createdAt: "1d ago" },
      ];

  const totalOps = formattedOps.length;
  const breakGlassCount = formattedOps.filter((o: any) => o.isBreakGlass).length;
  const errorCount = formattedOps.filter((o: any) => o.status === "FAILED").length;

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      
      {/* Header */}
      <div>
        <span className="text-[10px] font-bold tracking-widest text-brand-400 uppercase">
          Operate & Audit
        </span>
        <h1 className="text-2xl font-bold tracking-tight text-white mt-1">
          Operational Audit Logs
        </h1>
        <p className="text-xs text-slate-400 mt-1 max-w-2xl">
          Unified central audit trail tracking all platform actions, background syncs, feature flag changes, and emergency break-glass sessions across the fleet.
        </p>
      </div>

      {/* Top Indicators Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: "Total Operations", value: totalOps, detail: "logged across fleet", icon: Activity, tone: "text-slate-400" },
          { title: "Mutating Events", value: formattedOps.filter((o: any) => o.isMutating).length, detail: "state alterations recorded", icon: Layers, tone: "text-indigo-400" },
          { title: "Break-Glass Incidents", value: breakGlassCount, detail: "emergency sessions logged", icon: AlertTriangle, tone: breakGlassCount > 0 ? "text-amber-500" : "text-slate-400" },
          { title: "Failed Processes", value: errorCount, detail: "workflow errors recorded", icon: ShieldCheck, tone: errorCount > 0 ? "text-rose-400" : "text-slate-400" },
        ].map((stat, i) => {
          const Icon = stat.icon;
          return (
            <div key={i} className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-4 flex justify-between items-start">
              <div className="space-y-1">
                <span className="text-[10px] text-slate-500 font-semibold uppercase">{stat.title}</span>
                <span className="text-xl font-bold text-white block">{stat.value}</span>
                <span className="text-[10px] text-slate-400 block">{stat.detail}</span>
              </div>
              <div className={cn("p-2 rounded-lg bg-[#141822] border border-[#202738]", stat.tone)}>
                <Icon className="w-4 h-4" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Operations log table */}
      <div className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm space-y-4">
        <div>
          <h2 className="text-sm font-bold text-white">Central Operational Audit Trail</h2>
          <p className="text-[10px] text-slate-500 mt-0.5">Chronological ledger of reasoned mutations and platform inquiries.</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#1f2430] text-slate-400 text-left font-medium">
                <th className="p-3">Incident / Type</th>
                <th className="p-3">Description</th>
                <th className="p-3">Customer Context</th>
                <th className="p-3">Status</th>
                <th className="p-3">Actor</th>
                <th className="p-3">Recorded</th>
                <th className="p-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1f2430]/60">
              {formattedOps.map((op: any) => (
                <tr key={op.id} className={cn("hover:bg-[#141822]/40 transition-colors", op.isBreakGlass && "bg-amber-500/[0.02]")}>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      {op.isBreakGlass && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                      <span className={cn("font-mono font-bold tracking-wide text-[10px]", op.isBreakGlass ? "text-amber-400" : "text-brand-400")}>
                        {op.type}
                      </span>
                    </div>
                    {op.isBreakGlass && (
                      <span className="text-[8px] font-bold text-amber-500 uppercase tracking-widest block mt-0.5">
                        Break-glass
                      </span>
                    )}
                  </td>
                  <td className="p-3 min-w-[200px]">
                    <span className="text-slate-200 block font-medium">{op.description}</span>
                    {op.error && (
                      <span className="text-[9px] font-mono text-rose-400 block mt-1">{op.error}</span>
                    )}
                  </td>
                  <td className="p-3 font-semibold text-slate-300">
                    {op.customerName}
                  </td>
                  <td className="p-3">
                    <span className={cn("px-2 py-0.5 rounded-full text-[9px] font-bold border uppercase shrink-0", statusTone(op.status))}>
                      {op.status}
                    </span>
                  </td>
                  <td className="p-3 text-slate-400 font-medium">
                    {op.actorName}
                  </td>
                  <td className="p-3 text-slate-500 font-semibold">
                    {op.createdAt}
                  </td>
                  <td className="p-3 text-right">
                    {op.customerId ? (
                      <Link
                        href={`/control-plane/deployments/${op.customerId}?tab=logs`}
                        className="inline-flex items-center gap-1 bg-[#141822] hover:bg-[#1d2333] border border-[#202738] text-slate-300 px-2 py-1 rounded text-[10px] font-medium transition-colors"
                      >
                        Inspect
                        <ArrowRight className="w-3 h-3 text-slate-500" />
                      </Link>
                    ) : (
                      <span className="text-slate-600">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
