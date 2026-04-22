"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SOURCE_TYPES = ["MEETING","TICKET","PR","RFC","INCIDENT","SLACK","CUSTOMER_FEEDBACK","COMPETITOR","RESEARCH","ARTICLE","DOC","RUNBOOK","EMAIL","FILE_UPLOAD"];

export function TextPasteUploader({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState("ARTICLE");
  const [channel, setChannel] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;
    
    setIsSubmitting(true);
    setError("");
    
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/data-sources/text-ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, sourceType, channel, content }),
      });
      
      if (res.ok) {
        setTitle("");
        setChannel("");
        setContent("");
        router.refresh();
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
      <h3>Paste Text Content</h3>
      <p className="nr-item-meta" style={{ marginBottom: 16 }}>Paste raw transcripts, notes, or ad-hoc content directly.</p>
      
      {error && <div style={{ color: "#842029", padding: "8px", background: "#f8d7da" }}>{error}</div>}
      
      <label>
        Title (optional)
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Q3 Roadmap Planning Meeting" />
      </label>
      
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <label>
          Source Type
          <select value={sourceType} onChange={e => setSourceType(e.target.value)}>
            {SOURCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label>
          Channel/Tag (optional)
          <input value={channel} onChange={e => setChannel(e.target.value)} placeholder="#engineering, repo name..." />
        </label>
      </div>
      
      <label>
        Content
        <textarea required value={content} onChange={e => setContent(e.target.value)} rows={6} placeholder="Paste your text here..." />
      </label>
      
      <div style={{ marginTop: 8 }}>
        <button type="submit" disabled={isSubmitting || !content.trim()}>
          {isSubmitting ? "Ingesting..." : "Ingest Text"}
        </button>
      </div>
    </form>
  );
}
