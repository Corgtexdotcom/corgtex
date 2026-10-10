import React from "react";
import type { BrainSearchSourceGroup as BrainSearchSourceGroupValue } from "./view-model";

function excerpt(snippet: string) {
  const text = snippet.trim();
  return text.length > 220 ? `${text.slice(0, 220).trimEnd()}…` : text;
}

export function BrainSearchSourceGroup({ group, workspaceId, sourceTypeLabel, passagesLabel, morePassagesLabel, unavailableLabel }: {
  group: BrainSearchSourceGroupValue;
  workspaceId: string;
  sourceTypeLabel: string;
  passagesLabel: string;
  morePassagesLabel: string;
  unavailableLabel: string;
}) {
  const href = group.meetingId
    ? `/workspaces/${workspaceId}/meetings/${group.meetingId}`
    : group.articleSlug
      ? `/workspaces/${workspaceId}/brain/${group.articleSlug}`
      : null;
  const title = group.title || group.sourceId;
  const [lead, ...additional] = group.passages;

  return (
    <article className="nr-item brain-search-source">
      <div className="brain-search-source-head">
        <h4 className="brain-search-result-title">
          {href ? <a href={href}>{title}</a> : title}
        </h4>
        <div className="nr-meta">{sourceTypeLabel} · {passagesLabel}</div>
      </div>
      {lead && <p className="nr-excerpt">{excerpt(lead.snippet)}</p>}
      {additional.length > 0 && (
        <details className="brain-search-passages">
          <summary>{morePassagesLabel}</summary>
          <ol>
            {additional.map((passage) => (
              <li key={passage.chunkId}>{excerpt(passage.snippet)}</li>
            ))}
          </ol>
        </details>
      )}
      {!href && <div className="nr-meta">{unavailableLabel}</div>}
    </article>
  );
}
