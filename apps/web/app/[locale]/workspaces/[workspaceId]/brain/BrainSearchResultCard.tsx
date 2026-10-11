import React from "react";
import type { BrainSearchDisplayResult } from "./view-model";

export function BrainSearchResultCard({ result, workspaceId, unavailableLabel }: {
  result: BrainSearchDisplayResult;
  workspaceId: string;
  unavailableLabel: string;
}) {
  // A retrieval hit is not proof that its Meeting still exists or is linkable.
  if (result.sourceType === "MEETING" && !result.meetingId) {
    return <div className="nr-item brain-search-result"><div className="nr-meta">{unavailableLabel}</div></div>;
  }

  const href = result.meetingId
    ? `/workspaces/${workspaceId}/meetings/${result.meetingId}`
    : result.articleSlug
      ? `/workspaces/${workspaceId}/brain/${result.articleSlug}`
      : null;
  const body = (
    <>
      <div className="brain-search-result-title">{result.title ?? result.sourceId}</div>
      <div className="nr-meta">{result.sourceType}</div>
      <p className="nr-excerpt">{result.snippet.slice(0, 150)}...</p>
      {!href && <div className="nr-meta">{unavailableLabel}</div>}
    </>
  );

  return href
    ? <a href={href} className="nr-item brain-search-result">{body}</a>
    : <div className="nr-item brain-search-result">{body}</div>;
}
