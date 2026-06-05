import { notFound } from "next/navigation";
import { getControlPlaneClientOptions, getControlPlaneLatestReleaseTarget, isControlPlaneRailwayDeployConfigured, requireControlPlaneAccess, listControlPlaneReleaseRolloutJobs } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { prisma } from "@corgtex/shared";
import { Link } from "@/i18n/routing";
import { enqueueDeployLatestRolloutAction } from "../actions";
import { cn } from "@/lib/utils";
import { ClientContextSwitcher } from "../_components/client-context-switcher";
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

function releaseLabel(imageTag?: string | null, version?: string | null) {
  if (imageTag && version) return `${imageTag} / ${version}`;
  return imageTag || version || "Unknown";
}

export default async function ControlPlaneReleasesPage({
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

  // Fetch all customer deployments and recent rollouts using Prisma
  const [deployments, rollouts, clientOptions] = await Promise.all([
    prisma.customerDeployment.findMany({
      orderBy: { createdAt: "desc" },
    }),
    listControlPlaneReleaseRolloutJobs(actor, { take: 10 }),
    getControlPlaneClientOptions(actor),
  ]);

  const latestReleaseTarget = getControlPlaneLatestReleaseTarget();
  const releaseExecutionConfigured = isControlPlaneRailwayDeployConfigured();
  const canQueueReleaseRollouts = Boolean(latestReleaseTarget && releaseExecutionConfigured);
  const releaseQueueLabel = !latestReleaseTarget
    ? "Latest release not configured"
    : releaseExecutionConfigured
      ? "Upgrade All Eligible"
      : "Railway token not configured";
  const targetVersionLabel = latestReleaseTarget
    ? releaseLabel(latestReleaseTarget.releaseImageTag, latestReleaseTarget.releaseVersion)
    : "Not configured";

  const filteredDeployments = raw?.client
    ? deployments.filter((deployment: any) => deployment.id === raw.client)
    : deployments;
  const formattedFleet = filteredDeployments.map((ws: any) => {
    const targetDiffers = latestReleaseTarget
      ? latestReleaseTarget.releaseImageTag !== ws.releaseImageTag
        || latestReleaseTarget.releaseVersion !== (ws.releaseVersion ?? null)
      : false;
    return {
      id: ws.id,
      name: ws.label,
      slug: ws.customerSlug || "default-slug",
      status: ws.deploymentStatus,
      currentVersion: releaseLabel(ws.releaseImageTag, ws.releaseVersion),
      targetVersion: targetVersionLabel,
      drift: targetDiffers ? `Target differs from current ${releaseLabel(ws.releaseImageTag, ws.releaseVersion)}` : null,
      region: ws.region || "us-east1",
      lastDeploy: ws.lastReleaseCheck ? ws.lastReleaseCheck.toLocaleString() : "Not checked",
    };
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-line pb-6">
        <div>
          <span className="text-[10px] font-bold tracking-widest text-brand-400 uppercase">
            Observe & Upgrade
          </span>
          <h1 className="text-2xl font-bold tracking-tight text-white mt-1">
            Releases and Upgrade Cockpit
          </h1>
          <p className="text-xs text-muted mt-1 max-w-2xl">
            Track release versions, preflight staging checklists, rollbacks, and version drifts across all hosted environments. Trigger cluster upgrades with audited rationale logs.
          </p>
        </div>

        {/* Global Bulk Rollout Trigger */}
        <div className="bg-bg-alt border border-line rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-4">
          <ClientContextSwitcher
            clients={clientOptions}
            selectedClientId={raw?.client ?? ""}
            mode="filter"
            label="Client"
          />
          <form action={enqueueDeployLatestRolloutAction} className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div>
              <label className="text-[9px] font-bold text-muted uppercase block mb-1">Bulk Upgrade Reason</label>
              <input
                name="reason"
                required
                defaultValue="Staged fleet upgrade following production release verification."
                className="bg-surface border border-line text-xs text-text rounded px-2 py-1 w-64 focus:outline-none"
              />
            </div>
            <input type="hidden" name="allEligible" value="true" />
            <input type="hidden" name="limit" value="100" />
            <button
              type="submit"
              disabled={!canQueueReleaseRollouts}
              className={cn(
                "font-semibold text-xs px-3.5 py-1.5 rounded shadow transition-all duration-150 h-8",
                canQueueReleaseRollouts
                  ? "bg-brand-600 hover:bg-brand-500 text-white"
                  : "bg-surface/40 border border-line/60 text-muted cursor-not-allowed"
              )}
            >
              {releaseQueueLabel}
            </button>
          </form>
        </div>
      </div>

      {/* Releases telemetry matrices */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Version Matrix Table (Col Span 2) */}
        <div className="lg:col-span-2 bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h2 className="text-sm font-bold text-white">Fleet Version Distribution Matrix</h2>
            <p className="text-[10px] text-muted mt-0.5">Summary of version alignment and recorded client drifts.</p>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-line text-muted text-left font-medium">
                  <th className="p-3">Environment</th>
                  <th className="p-3">Current Version</th>
                  <th className="p-3">Target Version</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Region</th>
                  <th className="p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {formattedFleet.map((env) => (
                  <tr key={env.id} className="hover:bg-surface/40 transition-colors">
                    <td className="p-3">
                      <span className="font-semibold text-white block">{env.name}</span>
                      <span className="text-[9px] text-muted block mt-0.5">slug: {env.slug}</span>
                    </td>
                    <td className="p-3 text-text font-mono font-medium">{env.currentVersion}</td>
                    <td className="p-3 text-muted font-mono font-medium">{env.targetVersion}</td>
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
                    <td className="p-3 text-muted font-medium uppercase">{env.region}</td>
                    <td className="p-3 text-right">
                      <Link
                        href={`/control-plane/deployments/${env.id}`}
                        className="inline-flex items-center gap-1 bg-surface hover:bg-surface-strong border border-line text-text px-2.5 py-1 rounded text-[10px] font-medium transition-colors"
                      >
                        Rollout
                        <ArrowRight className="w-3 h-3 text-muted" />
                      </Link>
                    </td>
                  </tr>
                ))}
                {formattedFleet.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-8 text-muted">
                      No customer deployments are registered in the control plane.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Upgrade Rollout Progress logs (Col Span 1) */}
        <div className="bg-bg-alt border border-line rounded-xl p-5 shadow-sm space-y-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-1.5">
              <Cpu className="w-4 h-4 text-brand-400" />
              Upgrade Rollout Queue
            </h3>
            <p className="text-[10px] text-muted mt-0.5">Recent deploy latest rollout status logs.</p>
          </div>

          <div className="space-y-3 max-h-[360px] overflow-y-auto scrollbar-thin pr-1">
            {rollouts.map((rollout) => {
              const status = rollout.status;
              
              return (
                <div key={rollout.id} className="p-3 rounded-lg bg-surface border border-line space-y-2">
                  <div className="flex items-center justify-between">
                    <strong className="text-xs text-white">Staged Job {rollout.id.slice(0, 8)}</strong>
                    <span className={cn("px-1.5 py-0.5 rounded text-[8px] font-bold uppercase border tracking-wider shrink-0", statusTone(status))}>
                      {status}
                    </span>
                  </div>
                  <div className="text-[9px] text-muted flex justify-between">
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
              <div className="text-center py-6 text-muted text-[10px]">No rollout jobs queued yet.</div>
            )}
          </div>
        </div>

      </div>

    </div>
  );
}
