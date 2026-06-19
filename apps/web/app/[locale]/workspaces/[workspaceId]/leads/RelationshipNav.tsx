import type { RelationshipView } from "./view-model";
import { relationshipViewHref } from "./view-model";

const PRIMARY_RELATIONSHIP_VIEWS: RelationshipView[] = [
  "dashboard",
  "accounts",
  "pipeline",
  "activity",
  "suggestions",
];

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
      {PRIMARY_RELATIONSHIP_VIEWS.map((key) => (
        <a
          key={key}
          href={relationshipViewHref(workspaceId, key)}
          className={`nr-filter-item ${active === key ? "nr-filter-active" : ""}`}
        >
          {labels[key]}
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
