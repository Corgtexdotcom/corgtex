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

  const suggested = insights.filter(i => i.status === "SUGGESTED");

  if (insights.length === 0) {
    if (!hasTranscript) return null;

    return (
      <section className="ws-section" style={{ marginBottom: 48, background: "var(--bg-alt)", padding: 24, borderRadius: 8 }}>
        <h2 className="nr-section-header" style={{ borderTop: "none", marginTop: 0 }}>AI Meeting Intelligence</h2>
        <p className="muted">No insights extracted yet. You can run the AI extraction to find decisions, tensions, action items, and proposals in the transcript.</p>
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
          {loadingExtract ? "Extracting..." : "Run AI Extraction"}
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

  const getTypeLabel = (t: string) => t.replace("_", " ").toLowerCase();
  
  return (
    <section className="ws-section" style={{ marginBottom: 48 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 className="nr-section-header" style={{ borderTop: "none", margin: 0 }}>
          AI suggested {suggested.length} items for review
        </h2>
        <button className="btn" onClick={confirmAll} disabled={loadingExtract}>
          {loadingExtract ? "..." : "Confirm All"}
        </button>
      </div>

      {Object.entries(grouped).map(([type, items]) => (
        <div key={type} style={{ marginBottom: 24 }}>
          <h3 style={{ textTransform: "capitalize", fontSize: "1.1rem", marginBottom: 12 }}>{getTypeLabel(type)}s</h3>
          <div className="list">
            {items.map(insight => (
              <div className="item" key={insight.id} style={{ opacity: loadingInsights[insight.id] ? 0.6 : 1 }}>
                <div className="row" style={{ alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <strong style={{ fontSize: "1rem" }}>{insight.title}</strong>
                      {(insight.confidence ?? 0) >= 0.8 && <span className="tag success">High Confidence</span>}
                      {(insight.confidence ?? 0) < 0.5 && <span className="tag warning">Low Confidence</span>}
                    </div>
                    <div className="muted">{insight.bodyMd}</div>
                    {insight.assigneeHint && (
                      <div className="muted" style={{ fontSize: "0.82rem", marginTop: 4 }}>
                        Assignee hint: <strong>{insight.assigneeHint}</strong>
                      </div>
                    )}
                    {insight.sourceQuote && (
                      <details style={{ marginTop: 8 }}>
                        <summary style={{ cursor: "pointer", fontSize: "0.82rem", color: "var(--accent)" }}>Source Quote</summary>
                        <blockquote style={{ fontSize: "0.82rem", margin: "4px 0 0 0", paddingLeft: 8, borderLeft: "2px solid var(--line)" }}>
                          {insight.sourceQuote}
                        </blockquote>
                      </details>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="btn" onClick={actionItem(confirmInsightAction, insight.id)}>✓ Confirm</button>
                    <button className="btn" onClick={actionItem(dismissInsightAction, insight.id)}>✕ Dismiss</button>
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
