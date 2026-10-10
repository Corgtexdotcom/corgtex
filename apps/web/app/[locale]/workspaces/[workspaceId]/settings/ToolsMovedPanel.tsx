import React from "react";

function toolsHref(locale: string, workspaceId: string, query: string) {
  return `/${locale}/workspaces/${workspaceId}/tools${query}`;
}

export function ToolsMovedPanel({
  locale,
  workspaceId,
  compact = false,
  toolsAvailable,
  dataSourcesAvailable,
}: {
  locale: string;
  workspaceId: string;
  compact?: boolean;
  toolsAvailable: boolean;
  dataSourcesAvailable: boolean;
}) {
  return (
    <section className="nr-item stack" style={{ gap: 12, padding: 18 }}>
      <div>
        <h2 className="nr-section-header" style={{ marginTop: 0 }}>
          Tools and integrations
        </h2>
        <p className="nr-item-meta" style={{ fontSize: "0.85rem", margin: 0 }}>
          {toolsAvailable
            ? "Connector setup, databases, webhooks, apps, and shared tool links now live in Tools."
            : "The Tools directory is not enabled in this workspace."}
        </p>
      </div>
      {toolsAvailable && <div className="actions-inline">
        <a className="button secondary small" href={toolsHref(locale, workspaceId, "?type=CONNECTOR")}>Connectors</a>
        {dataSourcesAvailable
          ? <a className="button secondary small" href={toolsHref(locale, workspaceId, "?surface=apps&type=DATA_SOURCE")}>Data sources</a>
          : <span className="nr-item-meta">Data sources are not enabled in this workspace.</span>}
        <a className="button secondary small" href={toolsHref(locale, workspaceId, "?type=TOOL&q=webhooks")}>Webhooks</a>
        {!compact && <a className="button secondary small" href={toolsHref(locale, workspaceId, "?type=TOOL&q=meeting%20transcripts")}>Meeting transcripts</a>}
      </div>}
    </section>
  );
}
