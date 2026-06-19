import { notFound } from "next/navigation";
import {
  getControlPlaneClientOptions,
  getControlPlaneLatestReleaseTarget,
  isControlPlaneRailwayDeployConfigured,
  listControlPlaneReleaseRolloutJobs,
  requireControlPlaneAccess,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { normalizeSelectedValues } from "@/lib/filter-query";
import { prisma } from "@corgtex/shared";
import { Link } from "@/i18n/routing";
import { enqueueDeployLatestRolloutAction } from "../actions";
import { ClientContextSwitcher } from "../_components/client-context-switcher";
import {
  ControlPlanePageHeader,
  ControlPlaneSection,
  DisabledActionHint,
  StatusBadge,
  controlPlaneButtonClass,
  controlPlaneInputClass,
} from "../_components/control-plane-ui";

export const dynamic = "force-dynamic";

function releaseLabel(imageTag?: string | null, version?: string | null) {
  if (imageTag && version) return `${imageTag} / ${version}`;
  return imageTag || version || "Unknown";
}

export default async function ControlPlaneReleasesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const clientFilters = normalizeSelectedValues(raw?.client);
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  const [deployments, rollouts, clientOptions] = await Promise.all([
    prisma.customerDeployment.findMany({ orderBy: { createdAt: "desc" } }),
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
  const rolloutBlocker = !latestReleaseTarget
    ? "Latest release target is not configured."
    : releaseExecutionConfigured
      ? null
      : "Railway token is not configured for rollout execution.";
  const targetVersionLabel = latestReleaseTarget
    ? releaseLabel(latestReleaseTarget.releaseImageTag, latestReleaseTarget.releaseVersion)
    : "Not configured";

  const filteredDeployments = clientFilters.length > 0
    ? deployments.filter((deployment: any) => clientFilters.includes(deployment.id))
    : deployments;
  const formattedFleet = filteredDeployments.map((deployment: any) => {
    const targetDiffers = latestReleaseTarget
      ? latestReleaseTarget.releaseImageTag !== deployment.releaseImageTag
        || latestReleaseTarget.releaseVersion !== (deployment.releaseVersion ?? null)
      : false;
    return {
      id: deployment.id,
      name: deployment.label,
      slug: deployment.customerSlug || "default-slug",
      currentVersion: releaseLabel(deployment.releaseImageTag, deployment.releaseVersion),
      targetVersion: targetVersionLabel,
      drift: targetDiffers,
      region: deployment.region || "us-east1",
    };
  });

  return (
    <div className="space-y-5">
      <ControlPlanePageHeader
        eyebrow="Observe and upgrade"
        title="Releases and Upgrade Cockpit"
        description="Track release versions, rollout eligibility, target drift, and queued deploy-latest jobs across hosted environments."
        actions={
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-bg-alt p-3">
            <ClientContextSwitcher
              clients={clientOptions}
              selectedClientIds={clientFilters}
              mode="filter"
              label="Client"
            />
            <form action={enqueueDeployLatestRolloutAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase text-muted">
                  Bulk upgrade reason
                </label>
                <input
                  name="reason"
                  required
                  defaultValue="Staged fleet upgrade following production release verification."
                  className={`${controlPlaneInputClass} w-64`}
                />
              </div>
              <input type="hidden" name="allEligible" value="true" />
              <input type="hidden" name="limit" value="100" />
              <button type="submit" disabled={!canQueueReleaseRollouts} className={controlPlaneButtonClass}>
                {releaseQueueLabel}
              </button>
            </form>
            {rolloutBlocker && <DisabledActionHint>{rolloutBlocker}</DisabledActionHint>}
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <ControlPlaneSection
          title="Fleet Version Distribution Matrix"
          description="Summary of version alignment and recorded client drifts."
          className="lg:col-span-2"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                  <th className="p-3">Environment</th>
                  <th className="p-3">Current Version</th>
                  <th className="p-3">Target Version</th>
                  <th className="p-3">Status</th>
                  <th className="p-3">Region</th>
                  <th className="p-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {formattedFleet.map((env) => (
                  <tr key={env.id} className="hover:bg-surface/40">
                    <td className="p-3">
                      <span className="block font-semibold text-white">{env.name}</span>
                      <span className="mt-0.5 block text-[10px] text-muted">slug: {env.slug}</span>
                    </td>
                    <td className="p-3 font-mono font-medium text-text">{env.currentVersion}</td>
                    <td className="p-3 font-mono font-medium text-muted">{env.targetVersion}</td>
                    <td className="p-3">
                      <StatusBadge status={env.drift ? "failed" : "aligned"}>{env.drift ? "Drift" : "Aligned"}</StatusBadge>
                    </td>
                    <td className="p-3 font-medium uppercase text-muted">{env.region}</td>
                    <td className="p-3 text-right">
                      <Link href={`/control-plane/deployments/${env.id}`} className={controlPlaneButtonClass}>
                        Rollout
                      </Link>
                    </td>
                  </tr>
                ))}
                {formattedFleet.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-muted">
                      No customer deployments are registered in the control plane.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </ControlPlaneSection>

        <ControlPlaneSection title="Upgrade Rollout Queue" description="Recent deploy-latest rollout status logs.">
          <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1 scrollbar-thin">
            {rollouts.map((rollout) => (
              <div key={rollout.id} className="space-y-2 rounded-md border border-line bg-surface p-3">
                <div className="flex items-center justify-between gap-3">
                  <strong className="text-xs text-white">Staged Job {rollout.id.slice(0, 8)}</strong>
                  <StatusBadge status={rollout.status}>{rollout.status}</StatusBadge>
                </div>
                <div className="flex justify-between gap-3 text-[10px] text-muted">
                  <span>Attempts: {rollout.attempts}</span>
                  <span>Started: {new Date(rollout.createdAt).toLocaleDateString()}</span>
                </div>
                {rollout.error && (
                  <p className="whitespace-pre-wrap font-mono text-[10px] leading-4 text-rose-400">{rollout.error}</p>
                )}
              </div>
            ))}
            {rollouts.length === 0 && (
              <div className="py-6 text-center text-xs text-muted">No rollout jobs queued yet.</div>
            )}
          </div>
        </ControlPlaneSection>
      </div>
    </div>
  );
}
