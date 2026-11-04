import { readActionListReturnHref } from "./return-context";

export const ACTION_VIEW_KEYS = new Set(["view", "columns", "group", "sort", "status", "scope", "circleId", "assigneeMemberId", "page"]);

export function actionsViewStorageKey(userId: string, workspaceId: string) {
  return `actions-view:v1:${JSON.stringify([userId, workspaceId])}`;
}

// Explicit URLs are complete snapshots. Only a bare sidebar/direct visit restores
// preferences; merging saved filters into a URL would change shared links/history.
export function restoredActionsView(workspaceId: string, search: string, stored: string | null) {
  if ([...new URLSearchParams(search).keys()].some(key => ACTION_VIEW_KEYS.has(key))) return null;
  const href = readActionListReturnHref(workspaceId, stored ?? undefined);
  return href?.includes("?") ? href : null;
}
