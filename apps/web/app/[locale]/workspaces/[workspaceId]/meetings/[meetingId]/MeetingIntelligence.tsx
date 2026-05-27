"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { type MeetingInsight } from "@prisma/client";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { MarkdownRenderer } from "@/lib/components/MarkdownRenderer";
import {
  applyInsightAction,
  dismissInsightAction,
  regenerateMeetingIntelligenceAction,
  updateInsightAction,
} from "../actions";
import { parseMeetingBlockContext } from "./meetingInsightBlocks";

type InsightBucket = {
  title: string;
  description: string;
  items: MeetingInsight[];
};

type InsightDraft = {
  title: string;
  bodyMd: string;
  assigneeHint: string;
};

export type InsightTargetMetadata = {
  label: string;
  href?: string;
};

function confidenceValue(insight: MeetingInsight) {
  return typeof insight.confidence === "number" ? insight.confidence : 0;
}

export function MeetingRegenerationPanel({
  workspaceId,
  meetingId,
  hasTranscript,
}: {
  workspaceId: string;
  meetingId: string;
  hasTranscript: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("meetings");
  const [regenerating, setRegenerating] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!hasTranscript) return null;

  async function regenerate() {
    const trimmedGuidance = guidance.trim();
    if (!trimmedGuidance) {
      setError(t("errorRegenerationGuidanceRequired"));
      return;
    }

    setRegenerating(true);
    setError(null);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.append("workspaceId", workspaceId);
      formData.append("meetingId", meetingId);
      formData.append("guidanceMd", trimmedGuidance);
      await regenerateMeetingIntelligenceAction(formData);
      setGuidance("");
      setNotice(t("regenerationQueued"));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorRegenerationFailed"));
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <section className="meeting-update-panel">
      <div>
        <h2 className="nr-section-header" style={{ borderTop: "none", margin: 0 }}>
          {t("updateSummaryRaisedTitle")}
        </h2>
        <p className="nr-item-meta" style={{ marginTop: 6 }}>
          {t("updateSummaryRaisedDescription")}
        </p>
      </div>

      {error && <div className="meeting-intelligence-alert danger">{error}</div>}
      {notice && <div className="meeting-intelligence-alert success">{notice}</div>}

      <div className="meeting-regenerate">
        <label>
          {t("regenerateWithGuidance")}
          <textarea
            value={guidance}
            onChange={(event) => setGuidance(event.target.value)}
            placeholder={t("regenerateGuidancePlaceholder")}
            rows={3}
          />
        </label>
        <div className="meeting-regenerate-actions">
          <button className="btn btn-primary" type="button" disabled={regenerating} onClick={regenerate}>
            {regenerating ? t("regenerating") : t("btnUpdateSummaryRaised")}
          </button>
          <span className="nr-item-meta">{t("regenerateGuidanceHelp")}</span>
        </div>
      </div>
    </section>
  );
}

