"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

const SOURCE_TYPES = ["MEETING","TICKET","PR","RFC","INCIDENT","SLACK","CUSTOMER_FEEDBACK","COMPETITOR","RESEARCH","ARTICLE","DOC","RUNBOOK","EMAIL","FILE_UPLOAD"];

export function TextPasteUploader({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState("ARTICLE");
  const [channel, setChannel] = useState("");
  const [content, setContent] = useState("");
  const [recordedAt, setRecordedAt] = useState("");
  const [error, setError] = useState("");
  const [clarification, setClarification] = useState("");
  const t = useTranslations("settings");

  const isMeeting = sourceType === "MEETING";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    
    setIsSubmitting(true);
    setError("");
    setClarification("");
    
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/data-sources/text-ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, sourceType, channel, content, recordedAt: recordedAt || undefined }),
      });
      
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setTitle("");
        setChannel("");
        setContent("");
        setRecordedAt("");

        // If a meeting was created, redirect to it
        if (data.meeting?.id) {
          router.push(`/workspaces/${workspaceId}/meetings/${data.meeting.id}`);
        } else {
          router.refresh();
        }
      } else if (res.status === 409) {
        // Meeting intake needs clarification (e.g., missing date)
        const data = await res.json().catch(() => ({}));
        setClarification(data.message || "Additional information is needed to process this transcript.");
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error?.message || "Failed to ingest text");
      }
    } catch {
      setError("Network error");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="nr-form-section stack" style={{ marginBottom: 32, padding: 24, border: "1px solid var(--line)", borderRadius: 8 }} onSubmit={handleSubmit}>
      <h3>{t("titlePasteText")}</h3>
      <p className="nr-item-meta" style={{ marginBottom: 16 }}>{t("descPasteText")}</p>
      
      {error && <div style={{ color: "var(--danger)", padding: "8px", background: "var(--danger-soft)" }}>{error}</div>}
      {clarification && <div style={{ color: "var(--warning-text, #b08800)", padding: "8px", background: "var(--warning-soft, #fff8e1)", borderRadius: 4 }}>{clarification}</div>}
      
      <label>
        {t("labelTitleOptional")}
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t("placeholderTitle")} />
      </label>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <label>
          {t("labelSourceType")}
          <select value={sourceType} onChange={e => setSourceType(e.target.value)}>
            {SOURCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        {isMeeting ? (
          <label>
            Meeting date/time
            <input type="datetime-local" value={recordedAt} onChange={e => setRecordedAt(e.target.value)} />
          </label>
        ) : (
          <label>
            {t("labelChannel")}
            <input value={channel} onChange={e => setChannel(e.target.value)} placeholder={t("placeholderChannel")} />
          </label>
        )}
      </div>
      
      <label>
        {t("labelContent")}
        <textarea required value={content} onChange={e => setContent(e.target.value)} rows={6} placeholder={isMeeting ? "Paste meeting transcript here..." : t("placeholderContent")} />
      </label>
      
      <div style={{ marginTop: 8 }}>
        <button type="submit" disabled={isSubmitting || !content.trim()}>
          {isSubmitting ? t("btnIngesting") : isMeeting ? "Ingest Meeting Transcript" : t("btnIngestText")}
        </button>
      </div>
      {isMeeting && (
        <p className="nr-item-meta" style={{ marginTop: 8, fontSize: "0.8rem" }}>
          Meeting transcripts are processed through the full meeting intelligence pipeline — summary, action items, tensions, proposals, and follow-ups will be extracted automatically.
        </p>
      )}
    </form>
  );
}
