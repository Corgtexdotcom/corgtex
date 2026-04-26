import {
  listConstitutionVersions,
  listPolicyCorpus,
  getApprovalPolicies,
  getLatestGovernanceScore,
  listGovernanceScores,
  getCurrentConstitution,
} from "@corgtex/domain";
import { requirePageActor } from "@/lib/auth";
import {
  updateApprovalPolicyAction,
  recalculateGovernanceScoreAction,
  triggerAgentRunAction,
} from "../actions";
import { prisma } from "@corgtex/shared";
import { getTranslations } from "next-intl/server";
import { requireWorkspaceFeature } from "@/lib/workspace-feature-flags";

export const dynamic = "force-dynamic";

function scoreColor(score: number): string {
  if (score >= 75) return "var(--accent)";
  if (score >= 50) return "var(--warning)";
  return "#842029";
}

function scoreLabel(score: number, t: any): string {
  if (score >= 75) return t("scoreLabelMature");
  if (score >= 50) return t("scoreLabelDeveloping");
  if (score >= 25) return t("scoreLabelEmerging");
  return t("scoreLabelInitial");
}

export default async function GovernancePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  await requireWorkspaceFeature(workspaceId, "OS_METRICS");
  const actor = await requirePageActor();
  const t = await getTranslations("governance");

  const constitutionResult = await listConstitutionVersions(actor, workspaceId, { take: 10 }).catch(() => ({ items: [], total: 0 }));
  const constitutions = constitutionResult.items;
  const policies = await listPolicyCorpus(actor, workspaceId).catch(() => []);
  const approvalPolicies = await getApprovalPolicies(actor, workspaceId).catch(() => []);
  const latestScore = await getLatestGovernanceScore(workspaceId).catch(() => null);
  const scoreHistory = await listGovernanceScores(actor, workspaceId, { take: 6 }).catch(() => []);
  const currentConstitution = await getCurrentConstitution(workspaceId).catch(() => null);
  const currentWorkspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } });
  const isDemo = currentWorkspace?.slug === "jnj-demo";

  return (
    <>
      <header className="nr-masthead" style={{ textAlign: "left", marginBottom: 32 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <h1 style={{ border: "none", padding: 0, margin: 0, fontSize: "2.5rem" }}>{t("pageTitle")}</h1>
          {!isDemo && (
            <div className="actions-inline">
              <form action={recalculateGovernanceScoreAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <button type="submit" className="secondary small">{t("btnRecalculate")}</button>
              </form>
              <form action={triggerAgentRunAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="agentKey" value="constitution-synthesis" />
                <button type="submit" className="secondary small">{t("btnSynthesize")}</button>
              </form>
            </div>
          )}
        </div>
        <div className="nr-masthead-meta">
          <span>{t("pageDescription")}</span>
        </div>
      </header>

      {/* Governance Score */}
      {latestScore ? (
        <div style={{ marginBottom: 48 }}>
          <div className="row" style={{ marginBottom: 16 }}>
            <h2 className="nr-section-header" style={{ flex: 1, borderTop: "2px solid var(--text)", margin: 0 }}>{t("sectionGovernanceMaturity")}</h2>
            <div style={{
              fontSize: "1.5rem",
              fontWeight: 800,
              color: scoreColor(latestScore.overallScore),
              marginTop: 12
            }}>
              {latestScore.overallScore}/100
              <span style={{ fontSize: "0.82rem", fontWeight: 600, marginLeft: 8 }}>
                {scoreLabel(latestScore.overallScore, t)}
              </span>
            </div>
          </div>
          <div className="ws-stat-row">
            <div className="ws-stat-card" style={{ border: "1px dashed var(--line)", background: "transparent", boxShadow: "none" }}>
              <strong style={{ color: scoreColor(latestScore.participationPct) }}>
                {latestScore.participationPct}%
              </strong>
              <span>{t("statParticipation")}</span>
            </div>
            <div className="ws-stat-card" style={{ border: "1px dashed var(--line)", background: "transparent", boxShadow: "none" }}>
              <strong style={{ color: scoreColor(Math.max(0, 100 - latestScore.decisionVelocityHrs)) }}>
                {latestScore.decisionVelocityHrs}h
              </strong>
              <span>{t("statAvgDecisionTime")}</span>
            </div>
            <div className="ws-stat-card" style={{ border: "1px dashed var(--line)", background: "transparent", boxShadow: "none" }}>
              <strong style={{ color: scoreColor(latestScore.policyCoverage) }}>
                {latestScore.policyCoverage}%
              </strong>
              <span>{t("statPolicyCoverage")}</span>
            </div>
            <div className="ws-stat-card" style={{ border: "1px dashed var(--line)", background: "transparent", boxShadow: "none" }}>
              <strong style={{ color: scoreColor(latestScore.tensionResolutionPct) }}>
                {latestScore.tensionResolutionPct}%
              </strong>
              <span>{t("statTensionResolution")}</span>
            </div>
            <div className="ws-stat-card" style={{ border: "1px dashed var(--line)", background: "transparent", boxShadow: "none" }}>
              <strong style={{ color: scoreColor(latestScore.constitutionFreshness) }}>
                {latestScore.constitutionFreshness}%
              </strong>
              <span>{t("statConstitutionFreshness")}</span>
            </div>
          </div>

          {scoreHistory.length > 1 && (
            <details style={{ marginTop: 8 }}>
              <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.82rem" }}>
                {t("scoreHistory", { count: scoreHistory.length })}
              </summary>
              <div style={{ marginTop: 8 }}>
                {scoreHistory.map((s) => (
                  <div key={s.id} className="nr-item" style={{ padding: "8px 0" }}>
                    <div className="row">
                      <span style={{ fontWeight: 700, color: scoreColor(s.overallScore) }}>
                        {s.overallScore}/100
                      </span>
                      <span className="nr-item-meta" style={{ fontSize: "0.82rem" }}>
                        {new Date(s.periodEnd).toLocaleDateString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      ) : (
        <div style={{ marginBottom: 48 }}>
          <p className="nr-item-meta">{t("noGovernanceScore")}</p>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: "40px", marginBottom: 48 }}>
        {/* Constitution */}
        <div>
          <h2 className="nr-section-header">{t("sectionConstitution")}</h2>
          {currentConstitution ? (
            <>
              <div className="row" style={{ marginBottom: 12 }}>
                <span className="tag">v{currentConstitution.version}</span>
                <span className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                  {new Date(currentConstitution.createdAt).toLocaleDateString()}
                </span>
              </div>
              <div style={{
                border: "1px dashed var(--line)",
                borderRadius: 8,
                padding: 16,
                maxHeight: 400,
                overflow: "auto",
                background: "transparent",
                whiteSpace: "pre-wrap",
                fontSize: "0.88rem",
                lineHeight: 1.6,
              }}>
                {currentConstitution.bodyMd}
              </div>
              {currentConstitution.diffSummary && (
                <div style={{ marginTop: 12, padding: 12, background: "var(--accent-soft)", borderRadius: 8, fontSize: "0.85rem" }}>
                  <strong>{t("changesInVersion", { version: currentConstitution.version })}</strong>
                  <div style={{ marginTop: 4 }}>{currentConstitution.diffSummary}</div>
                </div>
              )}
            </>
          ) : (
            <p className="nr-item-meta">{t("noConstitution")}</p>
          )}

          {constitutions.length > 1 && (
            <details style={{ marginTop: 16 }}>
              <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.82rem" }}>
                {t("versionHistory", { count: constitutions.length })}
              </summary>
              <div style={{ marginTop: 8 }}>
                {constitutions.map((c) => (
                  <div key={c.id} className="nr-item" style={{ padding: "8px 0" }}>
                    <div className="row">
                      <span className="tag">v{c.version}</span>
                      <span className="nr-item-meta" style={{ fontSize: "0.82rem", margin: 0 }}>
                        {new Date(c.createdAt).toLocaleDateString()} &middot; {c.modelUsed}
                      </span>
                    </div>
                    {c.diffSummary && (
                      <div className="nr-excerpt" style={{ marginTop: 4, fontSize: "0.82rem" }}>
                        {c.diffSummary}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        {/* Policy Corpus */}
        <div>
          <h2 className="nr-section-header">{t("sectionPolicyCorpus", { count: policies.length })}</h2>
          {policies.length === 0 ? (
            <p className="nr-item-meta">{t("noPolicies")}</p>
          ) : (
            <div>
              {policies.map((p) => (
                <div key={p.id} className="nr-item">
                  <div className="row">
                    <strong className="nr-item-title">{p.title}</strong>
                    {p.circle && <span className="tag">{p.circle.name}</span>}
                  </div>
                  <div className="nr-item-meta" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                    {t("policyAccepted", { title: p.proposal.title, date: new Date(p.acceptedAt).toLocaleDateString() })}
                  </div>
                  <details style={{ marginTop: 8 }}>
                    <summary className="nr-meta" style={{ cursor: "pointer", fontSize: "0.82rem" }}>
                      {t("viewPolicyText")}
                    </summary>
                    <div style={{
                      marginTop: 8,
                      padding: 12,
                      background: "transparent",
                      border: "1px dashed var(--line)",
                      borderRadius: 8,
                      whiteSpace: "pre-wrap",
                      fontSize: "0.85rem",
                      lineHeight: 1.5,
                    }}>
                      {p.bodyMd}
                    </div>
                  </details>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Approval Policies */}
      <div style={{ marginTop: 20 }}>
        <h2 className="nr-section-header">{t("sectionApprovalPolicies")}</h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", marginBottom: 16 }}>
          {t("approvalPoliciesDesc")}
        </p>
        <div>
          {approvalPolicies.map((policy) => (
            <div key={policy.id} className="nr-item">
              <form action={updateApprovalPolicyAction}>
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="subjectType" value={policy.subjectType} />
                <div className="row" style={{ marginBottom: 12 }}>
                  <strong className="nr-item-title" style={{ textTransform: "uppercase" }}>{policy.subjectType}</strong>
                  <span className="tag">{policy.mode}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  <label>
                    {t("labelMode")}
                    <select name="mode" defaultValue={policy.mode}>
                      <option value="CONSENT">{t("modeConsent")}</option>
                      <option value="CONSENSUS">{t("modeConsensus")}</option>
                      <option value="MAJORITY">{t("modeMajority")}</option>
                      <option value="SINGLE">{t("modeSingle")}</option>
                    </select>
                  </label>
                  <label>
                    {t("labelQuorum")}
                    <input type="number" name="quorumPercent" defaultValue={policy.quorumPercent} min={0} max={100} />
                  </label>
                  <label>
                    {t("labelMinApprovers")}
                    <input type="number" name="minApproverCount" defaultValue={policy.minApproverCount} min={1} />
                  </label>
                  <label>
                    {t("labelDecisionWindow")}
                    <input type="number" name="decisionWindowHours" defaultValue={policy.decisionWindowHours} min={1} />
                  </label>
                </div>
                {!isDemo && (
                  <div style={{ marginTop: 12 }}>
                    <button type="submit" className="secondary small">{t("btnUpdatePolicy")}</button>
                  </div>
                )}
              </form>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
