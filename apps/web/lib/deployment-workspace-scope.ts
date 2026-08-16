import { env } from "@corgtex/shared";

type WorkspaceWithSlug = {
  slug?: string | null;
};

function normalizeSlug(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function deploymentWorkspaceScopeSlug() {
  return env.DEPLOYMENT_WORKSPACE_SCOPE_SLUG ?? null;
}

export function hasDeploymentWorkspaceScope() {
  return Boolean(deploymentWorkspaceScopeSlug());
}

export function filterWorkspacesForDeploymentScope<T extends WorkspaceWithSlug>(workspaces: T[]) {
  const scopedSlug = deploymentWorkspaceScopeSlug();
  if (!scopedSlug) {
    return workspaces;
  }

  return workspaces.filter((workspace) => normalizeSlug(workspace.slug) === scopedSlug);
}
