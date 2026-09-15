import type { AppActor } from "@corgtex/shared";
import { AppError, getWorkspaceSupportGrant, requireWorkspaceMembership } from "@corgtex/domain";

export function workspaceIdFromPath(pathname: string) {
  const match = /^\/(?:api\/|(?:en|es)\/)?workspaces\/([^/]+)(?:\/|$)/.exec(pathname);
  return match && !["create"].includes(match[1]) ? decodeURIComponent(match[1]) : null;
}

// These handlers validate a query/body or verified OAuth-state workspace before use.
export function isWorkspaceAuthorizedProviderRoute(pathname: string) {
  return /^\/api\/integrations\/(?:google|microsoft|box)\/(?:connect|callback)$/.test(pathname)
    || /^\/api\/integrations\/slack\/(?:install|callback)$/.test(pathname)
    || /^\/api\/integrations\/connections\/[^/]+\/disconnect$/.test(pathname)
    || /^\/api\/billing\/(?:checkout|portal)$/.test(pathname);
}

export async function requireSupportRequestAccess(actor: AppActor, pathname: string) {
  const workspaceId = workspaceIdFromPath(pathname);
  if (workspaceId) {
    if (actor.kind === "user" && ["support-setup", "support-configuration"].some(endpoint => pathname === `/api/workspaces/${encodeURIComponent(workspaceId)}/${endpoint}`)) {
      const grant = await getWorkspaceSupportGrant(actor, workspaceId);
      if (grant?.isActive) return;
      throw new AppError(403, "SUPPORT_ACCESS_REQUIRED", "Support access is unavailable.");
    }
    await requireWorkspaceMembership({ actor, workspaceId });
    return;
  }
  // Human account permissions outside this workspace are independent of a tenant grant.
  if (actor.kind === "user" || !actor.supportOrigin) return;
  if (pathname === "/api/workspaces" || pathname === "/api/user/profile") return;
  throw new AppError(403, "SUPPORT_ACCESS_RESTRICTED", "This action is unavailable for support accounts.");
}
