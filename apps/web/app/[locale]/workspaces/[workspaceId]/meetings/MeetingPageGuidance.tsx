import React from "react";
import Link from "next/link";

export function MeetingPageGuidance({
  title,
  workflow,
  archive,
  openBrain,
  workspaceId,
}: {
  title: string;
  workflow: string;
  archive: string;
  openBrain: string;
  workspaceId: string;
}) {
  return (
    <details className="meeting-page-guidance">
      <summary className="settings-disclosure-summary meeting-page-guidance-summary">{title}</summary>
      <div className="meeting-page-guidance-copy">
        <p>
          {workflow}{" "}
          <Link href={`/workspaces/${workspaceId}/brain`}>{openBrain}</Link>
        </p>
        <p>{archive}</p>
      </div>
    </details>
  );
}
