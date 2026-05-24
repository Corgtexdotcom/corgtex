import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { requireControlPlaneAccess, listControlPlaneReleaseRolloutJobs } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { Link } from "@/i18n/routing";
import { enqueueDeployLatestRolloutAction } from "../actions";
import { cn } from "@/lib/utils";
import {
  GitBranch,
  Shuffle,
  ShieldCheck,
  CheckCircle,
  AlertTriangle,
  Radio,
  Cpu,
  Clock,
  ArrowRight,
} from "lucide-react";

export const dynamic = "force-dynamic";

function statusTone(status?: string | null) {
  if (status === "ok" || status === "active" || status === "connected" || status === "COMPLETED") return "text-emerald-400 border-emerald-500/20 bg-emerald-500/10";
  if (status === "attention" || status === "degraded" || status === "provisioning" || status === "configured" || status === "pending") return "text-amber-400 border-amber-500/20 bg-amber-500/10";
  return "text-rose-400 border-rose-500/20 bg-rose-500/10";
}

export default async function ControlPlaneReleasesPage() {
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  // Fetch all customer deployments and recent rollouts using Prisma
  const [deployments, rollouts] = await Promise.all([
    prisma.customerDeployment.findMany({
      orderBy: { createdAt: "desc" },
    }),
    listControlPlaneReleaseRolloutJobs(actor, { take: 10 }),
  ]);

  const format = await getFormatter();

  // Map deployments to version items
  const formattedFleet = deployments.length > 0 
    ? deployments.map((ws: any) => ({
        id: ws.id,
        name: ws.label,
        slug: ws.customerSlug || "default-slug",
        status: ws.deploymentStatus,
        currentVersion: ws.releaseVersion || "v1.2.3",
        targetVersion: "v1.3.0",
        drift: ws.deploymentStatus === "DEGRADED" ? "Release drift" : null,
        region: ws.region || "us-east1",
        lastDeploy: "3 days ago",
      }))
    : [
        { id: "1", name: "Crina Workspace", slug: "crina", status: "ACTIVE", currentVersion: "v1.2.3", targetVersion: "v1.3.0", drift: "Release drift (v1.2.3 vs v1.3.0)", region: "europe-west1", lastDeploy: "2 days ago" },
        { id: "2", name: "Alumipres Corp", slug: "alumipres", status: "ACTIVE", currentVersion: "v1.3.0", targetVersion: "v1.3.0", drift: null, region: "us-east1", lastDeploy: "1d ago" },
        { id: "3", name: "Vance Corp", slug: "vance", status: "ACTIVE", currentVersion: "v1.1.0", targetVersion: "v1.3.0", drift: "Major drift (v1.1.0 vs v1.3.0)", region: "us-west2", lastDeploy: "1 week ago" },
      ];

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#1f2430] pb-6">
        <div>
          <span className="text-[10px] font-bold tracking-widest text-brand-400 uppercase">
            Observe & Upgrade
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-white mt-1">
            Releases and Upgrade Cockpit
          </h1>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Track release versions, preflight staging checklists, rollbacks, and version drifts across all hosted environments. Trigger cluster upgrades with audited rationale logs.
          </p>
        </div>

        {/* Global Bulk Rollout Trigger */}
        <div className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-4 flex items-center gap-4">
          <form action={enqueueDeployLatestRolloutAction} className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div>
              <label className="text-[9px] font-bold text-slate-500 uppercase block mb-1">Bulk Upgrade Reason</label>
              <input
                name="reason"
                required
                defaultValue="Staged fleet upgrade following production release verification."
                className="bg-[#141822] border border-[#202738] text-xs text-slate-300 rounded px-2 py-1 w-64 focus:outline-none"
              />
            </div>
            <input type="hidden" name="allEligible" value="true" />
            <input type="hidden" name="limit" value="100" />
            <button
              type="submit"
              className="bg-brand-600 hover:bg-brand-500 text-white font-semibold text-xs px-3.5 py-1.5 rounded shadow transition-all duration-150 h-8"
            >
              Upgrade All Eligible
            </button>
          </form>
        </div>
      </div>

      {/* Releases telemetry matrices */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Version Matrix Table (Col Span 2) */}
        <div className="lg:col-span-2 bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h2 className="text-sm font-bold text-white">Fleet Version Distribution Matrix</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">Summary of version alignment and recorded client drifts.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#1f2430] text-slate-400 text-left font-medium">
                  <th className="p-3">Environment</th>
                  <th className="p-3">Current Version</th>
                  <th className="p-3">Target Version</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Region</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1f2430]/60">
                {formattedFleet.map((env) => (
                  <tr key={env.id} className="hover:bg-[#141822]/40 transition-colors">
                    <td className="p-3">
                      <span className="font-semibold text-white block">{env.name}</span>
                      <span className="text-[9px] text-slate-500 block mt-0.5">slug: {env.slug}</span>
                    </td>
                    <td className="p-3 text-slate-300 font-mono font-medium">{env.currentVersion}</td>
                    <td className="p-3 text-slate-500 font-mono font-medium">{env.targetVersion}</td>
                    <td className="p-3">
                      {env.drift ? (
                        <span className="px-2 py-0.5 rounded text-[9px] font-bold border border-rose-500/20 bg-rose-500/10 text-rose-400">
                          Drift
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-[9px] font-bold border border-emerald-500/20 bg-emerald-500/10 text-emerald-400">
                          Aligned
                        </span>
                      )}
                    </td>
                    <td className="p-3 text-slate-400 font-medium uppercase">{env.region}</td>
                    <td className="p-3 text-right">
                      <Link
                        href={`/control-plane/deployments/${env.id}`}
                        className="inline-flex items-center gap-1 bg-[#141822] hover:bg-[#1d2333] border border-[#202738] text-slate-300 px-2.5 py-1 rounded text-[10px] font-medium transition-colors"
                      >
                        Rollout
                        <ArrowRight className="w-3 h-3 text-slate-500" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Upgrade Rollout Progress logs (Col Span 1) */}
        <div className="bg-[#0b0d12] border border-[#1f2430] rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
              <Cpu className="w-4 h-4 text-brand-400" />
              Upgrade Rollout Queue
            </h3>
            <p className="text-[10px] text-slate-500 mt-0.5">Recent deploy latest rollout status logs.</p>
          </div>

          <div className="space-y-3 max-h-[360px] overflow-y-auto scrollbar-thin pr-1">
            {rollouts.map((rollout) => {
              const status = rollout.status;
              
              return (
                <div key={rollout.id} className="p-3 rounded-lg bg-[#141822] border border-[#202738] space-y-2">
                  <div className="flex items-center justify-between">
                    <strong className="text-xs text-white">Staged Job {rollout.id.slice(0, 8)}</strong>
                    <span className={cn("px-1.5 py-0.5 rounded text-[8px] font-bold uppercase border tracking-wider shrink-0", statusTone(status))}>
                      {status}
                    </span>
                  </div>
                  <div className="text-[9px] text-slate-500 flex justify-between">
                    <span>Attempts: {rollout.attempts}</span>
                    <span>Started: {new Date(rollout.createdAt).toLocaleDateString()}</span>
                  </div>
                  {rollout.error && (
                    <p className="text-[9px] text-rose-400 font-mono mt-1 whitespace-pre-wrap leading-tight">{rollout.error}</p>
                  )}
                </div>
              );
            })}
            {rollouts.length === 0 && (
              <div className="text-center py-6 text-slate-500 text-[10px]">No rollout jobs queued yet.</div>
            )}
          </div>
        </div>

      </div>

    </div>
  );
}
