"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { type MeetingInsight } from "@prisma/client";
import { 
  extractInsightsAction, 
  confirmInsightAction, 
  dismissInsightAction, 
  confirmAllInsightsAction,
} from "../actions";

export default function MeetingIntelligence({ 
  workspaceId, 
  meetingId, 
  insights,
  hasTranscript
}: { 
  workspaceId: string;
  meetingId: string;
  insights: MeetingInsight[];
  hasTranscript: boolean;
}) {
  const [loadingExtract, setLoadingExtract] = useState(false);
  const [loadingInsights, setLoadingInsights] = useState<Record<string, boolean>>({});
  const t = useTranslations("meetings");

  const suggested = insights.filter(i => i.status === "SUGGESTED");

  if (insights.length === 0) {
    if (!hasTranscript) return null;

    return (
      <section className="ws-section" style={{ marginBottom: 48, background: "var(--bg-alt)", padding: 24, borderRadius: 8 }}>
        <h2 className="nr-section-header" style={{ borderTop: "none", marginTop: 0 }}>{t("aiIntelligenceTitle")}</h2>
        <p className="muted">{t("noInsightsDescription")}</p>
        <button 
          className="btn btn-primary" 
          onClick={async () => {
            setLoadingExtract(true);
            const formData = new FormData();
            formData.append("workspaceId", workspaceId);
            formData.append("meetingId", meetingId);
            await extractInsightsAction(formData);
            setLoadingExtract(false);
          }}
          disabled={loadingExtract}
          style={{ marginTop: 16 }}
        >
          {loadingExtract ? t("extracting") : t("runAiExtraction")}
        </button>
      </section>
    );
  }

  if (suggested.length === 0) return null; // No active suggestions to review

  const actionItem = (actionFunc: any, insightId: string) => async () => {
    setLoadingInsights(prev => ({ ...prev, [insightId]: true }));
    const f = new FormData();
    f.append("workspaceId", workspaceId);
    f.append("insightId", insightId);
    await actionFunc(f);
    setLoadingInsights(prev => ({ ...prev, [insightId]: false }));
  };

  const confirmAll = async () => {
    setLoadingExtract(true);
    const f = new FormData();
    f.append("workspaceId", workspaceId);
    f.append("meetingId", meetingId);
    await confirmAllInsightsAction(f);
    setLoadingExtract(false);
  };

  const grouped = suggested.reduce((acc, curr) => {
    acc[curr.type] = acc[curr.type] || [];
    acc[curr.type].push(curr);
    return acc;
  }, {} as Record<string, MeetingInsight[]>);

  const getTypeLabel = (type: string) => t(`insightType.${type.toLowerCase()}`);
  
  return (
    <section className="ws-section" style={{ marginBottom: 48 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 className="nr-section-header" style={{ borderTop: "none", margin: 0 }}>
          {t("suggestedItems", { count: suggested.length })}
        </h2>
        <button className="btn" onClick={confirmAll} disabled={loadingExtract}>
          {loadingExtract ? "..." : t("confirmAll")}
        </button>
      </div>

      {Object.entries(grouped).map(([type, items]) => (
        <div key={type} style={{ marginBottom: 24 }}>
          <h3 style={{ textTransform: "capitalize", fontSize: "1.1rem", marginBottom: 12 }}>{getTypeLabel(type)}</h3>
          <div className="list">
            {items.map(insight => (
              <div className="item" key={insight.id} style={{ opacity: loadingInsights[insight.id] ? 0.6 : 1 }}>
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <strong style={{ fontSize: "1rem" }}>{insight.title}</strong>
                      {(insight.confidence ?? 0) >= 0.8 && <span className="tag success">{t("highConfidence")}</span>}
                      {(insight.confidence ?? 0) < 0.5 && <span className="tag warning">{t("lowConfidence")}</span>}
                    </div>
                    <div className="muted">{insight.bodyMd}</div>
                    {insight.assigneeHint && (
                      <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                        {t("assigneeHint")} <strong>{insight.assigneeHint}</strong>
                      </div>
                    )}
                    {insight.sourceQuote && (
                      <details style={{ marginTop: 8 }}>
                        <summary style={{ cursor: "pointer", fontSize: "0.82rem", color: "var(--accent)" }}>{t("sourceQuote")}</summary>
                        <blockquote style={{ fontSize: "0.82rem", margin: "4px 0 0 0", paddingLeft: 8, borderLeft: "2px solid var(--line)" }}>
                          {insight.sourceQuote}
                        </blockquote>
                      </details>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn" onClick={actionItem(confirmInsightAction, insight.id)}>{t("confirmInsight")}</button>
                    <button className="btn" onClick={actionItem(dismissInsightAction, insight.id)}>{t("dismissInsight")}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
