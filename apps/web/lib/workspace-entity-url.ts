export function resolveWorkspaceEntityUrl(
  workspaceId: string,
  entityType: string | null,
  entityId: string | null,
): string | null {
  if (!entityType || !entityId) return null;

  const normalizedType = entityType.toLowerCase();
  if (normalizedType === "proposal") return `/workspaces/${workspaceId}/proposals/${entityId}`;
  if (normalizedType === "tension") return `/workspaces/${workspaceId}/tensions/${entityId}`;
  if (normalizedType === "action") return `/workspaces/${workspaceId}/actions`;
  if (normalizedType === "meeting") return `/workspaces/${workspaceId}/meetings/${entityId}`;
  if (normalizedType === "adviceprocess") return `/workspaces/${workspaceId}/proposals?status=OPEN`;
  if (normalizedType === "advicerecord") return `/workspaces/${workspaceId}/proposals?status=OPEN`;
  if (normalizedType === "spend" || normalizedType === "spendrequest") return `/workspaces/${workspaceId}/finance`;
  if (normalizedType === "conversationsession") return `/workspaces/${workspaceId}/chat?session=${entityId}`;

  return null;
}
