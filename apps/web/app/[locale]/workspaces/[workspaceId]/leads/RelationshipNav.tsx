import type { RelationshipView } from "./view-model";
import { relationshipViewHref } from "./view-model";

export function RelationshipNav({
  workspaceId,
  active,
  labels,
}: {
  workspaceId: string;
  active: RelationshipView;
  labels: Record<RelationshipView, string>;
}) {
  return (
    <div className="nr-filter-bar">
      {Object.entries(labels).map(([key, label]) => (
        <a
          key={key}
          href={relationshipViewHref(workspaceId, key as RelationshipView)}
          className={`nr-filter-item ${active === key ? "nr-filter-active" : ""}`}
        >
          {label}
        </a>
      ))}
    </div>
  );
}

export function relationshipNavLabels(t: any): Record<RelationshipView, string> {
  return {
    dashboard: t("tabDashboard"),
    accounts: t("tabAccounts"),
    contacts: t("tabContacts"),
    pipeline: t("tabPipeline"),
    activity: t("tabActivity"),
    suggestions: t("tabSuggestions"),
    review: t("tabReview"),
    conversations: t("tabConversations"),
    instances: t("tabInstances"),
  };
}
