import { invariant } from "./errors";

export const MANAGED_RELEASE_OPERATIONAL_WORKSPACE_SLUG = "corgtex-managed-release-ops";

const RESERVED_WORKSPACE_SLUGS = new Set([
  MANAGED_RELEASE_OPERATIONAL_WORKSPACE_SLUG,
]);

export function assertCustomerAssignableWorkspaceSlug(slug: string) {
  invariant(!RESERVED_WORKSPACE_SLUGS.has(slug), 403, "WORKSPACE_SLUG_RESERVED", "This workspace slug is reserved.");
}
