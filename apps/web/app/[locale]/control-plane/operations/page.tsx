import { notFound } from "next/navigation";
import { getControlPlaneClientOptions, requireControlPlaneAccess } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import { normalizeSelectedValues } from "@/lib/filter-query";
import { prisma } from "@corgtex/shared";
import { Link } from "@/i18n/routing";
import { ClientContextSwitcher } from "../_components/client-context-switcher";
import {
  ControlPlanePageHeader,
  ControlPlaneSection,
  ControlPlaneStatusStrip,
  StatusBadge,
  controlPlaneButtonClass,
} from "../_components/control-plane-ui";

export const dynamic = "force-dynamic";

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalTextValue(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newspaperDeliveryAlertFromPayload(value: unknown) {
  const source = recordValue(value);
  if (!source) return null;
  const diagnostics = recordValue(source.diagnostics);
  const newspaperDiagnostics = recordValue(source.newspaperDiagnostics);
  const nestedNewspaperDiagnostics = recordValue(newspaperDiagnostics?.diagnostics);
  const alert = [
    recordValue(source.deliveryAlert),
    recordValue(diagnostics?.deliveryAlert),
    recordValue(newspaperDiagnostics?.deliveryAlert),
    recordValue(nestedNewspaperDiagnostics?.deliveryAlert),
  ].find((candidate) => optionalTextValue(candidate?.state)) ?? null;
  return optionalTextValue(alert?.state) === "attention" ? alert : null;
}

function newspaperAlertSummary(alert: Record<string, unknown>) {
  const recipients = Array.isArray(alert.affectedRecipients)
    ? alert.affectedRecipients.map(recordValue).filter(Boolean)
    : [];
  const latestError = optionalTextValue(recipients.find((recipient) => optionalTextValue(recipient?.error))?.error)
    ?? optionalTextValue(alert.reason)
    ?? "provider/runtime issue detected";
  return [
    `run ${optionalTextValue(alert.latestRunKey) ?? "unknown"}`,
    `${numberValue(alert.failedCount)} failed`,
    `${numberValue(alert.skippedAttentionCount)} skipped`,
    `${numberValue(alert.providerFailureCount)} provider events`,
    latestError.slice(0, 160),
  ].join(" / ");
}

export default async function ControlPlaneOperationsPage({
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

  // Fetch real operations audit logs from database using Prisma SupportOperation
  const [operations, clientOptions] = await Promise.all([
    prisma.supportOperation.findMany({
      where: clientFilters.length > 0 ? { deploymentId: { in: clientFilters } } : undefined,
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
    }),
    getControlPlaneClientOptions(actor),
  ]);

  const formattedOps = operations.map((op: any) => {
    const actionKey = op.action.toLowerCase();
    const newspaperAlert = op.action === "newspaper.diagnostics" && op.status === "COMPLETED"
      ? newspaperDeliveryAlertFromPayload(op.resultSummary)
      : null;
    return {
      id: op.id,
      type: op.action,
      status: op.status,
      description: op.reason || "Support operation executed",
      isBreakGlass: actionKey.includes("break_glass") || actionKey.includes("emergency"),
      isMutating: ["create", "update", "set", "deploy", "revoke", "configure", "suspend"].some((keyword) => actionKey.includes(keyword)),
      customerName: op.deployment?.label || "Global System",
      customerId: op.deployment?.id,
      actorName: op.actor?.displayName || op.actor?.email || op.actorLabel || "System Daemon",
      createdAt: op.createdAt.toLocaleString(),
      error: op.error,
      newspaperAlert,
    };
  });

  const totalOps = formattedOps.length;
  const breakGlassCount = formattedOps.filter((o: any) => o.isBreakGlass).length;
  const errorCount = formattedOps.filter((o: any) => o.status === "FAILED").length;
  const newspaperAttentionCount = formattedOps.filter((o: any) => o.newspaperAlert).length;

  return (
    <div className="space-y-5">
      <ControlPlanePageHeader
        eyebrow="Operate and audit"
        title="Operational Audit Logs"
        description="Central audit trail for platform actions, background syncs, feature flag changes, and emergency support sessions."
        actions={
          <div className="rounded-lg border border-line bg-bg-alt p-3">
            <ClientContextSwitcher
              clients={clientOptions}
              selectedClientIds={clientFilters}
              mode="filter"
              label="Client"
            />
          </div>
        }
      />

      <ControlPlaneStatusStrip
        items={[
          { label: "Operations", value: totalOps, detail: "logged" },
          { label: "Mutations", value: formattedOps.filter((o: any) => o.isMutating).length, detail: "state changes" },
          { label: "Break-glass", value: breakGlassCount, detail: "incidents", status: breakGlassCount > 0 ? "degraded" : "ok" },
          { label: "Failures", value: errorCount, detail: "failed", status: errorCount > 0 ? "failed" : "ok" },
          { label: "Newspaper", value: newspaperAttentionCount, detail: "attention", status: newspaperAttentionCount > 0 ? "failed" : "ok" },
        ]}
      />

      <ControlPlaneSection
        title="Central Operational Audit Trail"
        description="Chronological ledger of reasoned mutations and platform inquiries."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                <th className="p-3">Type</th>
                <th className="p-3">Description</th>
                <th className="p-3">Client</th>
                <th className="p-3">Status</th>
                <th className="p-3">Actor</th>
                <th className="p-3">Recorded</th>
                <th className="p-3 text-right">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {formattedOps.map((op: any) => (
                <tr key={op.id} className="hover:bg-surface/40">
                  <td className="p-3">
                    <span className="block font-mono text-[10px] font-semibold tracking-wide text-brand-400">
                      {op.type}
                    </span>
                    {op.isBreakGlass && (
                      <span className="mt-0.5 block text-[9px] font-semibold uppercase tracking-wide text-amber-400">
                        Break-glass
                      </span>
                    )}
                  </td>
                  <td className="p-3 min-w-[240px]">
                    <span className="block font-medium text-text">{op.description}</span>
                    {op.newspaperAlert && (
                      <span className="mt-1 block rounded border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200">
                        {newspaperAlertSummary(op.newspaperAlert)}
                      </span>
                    )}
                    {op.error && <span className="mt-1 block font-mono text-[10px] text-rose-400">{op.error}</span>}
                  </td>
                  <td className="p-3 font-semibold text-text">{op.customerName}</td>
                  <td className="p-3"><StatusBadge status={op.newspaperAlert ? "attention" : op.status} /></td>
                  <td className="p-3 text-muted">{op.actorName}</td>
                  <td className="p-3 text-muted">{op.createdAt}</td>
                  <td className="p-3 text-right">
                    {op.customerId ? (
                      <Link href={`/control-plane/deployments/${op.customerId}?tab=logs`} className={controlPlaneButtonClass}>
                        Inspect
                      </Link>
                    ) : (
                      <span className="text-muted">-</span>
                    )}
                  </td>
                </tr>
              ))}
              {formattedOps.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-muted">
                    No control-plane operations have been recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </ControlPlaneSection>

    </div>
  );
}
