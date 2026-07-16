"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { MarkdownEditor } from "@/lib/components/MarkdownEditor";
import { TimeZoneSelect } from "@/lib/components/TimeZoneSelect";

const SOURCE_TYPES = ["MEETING","TICKET","PR","RFC","INCIDENT","SLACK","CUSTOMER_FEEDBACK","COMPETITOR","RESEARCH","ARTICLE","DOC","RUNBOOK","EMAIL","FILE_UPLOAD","EXTERNAL_CONTENT"];

export function TextPasteUploader({
  workspaceId,
  heading,
  description,
  surface = "standalone",
}: {
  workspaceId: string;
  heading?: string;
  description?: string;
  surface?: "standalone" | "embedded";
}) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState("ARTICLE");
  const [channel, setChannel] = useState("");
  const [content, setContent] = useState("");
  const [ingestionGuidanceMd, setIngestionGuidanceMd] = useState("");
  const [recordedAt, setRecordedAt] = useState("");
  const [timeZone, setTimeZone] = useState("UTC");
  const [error, setError] = useState("");
  const [clarification, setClarification] = useState("");
  const t = useTranslations("settings");

  const isMeeting = sourceType === "MEETING";

  const handleSourceTypeChange = (value: string) => {
    setSourceType(value);
    setClarification("");
    if (value === "MEETING") {
      setChannel("");
    } else {
      setRecordedAt("");
    }
  };

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
        body: JSON.stringify({
          title,
          sourceType,
          channel,
          content,
          ingestionGuidanceMd,
          recordedAt: isMeeting && recordedAt ? recordedAt : undefined,
          timeZone: isMeeting && recordedAt ? timeZone : undefined,
        }),
      });
      
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        setTitle("");
        setChannel("");
        setContent("");
        setIngestionGuidanceMd("");
        setRecordedAt("");

        if (data.meeting?.id) {
          router.push(`/workspaces/${workspaceId}/meetings/${data.meeting.id}`);
        } else {
          router.refresh();
        }
      } else if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        setClarification(data.message || t("errorMeetingClarificationFallback"));
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error?.message || t("errorFailedIngestText"));
      }
    } catch {
      setError(t("errorNetwork"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const formStyle = surface === "embedded"
    ? { marginBottom: 0, padding: 0, border: "none", borderRadius: 0 }
    : { marginBottom: 32, padding: 24, border: "1px solid var(--line)", borderRadius: 8 };

  return (
    <form className="nr-form-section stack" style={formStyle} onSubmit={handleSubmit}>
      <h3>{heading ?? t("titlePasteText")}</h3>
      <p className="nr-item-meta" style={{ marginBottom: 16 }}>{description ?? t("descPasteText")}</p>
      
      {error && <div style={{ color: "var(--danger)", padding: "8px", background: "var(--danger-soft)" }}>{error}</div>}
      {clarification && <div style={{ color: "var(--warning-text, #b08800)", padding: "8px", background: "var(--warning-soft, #fff8e1)", borderRadius: 4 }}>{clarification}</div>}
      
      <label>
        {t("labelTitleOptional")}
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t("placeholderTitle")} />
      </label>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <label>
          {t("labelSourceType")}
          <select value={sourceType} onChange={e => handleSourceTypeChange(e.target.value)}>
            {SOURCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        {isMeeting ? (
          <>
            <label>
              {t("labelMeetingRecordedAt")}
              <input
                type="datetime-local"
                value={recordedAt}
                onChange={e => setRecordedAt(e.target.value)}
                required
              />
            </label>
            <TimeZoneSelect onValueChange={setTimeZone} />
          </>
        ) : (
          <label>
            {t("labelChannel")}
            <input value={channel} onChange={e => setChannel(e.target.value)} placeholder={t("placeholderChannel")} />
          </label>
        )}
      </div>
      
      <label>
        {t("labelContent")}
        <textarea required value={content} onChange={e => setContent(e.target.value)} rows={6} placeholder={isMeeting ? t("placeholderMeetingTranscript") : t("placeholderContent")} />
      </label>

      <label>
        {t("labelIngestionGuidance")}
        <MarkdownEditor
          name="ingestionGuidanceMd"
          value={ingestionGuidanceMd}
          onValueChange={setIngestionGuidanceMd}
          rows={3}
          placeholder={t("placeholderIngestionGuidance")}
        />
      </label>
      
      <div style={{ marginTop: 8 }}>
        <button type="submit" disabled={isSubmitting || !content.trim() || (isMeeting && !recordedAt)}>
          {isSubmitting ? t("btnIngesting") : isMeeting ? t("btnIngestMeetingTranscript") : t("btnIngestText")}
        </button>
      </div>
      {isMeeting && (
        <p className="nr-item-meta" style={{ marginTop: 8, fontSize: "0.8rem" }}>
          {t("descMeetingTranscriptPipeline")}
        </p>
      )}
    </form>
  );
}