export default function MeetingIntelligence({
  workspaceId,
  insights,
  insightTargets,
  hasTranscript,
}: {
  workspaceId: string;
  insights: MeetingInsight[];
  insightTargets?: Record<string, InsightTargetMetadata>;
  hasTranscript: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("meetings");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, InsightDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!hasTranscript) return null;

  const reviewable = insights.filter((insight) => (insight.status === "SUGGESTED" || insight.status === "CONFIRMED") && !insight.supersededAt);
  const applied = insights.filter((insight) => insight.status === "APPLIED");
  const needsReview = reviewable.filter((insight) => confidenceValue(insight) >= 0.5);
  const lowConfidence = reviewable.filter((insight) => confidenceValue(insight) < 0.5);
  const insightTypeLabels: Record<string, string> = {
    DECISION: t("insightType.decision"),
    TENSION: t("insightType.tension"),
    ACTION_ITEM: t("insightType.action_item"),
    PROPOSAL: t("insightType.proposal"),
    FOLLOW_UP: t("insightType.follow_up"),
    DELIBERATION_ENTRY: t("insightType.deliberation_entry"),
  };

  const buckets: InsightBucket[] = [
    {
      title: t("insightsApplied"),
      description: t("insightsAppliedDescription"),
      items: applied,
    },
    {
      title: t("insightsNeedsReview"),
      description: t("insightsNeedsReviewDescription"),
      items: needsReview,
    },
    {
      title: t("insightsLowConfidence"),
      description: t("insightsLowConfidenceDescription"),
      items: lowConfidence,
    },
  ].filter((bucket) => bucket.items.length > 0);

  async function runInsightAction(actionFunc: (formData: FormData) => Promise<void>, insightId: string) {
    setBusyId(insightId);
    setError(null);
    setNotice(null);
    try {
      const formData = new FormData();
      formData.append("workspaceId", workspaceId);
      formData.append("insightId", insightId);
      await actionFunc(formData);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorInsightAction"));
    } finally {
      setBusyId(null);
    }
  }

  function startEditing(insight: MeetingInsight) {
    setEditing((current) => ({
      ...current,
      [insight.id]: {
        title: insight.title,
        bodyMd: insight.bodyMd,
        assigneeHint: insight.assigneeHint ?? "",
      },
    }));
  }

  function cancelEditing(insightId: string) {
    setEditing((current) => {
      const next = { ...current };
      delete next[insightId];
      return next;
    });
  }

  function updateDraft(insightId: string, patch: Partial<InsightDraft>) {
    setEditing((current) => ({
      ...current,
      [insightId]: {
        ...(current[insightId] ?? { title: "", bodyMd: "", assigneeHint: "" }),
        ...patch,
      },
    }));
  }

  async function saveInsightEdits(insightId: string, applyAfterSave = false) {
    const draft = editing[insightId];
    if (!draft) return;
    if (!draft.title.trim()) {
      setError(t("errorInsightTitleRequired"));
      return;
    }

    setBusyId(insightId);
    setError(null);
    setNotice(null);
    try {
      const updateFormData = new FormData();
      updateFormData.append("workspaceId", workspaceId);
      updateFormData.append("insightId", insightId);
      updateFormData.append("title", draft.title.trim());
      updateFormData.append("bodyMd", draft.bodyMd.trim());
      updateFormData.append("assigneeHint", draft.assigneeHint.trim());
      await updateInsightAction(updateFormData);

      if (applyAfterSave) {
        const applyFormData = new FormData();
        applyFormData.append("workspaceId", workspaceId);
        applyFormData.append("insightId", insightId);
        await applyInsightAction(applyFormData);
        setNotice(t("insightSavedAndApproved"));
      } else {
        setNotice(t("insightSaved"));
      }

      cancelEditing(insightId);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorInsightAction"));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <details className="meeting-evidence-drawer meeting-intelligence">
      <summary className="meeting-evidence-summary">
        <div>
          <span className="nr-section-header" style={{ borderTop: "none", margin: 0, padding: 0 }}>
            {t("aiIntelligenceTitle")}
          </span>
          <p className="nr-item-meta" style={{ marginTop: 6 }}>
            {insights.length === 0 ? t("aiIntelligenceProcessing") : t("aiIntelligenceReviewHint")}
          </p>
        </div>
        <span className="tag">{t("insightQueueCount", { count: insights.length })}</span>
      </summary>

      <div className="meeting-evidence-body">
        {error && <div className="meeting-intelligence-alert danger">{error}</div>}
        {notice && <div className="meeting-intelligence-alert success">{notice}</div>}

        {buckets.length > 0 ? (
          <div className="meeting-insight-buckets">
            {buckets.map((bucket) => (
              <div className="meeting-insight-bucket" key={bucket.title}>
                <div className="meeting-insight-bucket-title">
                  <h3>{bucket.title}</h3>
                  <span className="tag">{bucket.items.length}</span>
                </div>
                <p className="nr-item-meta">{bucket.description}</p>
                <div className="meeting-insight-list">
                  {bucket.items.map((insight) => {
                    const confidence = confidenceValue(insight);
                    const isReviewable = insight.status === "SUGGESTED" || insight.status === "CONFIRMED";
                    const loading = busyId === insight.id;
                    const draft = editing[insight.id];
                    const isEditing = Boolean(draft);
                    const targetType = insight.targetEntityType ?? "";
                    const targetId = insight.targetEntityId ?? "";
                    const targetKey = targetType && targetId
                      ? `${targetType}:${targetId}`
                      : null;
                    const target = targetKey
                      ? insightTargets?.[targetKey] ?? {
                        label: t("insightTargetFallback", {
                          type: targetType,
                          id: targetId.slice(0, 8),
                        }),
                      }
                      : null;
                    const blockContext = parseMeetingBlockContext(insight.bodyMd);

                    return (
                      <article className={`meeting-insight-item${isEditing ? " editing" : ""}`} key={insight.id} aria-busy={loading}>
                        <div className="meeting-insight-main">
                          <div className="meeting-insight-title-row">
                            <span className="tag info">{insightTypeLabels[insight.type] ?? insight.type}</span>
                            {blockContext.blockTitle && <span className="tag">{blockContext.blockTitle}</span>}
                            {confidence >= 0.8 && <span className="tag success">{t("highConfidence")}</span>}
                            {confidence < 0.5 && <span className="tag warning">{t("lowConfidence")}</span>}
                            <span className="nr-item-meta">{t("confidencePercent", { percent: Math.round(confidence * 100) })}</span>
                          </div>
                          {isEditing && draft ? (
                            <div className="meeting-insight-edit-form">
                              <label>
                                {t("editInsightTitle")}
                                <input
                                  value={draft.title}
                                  onChange={(event) => updateDraft(insight.id, { title: event.target.value })}
                                />
                              </label>
                              <label>
                                {t("editInsightBody")}
                                <MarkdownEditor
                                  name="bodyMd"
                                  value={draft.bodyMd}
                                  rows={5}
                                  onValueChange={(bodyMd) => updateDraft(insight.id, { bodyMd })}
                                />
                              </label>
                              <label>
                                {t("editInsightOwnerHint")}
                                <input
                                  value={draft.assigneeHint}
                                  onChange={(event) => updateDraft(insight.id, { assigneeHint: event.target.value })}
                                  placeholder={t("editInsightOwnerHintPlaceholder")}
                                />
                              </label>
                            </div>
                          ) : (
                            <>
                              <h4>{insight.title}</h4>
                              {insight.assigneeHint && (
                                <div className="nr-item-meta">
                                  {t("assigneeHint")} <strong>{insight.assigneeHint}</strong>
                                </div>
                              )}
                              {target && (
                                <div className="nr-item-meta">
                                  {t("insightTargetLabel")}{" "}
                                  {target.href ? (
                                    <Link href={target.href}>{target.label}</Link>
                                  ) : (
                                    <strong>{target.label}</strong>
                                  )}
                                </div>
                              )}
                              {insight.deliberationEntryType && (
                                <div className="nr-item-meta">
                                  {t("deliberationEntryType")} <strong>{insight.deliberationEntryType.toLowerCase()}</strong>
                                </div>
                              )}
                              {insight.operation === "RESOLVE" && insight.resolutionOutcome && (
                                <div className="nr-item-meta">
                                  {t("resolutionOutcome")} <strong>{insight.resolutionOutcome.replace("_", " ").toLowerCase()}</strong>
                                </div>
                              )}
                              {blockContext.bodyMd && (
                                <details className="meeting-insight-details">
                                  <summary>{t("insightDetails")}</summary>
                                  <MarkdownRenderer markdown={blockContext.bodyMd} variant="compact" className="meeting-insight-body" />
                                </details>
                              )}
                            </>
                          )}
                          {insight.sourceQuote && (
                            <details className="meeting-insight-source">
                              <summary>{t("sourceQuote")}</summary>
                              <blockquote>{insight.sourceQuote}</blockquote>
                            </details>
                          )}
                        </div>
                        {isReviewable && (
                          <div className="meeting-insight-actions">
                            {isEditing ? (
                              <>
                                <button
                                  className="btn btn-primary"
                                  type="button"
                                  disabled={loading}
                                  onClick={() => saveInsightEdits(insight.id, true)}
                                >
                                  {loading ? t("working") : t("saveAndApproveInsight")}
                                </button>
                                <button
                                  className="btn"
                                  type="button"
                                  disabled={loading}
                                  onClick={() => saveInsightEdits(insight.id)}
                                >
                                  {t("saveInsight")}
                                </button>
                                <button
                                  className="btn"
                                  type="button"
                                  disabled={loading}
                                  onClick={() => cancelEditing(insight.id)}
                                >
                                  {t("cancelEditInsight")}
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  className="btn btn-primary"
                                  type="button"
                                  disabled={loading}
                                  onClick={() => runInsightAction(applyInsightAction, insight.id)}
                                >
                                  {loading ? t("working") : t("approveInsight")}
                                </button>
                                <button
                                  className="btn"
                                  type="button"
                                  disabled={loading}
                                  onClick={() => startEditing(insight)}
                                >
                                  {t("editInsight")}
                                </button>
                                <button
                                  className="btn"
                                  type="button"
                                  disabled={loading}
                                  onClick={() => runInsightAction(dismissInsightAction, insight.id)}
                                >
                                  {t("declineInsight")}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="meeting-intelligence-empty">
            <p>{t("noInsightsAutomaticDescription")}</p>
          </div>
        )}
      </div>
    </details>
  );
}
