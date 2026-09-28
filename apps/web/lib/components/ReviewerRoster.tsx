"use client";

import { useState } from "react";

export function ReviewerRoster({
  reviewers,
  proposalPath,
  labels,
}: {
  reviewers: Array<{ memberId: string; name: string; choice: string | null; hasOpenObjection: boolean }>;
  proposalPath: string;
  labels: {
    title: string;
    tally: string;
    pending: string;
    reviewed: string;
    objected: string;
    copyNudge: string;
    copied: string;
    nudge: string;
  };
}) {
  const [copied, setCopied] = useState(false);
  const pending = reviewers.filter((reviewer) => !reviewer.choice && !reviewer.hasOpenObjection);
  const copyNudge = async () => {
    const link = `${window.location.origin}${proposalPath}`;
    await navigator.clipboard.writeText(`${labels.nudge}\n${link}\n${pending.map((reviewer) => reviewer.name).join(", ")}`);
    setCopied(true);
  };

  return (
    <div className="nr-decision-roster">
      <strong>{labels.title}</strong>
      <p className="nr-item-meta">{labels.tally}</p>
      <ul>
        {reviewers.map((reviewer) => (
          <li key={reviewer.memberId}>
            {reviewer.name} · {reviewer.hasOpenObjection ? labels.objected : reviewer.choice ? labels.reviewed : labels.pending}
          </li>
        ))}
      </ul>
      {pending.length > 0 && (
        <button type="button" className="secondary small" onClick={copyNudge}>
          {copied ? labels.copied : labels.copyNudge}
        </button>
      )}
    </div>
  );
}
