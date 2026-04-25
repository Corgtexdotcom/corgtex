import { env } from "@corgtex/shared";
import { listAgentRuns, listRuntimeEvents, listRuntimeJobs, listMembers, listFailedJobs, getFailingAgents } from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  triggerAgentRunAction,
  replayEventAction,
  replayWorkflowJobAction,
  decideApprovalAction,
  createObjectionAction,
  resolveObjectionAction,
  resolveAgentRunAction,
  discardFailedJobAction,
} from "../actions";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

function formatDateTime(value: Date | string | null | undefined, notSetStr: string) {
  if (!value) return notSetStr;
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string) {
  if (!isObjectRecord(value)) return null;
  const entry = value[key];
  return typeof entry === "string" && entry.trim() ? entry : null;
}

type AgentRunItem = Awaited<ReturnType<typeof listAgentRuns>>[number];
type AgentRunUsage = AgentRunItem["modelUsageSummary"][number];

function summarizeRun(run: AgentRunItem) {
  return (
    readString(run.resultJson, "summary")
    ?? readString(run.resultJson, "impactSummary")
    ?? readString(run.resultJson, "error")
    ?? readString(run.resultJson, "prompt")
    ?? run.goal
  );
}

function parseCostUsd(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value: number) {
  return `$${value.toFixed(value >= 0.01 ? 4 : 6)}`;
}

function summarizeUsage(run: AgentRunItem) {
  return run.modelUsageSummary.reduce((summary, usage) => ({
    inputTokens: summary.inputTokens + usage.inputTokens,
    outputTokens: summary.outputTokens + usage.outputTokens,
    latencyMs: summary.latencyMs + usage.latencyMs,
    estimatedCostUsd: summary.estimatedCostUsd + parseCostUsd(usage.estimatedCostUsd),
  }), {
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    estimatedCostUsd: 0,
  });
}

function usageModels(run: AgentRunItem) {
  return [...new Set(run.modelUsageSummary.map((usage) => usage.model))];
}

function usageKey(usage: AgentRunUsage) {
  return `${usage.taskType}:${usage.provider}:${usage.model}`;
}

