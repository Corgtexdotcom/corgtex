import type { AppActor } from "@corgtex/shared";
import { getProposal, type listAgentRuns } from "@corgtex/domain";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { submitAgentFeedbackAction } from "./actions";

type PendingRun = Awaited<ReturnType<typeof listAgentRuns>>[number];
type Checkpoint = { summary: string; proposalId: string; impactSummary: string };
export type InboxCard = {
  run: PendingRun;
  question: string | null;
  stepId: string | null;
  checkpoint: Checkpoint | null;
  proposal: { id: string; title: string } | null;
  incomplete: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function constitutionCheckpoint(resultJson: unknown): Checkpoint | null {
  const result = record(resultJson);
  const checkpoint = record(result?.approvalCheckpoint);
  const detail = record(checkpoint?.detail);
  const summary = nonemptyString(checkpoint?.summary);
  const proposalId = nonemptyString(detail?.proposalId);
  const impactSummary = nonemptyString(detail?.impactSummary);
  if (!summary || !proposalId || !impactSummary || result?.proposalId !== proposalId || result?.impactSummary !== impactSummary) {
    return null;
  }
  return { summary, proposalId, impactSummary };
}

async function inboxCard(run: PendingRun, actor: AppActor, workspaceId: string): Promise<InboxCard> {
  const lastStep = run.steps.at(-1);
  const question = nonemptyString(record(lastStep?.outputJson)?.question);
  const base = { run, question, stepId: lastStep?.id ?? null, checkpoint: null, proposal: null };
  if (run.agentKey !== "constitution-update-trigger") {
    return { ...base, incomplete: !question || !lastStep };
  }
  const checkpoint = constitutionCheckpoint(run.resultJson);
  if (!checkpoint) return { ...base, question: null, incomplete: true };
  try {
    // This read enforces membership, visibility, workspace, and active status.
    const proposal = await getProposal(actor, { workspaceId, proposalId: checkpoint.proposalId });
    return { ...base, checkpoint, proposal: { id: proposal.id, title: proposal.title }, incomplete: !question || !lastStep };
  } catch {
    // Missing, hidden, foreign, archived, and unavailable sources render alike.
    return { ...base, question: null, incomplete: true };
  }
}

export async function AgentInboxTab({
  workspaceId,
  actor,
  pendingRuns,
}: {
  workspaceId: string;
  actor: AppActor;
  pendingRuns: PendingRun[];
}) {
  const cards = await Promise.all(pendingRuns.map((run) => inboxCard(run, actor, workspaceId)));
  return AgentInboxView({ workspaceId, cards });
}

export async function AgentInboxView({
  workspaceId,
  cards,
}: {
  workspaceId: string;
  cards: InboxCard[];
}) {
  const t = await getTranslations("agents");
  return (
    <div className="stack" style={{ gap: 24 }}>
      <section>
        <h2 className="nr-section-header">{t("inboxTitle")}</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>{t("inboxDesc")}</p>
        {cards.length === 0 ? (
          <div className="nr-item" style={{ textAlign: "center", padding: "40px 20px" }}>
            <strong style={{ display: "block" }}>{t("inboxZero")}</strong>
            <span className="nr-item-meta">{t("inboxNoAgents")}</span>
          </div>
        ) : (
          <div className="stack" style={{ gap: 16 }}>
            {cards.map(({ run, question, stepId, checkpoint, proposal, incomplete }) => (
              <div key={run.id} className="agent-question-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div className="row">
                  <span className="tag neutral">{run.agentKey}</span>
                  <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>
                    {new Date(run.startedAt ?? run.createdAt).toLocaleString()}
                  </span>
                </div>
                {!incomplete && (
                  <div>
                    <strong style={{ display: "block", marginBottom: 4 }}>{t("traceGoal")}</strong>
                    <div className="nr-excerpt">{run.goal}</div>
                  </div>
                )}
                {checkpoint && proposal && (
                  <div className="stack" style={{ gap: 8 }}>
                    <strong>{t("reviewContext")}</strong>
                    <Link href={`/workspaces/${workspaceId}/proposals/${proposal.id}`}>
                      {t("reviewProposal", { title: proposal.title })}
                    </Link>
                    <p className="nr-excerpt">{checkpoint.summary}</p>
                    <p className="nr-excerpt">{checkpoint.impactSummary}</p>
                  </div>
                )}
                <div style={{ background: "var(--surface-sunken)", padding: 12, borderRadius: 8, border: "1px dashed var(--line)" }}>
                  {incomplete ? (
                    <p role="status" className="nr-excerpt">{t("incompleteContext")}</p>
                  ) : (
                    <>
                      <strong style={{ display: "block", marginBottom: 4 }}>{t("agentAsking")}</strong>
                      <div className="nr-excerpt" style={{ color: "var(--text)" }}>{question}</div>
                      <form action={submitAgentFeedbackAction} style={{ marginTop: 16 }}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="agentRunId" value={run.id} />
                        <input type="hidden" name="stepId" value={stepId ?? ""} />
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                          <label htmlFor={`agent-feedback-${run.id}`} className="sr-only">{t("replyLabel")}</label>
                          <textarea
                            id={`agent-feedback-${run.id}`}
                            name="feedback"
                            placeholder={t("replyPlaceholder")}
                            style={{ flex: 1, minHeight: 60, padding: 8, borderRadius: 6, border: "1px solid var(--line)", background: "transparent", color: "var(--text)" }}
                            required
                          />
                          <button type="submit" className="primary small">{t("btnReply")}</button>
                        </div>
                      </form>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
