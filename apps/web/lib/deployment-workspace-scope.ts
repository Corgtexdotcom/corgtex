import { env } from "@corgtex/shared";

type WorkspaceWithSlug = {
  slug?: string | null;
};

const SHARED_APP_HOSTS = new Set([
  "app.corgtex.com",
  "ops.corgtex.com",
  "selfserve.corgtex.com",
]);

const LOCAL_APP_HOSTS = new Set([
  "0.0.0.0",
  "127.0.0.1",
  "::1",
  "localhost",
]);

function normalizeSlug(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function configuredAppHostname() {
  try {
    return new URL(env.APP_URL).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function deploymentWorkspaceScopeSlug() {
  if (env.CONTROL_PLANE_MODE) {
    return null;
  }

  const workspaceSlug = normalizeSlug(env.WORKSPACE_SLUG);
  if (!workspaceSlug) {
    return null;
  }

  const hostname = configuredAppHostname();
  if (!hostname || SHARED_APP_HOSTS.has(hostname) || LOCAL_APP_HOSTS.has(hostname)) {
    return null;
  }

  return workspaceSlug;
}

export function filterWorkspacesForDeploymentScope<T extends WorkspaceWithSlug>(workspaces: T[]) {
  const scopedSlug = deploymentWorkspaceScopeSlug();
  if (!scopedSlug) {
    return workspaces;
  }

  return workspaces.filter((workspace) => normalizeSlug(workspace.slug) === scopedSlug);
}
