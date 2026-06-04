import { notFound } from "next/navigation";
import {
  CreditCard,
  MailCheck,
  ShieldCheck,
  Timer,
  UserRound,
  Users,
  Zap,
} from "lucide-react";
import { listSelfServeCustomerRegistry, requireControlPlaneAccess } from "@corgtex/domain";
import { Link } from "@/i18n/routing";
import { requirePageActor } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { SupportSessionButton } from "./_components/support-session-button";

export const dynamic = "force-dynamic";

type Registry = Awaited<ReturnType<typeof listSelfServeCustomerRegistry>>;
type RegistryItem = Registry["items"][number];

function formatDate(value?: Date | string | null) {
  if (!value) return "not set";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusTone(status?: string | null) {
  if (!status) return "border-slate-500/20 bg-slate-500/10 text-muted";
  if (["ACTIVE", "COMPLETED", "PASSED", "paid", "trialing", "active"].includes(status)) {
    return "border-emerald-500/20 bg-emerald-500/10 text-emerald-400";
  }
  if (["REVIEW_REQUIRED", "PENDING", "RUNNING", "configured", "past_due"].includes(status)) {
    return "border-amber-500/20 bg-amber-500/10 text-amber-400";
  }
  return "border-rose-500/20 bg-rose-500/10 text-rose-400";
}

function pill(status?: string | null) {
  return (
    <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide", statusTone(status))}>
      {status?.replace(/_/g, " ") ?? "unknown"}
    </span>
  );
}

function workspaceHref(item: RegistryItem) {
  if (item.deployment?.id) return `/control-plane/deployments/${item.deployment.id}`;
  if (item.workspace?.id) return `/workspaces/${item.workspace.id}`;
  return null;
}

function onboardingLabel(item: RegistryItem) {
  const onboardingStates = item.workspace?._count.onboardingStates ?? 0;
  const roleSessions = item.workspace?._count.roleOnboardingSessions ?? 0;
  if (onboardingStates > 0 && roleSessions > 0) return "workspace + role";
  if (onboardingStates > 0) return "workspace";
  if (roleSessions > 0) return "role";
  return "not started";
}

function latestSmokeStatus(item: RegistryItem) {
  return item.latestSmoke?.status ?? "not run";
}

export default async function ControlPlaneSelfServePage() {
  const actor = await requirePageActor();
  try {
    await requireControlPlaneAccess(actor);
  } catch {
    notFound();
  }

  const registry = await listSelfServeCustomerRegistry(actor, { take: 150 });
  const billingReady = registry.items.filter((item) => item.billing?.paymentMethodReady).length;
  const supportReady = registry.items.filter((item) => Boolean(item.latestSupportSession)).length;

  return (
    <div className="space-y-6 pb-12 animate-in fade-in duration-300">
      <div className="flex flex-col gap-4 border-b border-line pb-6 md:flex-row md:items-end md:justify-between">
        <div>
          <span className="text-[10px] font-bold uppercase tracking-widest text-brand-400">
            Shared-cloud launch surface
          </span>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
            Self-Serve Cloud Registry
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-muted">
            Registered trials, onboarding, billing readiness, latest browser/API smoke, setup-email capture, and audited support access across Corgtex Cloud.
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { title: "Customers", value: registry.summary.total, icon: Users, tone: "text-muted" },
            { title: "Smoke covered", value: registry.summary.smokeCovered, icon: Zap, tone: "text-indigo-400" },
            { title: "Billing ready", value: billingReady, icon: CreditCard, tone: "text-emerald-400" },
            { title: "Support used", value: supportReady, icon: ShieldCheck, tone: "text-amber-400" },
          ].map((stat) => {
            const Icon = stat.icon;
            return (
              <div key={stat.title} className="min-w-28 rounded-xl border border-line bg-bg-alt p-3 shadow-sm">
                <div className={cn("mb-2 inline-flex rounded-lg border border-line bg-surface p-1.5", stat.tone)}>
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted">{stat.title}</span>
                <span className="block text-xl font-bold text-white">{stat.value}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-xl border border-line bg-bg-alt p-5 shadow-sm">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-bold text-white">Actual registered trials and customers</h2>
            <p className="mt-0.5 text-[10px] text-muted">Sorted by signup time with latest operational state joined from the shared source-of-truth records.</p>
          </div>
          {registry.summary.failedSmoke > 0 && (
            <span className="inline-flex rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-rose-400">
              {registry.summary.failedSmoke} failed smoke
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] border-collapse text-xs">
            <thead>
              <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                <th className="p-3">Customer</th>
                <th className="p-3">Trial</th>
                <th className="p-3">Billing</th>
                <th className="p-3">Onboarding</th>
                <th className="p-3">Setup Email</th>
                <th className="p-3">Latest Smoke</th>
                <th className="p-3">Support</th>
                <th className="p-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {registry.items.map((item) => {
                const href = workspaceHref(item);
                return (
                  <tr key={item.trialId} className="hover:bg-surface/40">
                    <td className="p-3 align-top">
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 rounded-lg border border-line bg-surface p-1.5 text-brand-400">
                          <UserRound className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate font-bold text-white">{item.companyName}</p>
                          <p className="truncate text-[10px] text-muted">{item.adminEmail}</p>
                          <p className="truncate text-[10px] text-muted">{item.emailDomain}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 align-top">
                      <div className="space-y-1">
                        {pill(item.status)}
                        <p className="text-[10px] text-muted">Created {formatDate(item.createdAt)}</p>
                        <p className="text-[10px] text-muted">Expires {formatDate(item.trialExpiresAt)}</p>
                      </div>
                    </td>
                    <td className="p-3 align-top">
                      <div className="space-y-1">
                        {pill(item.billing?.billingStatus)}
                        <p className="text-[10px] text-muted">
                          {item.billing?.paymentMethodReady ? "Payment method ready" : "No payment method"}
                        </p>
                      </div>
                    </td>
                    <td className="p-3 align-top">
                      <p className="font-semibold text-text">{onboardingLabel(item)}</p>
                      <p className="text-[10px] text-muted">{item.workspace?._count.members ?? 0} members</p>
                      <p className="text-[10px] text-muted">{item.workspace?._count.roleOnboardingSessions ?? 0} role sessions</p>
                    </td>
                    <td className="p-3 align-top">
                      <div className="flex items-start gap-2">
                        <MailCheck className={cn("mt-0.5 h-3.5 w-3.5", item.latestEmailCapture ? "text-emerald-400" : "text-muted")} />
                        <div>
                          <p className="font-semibold text-text">{item.latestEmailCapture ? "Captured" : "Not captured"}</p>
                          <p className="text-[10px] text-muted">{formatDate(item.latestEmailCapture?.createdAt)}</p>
                          {item.latestEmailCapture?.consumedAt && (
                            <p className="text-[10px] text-muted">Consumed {formatDate(item.latestEmailCapture.consumedAt)}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="p-3 align-top">
                      <div className="space-y-1">
                        {pill(latestSmokeStatus(item))}
                        <p className="max-w-[220px] truncate text-[10px] text-muted">
                          {item.latestSmoke?.runId ?? "No browser/API proof stored"}
                        </p>
                        <p className="text-[10px] text-muted">{formatDate(item.latestSmoke?.completedAt ?? item.latestSmoke?.createdAt)}</p>
                      </div>
                    </td>
                    <td className="p-3 align-top">
                      <div className="flex items-start gap-2">
                        <Timer className={cn("mt-0.5 h-3.5 w-3.5", item.latestSupportSession ? "text-amber-400" : "text-muted")} />
                        <div>
                          <p className="font-semibold text-text">{item.latestSupportSession ? "Session logged" : "No session"}</p>
                          <p className="text-[10px] text-muted">{formatDate(item.latestSupportSession?.createdAt)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="p-3 align-top text-right">
                      <div className="flex flex-col items-end gap-2">
                        {href && (
                          <Link
                            href={href}
                            className="inline-flex h-8 items-center rounded-lg border border-line bg-surface px-2.5 text-[10px] font-bold uppercase tracking-wide text-text transition-colors hover:bg-surface-strong"
                          >
                            Inspect
                          </Link>
                        )}
                        <SupportSessionButton
                          deploymentId={item.deployment?.id}
                          workspaceId={item.workspace?.id}
                          companyName={item.companyName}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {registry.items.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-muted">
                    No self-serve trials have registered yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