export default async function OperatorPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const actor = await requirePageActor();
  const t = await getTranslations("operator");
  const [agentRuns, events, jobs, members, failedJobs, failingAgents] = await Promise.all([
    listAgentRuns(actor, workspaceId, { take: 15 }),
    listRuntimeEvents(actor, workspaceId, { take: 15 }),
    listRuntimeJobs(actor, workspaceId, { take: 15 }),
    listMembers(workspaceId),
    listFailedJobs(actor, workspaceId, { take: 50 }),
    getFailingAgents(workspaceId),
  ]);
  const currentUserId = actor.kind === "user" ? actor.user.id : "";
  const currentMembership = members.find((m) => m.userId === currentUserId);
  const canOperate = currentMembership?.role === "ADMIN" || currentMembership?.role === "FACILITATOR";

  return (
    <>
      {failingAgents.length > 0 && (
        <div className="panel danger" style={{ marginBottom: 24 }}>
          <strong>{t("agentsFailing", { agents: failingAgents.join(", ") })}</strong>
        </div>
      )}
      <div className="ws-page-header">
        <div className="row">
          <div>
            <h1>{t("pageTitle")}</h1>
            <p>{t("pageDescription")}</p>
          </div>
          <span className={`tag ${env.AGENT_KILL_SWITCH ? "warning" : ""}`}>
            {env.AGENT_KILL_SWITCH ? t("killSwitchActive") : t("agentsEnabled")}
          </span>
        </div>
      </div>

      <section className="ws-section">
        <h2>{t("sectionAgentRuns")}</h2>
        {canOperate && (
          <form action={triggerAgentRunAction} className="stack panel" style={{ marginBottom: 16 }}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div className="actions-inline">
              <label style={{ flex: 1 }}>
                {t("formAgent")}
                <select name="agentKey" defaultValue="proposal-drafting">
                  <option value="inbox-triage">{t("agentInboxTriage")}</option>
                  <option value="meeting-summary">{t("agentMeetingSummary")}</option>
                  <option value="action-extraction">{t("agentActionExtraction")}</option>
                  <option value="proposal-drafting">{t("agentProposalDrafting")}</option>
                  <option value="constitution-update-trigger">{t("agentConstitutionUpdate")}</option>
                  <option value="finance-reconciliation-prep">{t("agentFinancePrep")}</option>
                </select>
              </label>
              <label style={{ flex: 1 }}>
                {t("formMeetingId")}
                <input name="meetingId" placeholder={t("placeholderOptional")} />
              </label>
            </div>
            <div className="actions-inline">
              <label style={{ flex: 1 }}>
                {t("formProposalId")}
                <input name="proposalId" placeholder={t("placeholderOptional")} />
              </label>
              <label style={{ flex: 1 }}>
                {t("formSpendId")}
                <input name="spendId" placeholder={t("placeholderOptional")} />
              </label>
            </div>
            <label>
              {t("formPrompt")}
              <textarea name="prompt" placeholder={t("placeholderPrompt")} />
            </label>
            <button type="submit" disabled={env.AGENT_KILL_SWITCH}>{t("btnQueueAgent")}</button>
          </form>
        )}
        <div className="list">
          {agentRuns.map((run) => {
            const totalUsage = summarizeUsage(run);

            return (
              <div className="item" key={run.id}>
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <div className="stack" style={{ gap: 6 }}>
                    <div className="actions-inline">
                      <span className="tag">{run.agentKey}</span>
                      <span className={`status-chip ${run.status === "WAITING_APPROVAL" ? "warning" : ""}`}>{run.status}</span>
                    </div>
                    <strong>{run.goal}</strong>
                    <div className="muted">{summarizeRun(run)}</div>
                    <div className="muted">{`${t("startedAt")} ${formatDateTime(run.startedAt ?? run.createdAt, t("notSet"))}`}</div>
                  </div>
                  {run.status === "WAITING_APPROVAL" && canOperate && (
                    <form action={resolveAgentRunAction} className="actions-inline">
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="agentRunId" value={run.id} />
                      <button type="submit" name="status" value="COMPLETED" className="small secondary">{t("btnMarkResolved")}</button>
                    </form>
                  )}
                </div>
                {run.modelUsageSummary.length > 0 && (
                  <div className="stack" style={{ gap: 8, marginTop: 12 }}>
                    <div className="actions-inline">
                      {usageModels(run).map((model) => (
                        <span className="tag" key={`${run.id}:${model}`}>{model}</span>
                      ))}
                    </div>
                    <div className="muted">
                      {t("usageSummary", { inTokens: totalUsage.inputTokens, outTokens: totalUsage.outputTokens, latency: totalUsage.latencyMs, cost: formatUsd(totalUsage.estimatedCostUsd) })}
                    </div>
                    <div className="list">
                      {run.modelUsageSummary.map((usage) => (
                        <div className="nested-item" key={usageKey(usage)}>
                          <div className="row">
                            <strong>{usage.taskType}</strong>
                            <span className="tag">{usage.provider}</span>
                          </div>
                          <div className="muted">
                            {usage.model} · {usage.inputTokens} in · {usage.outputTokens} out · {usage.latencyMs} ms · {formatUsd(parseCostUsd(usage.estimatedCostUsd))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {run.steps.length > 0 && (
                  <div className="list" style={{ marginTop: 12 }}>
                    {run.steps.slice(-4).map((step) => (
                      <div className="nested-item" key={step.id}>
                        <div className="row">
                          <strong>{step.name}</strong>
                          <span className="status-chip">{step.status}</span>
                        </div>
                        {step.error && <p className="muted" style={{ margin: "8px 0 0" }}>{step.error}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <div className="ws-columns">
        <section className="ws-section">
          <h2>{t("sectionEvents")}</h2>
          <div className="list">
            {events.map((event) => (
              <div className="item" key={event.id}>
                <div className="row">
                  <strong>{event.type}</strong>
                  <span className={`status-chip ${event.status === "FAILED" ? "warning" : ""}`}>{event.status}</span>
                </div>
                <div className="muted">
                  {`${event.aggregateType ?? "Event"} · ${formatDateTime(event.createdAt, t("notSet"))} · ${t("labelAttempts")} ${event.attempts}`}
                </div>
                {event.error && <p className="muted" style={{ margin: "8px 0 0", color: "#b45309" }}>{event.error}</p>}
                {canOperate && (
                  <form action={replayEventAction} style={{ marginTop: 8 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="eventId" value={event.id} />
                    <button type="submit" className="secondary small">{t("btnReplay")}</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="ws-section">
          <h2>{t("sectionWorkflowJobs")}</h2>
          <div className="list">
            {jobs.map((job) => (
              <div className="item" key={job.id}>
                <div className="row">
                  <strong>{job.type}</strong>
                  <span className={`status-chip ${job.status === "FAILED" ? "warning" : ""}`}>{job.status}</span>
                </div>
                <div className="muted">
                  {`${t("labelAttempts")} ${job.attempts} · ${t("labelRunAfter")} ${formatDateTime(job.runAfter, t("notSet"))}`}
                </div>
                {job.error && <p className="muted" style={{ margin: "8px 0 0", color: "#b45309" }}>{job.error}</p>}
                {canOperate && (
                  <form action={replayWorkflowJobAction} style={{ marginTop: 8 }}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="workflowJobId" value={job.id} />
                    <button type="submit" className="secondary small">{t("btnReplay")}</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="ws-section">
          <h2>{t("sectionFailedJobs")}</h2>
          <div className="list">
            {failedJobs.length === 0 ? (
              <p className="muted">{t("noFailedJobs")}</p>
            ) : failedJobs.map((job) => (
              <div className="item" key={job.id}>
                <div className="row">
                  <strong>{job.type}</strong>
                  <span className={`status-chip ${job.status === "FAILED" ? "warning" : ""}`}>{job.status}</span>
                </div>
                <div className="muted">
                  {`${t("labelAttempts")} ${job.attempts} · ${t("labelFailedAt")} ${formatDateTime(job.updatedAt ?? job.createdAt, t("notSet"))}`}
                </div>
                {job.error && <p className="muted" style={{ margin: "8px 0 0", color: "#b45309" }}>{job.error}</p>}
                {canOperate && (
                  <div className="row" style={{ marginTop: 8, gap: 8, justifyContent: "flex-start" }}>
                    <form action={replayWorkflowJobAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="workflowJobId" value={job.id} />
                      <button type="submit" className="secondary small">{t("btnRetry")}</button>
                    </form>
                    <form action={discardFailedJobAction}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="workflowJobId" value={job.id} />
                      <button type="submit" className="secondary small danger">{t("btnDiscard")}</button>
                    </form>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
