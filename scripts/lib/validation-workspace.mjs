export const DEMO_WORKSPACE_SLUG = "jnj-demo";
export const INTERNAL_WORKSPACE_SLUG = "corgtex";
export const INTERNAL_VALIDATION_WORKSPACE_SLUG = "corgtex-validation";
export const INTERNAL_VALIDATION_WORKSPACE_NAME = "Corgtex Internal Validation";

const TRUE_VALUES = new Set(["1", "true", "yes", "y"]);

function firstEnv(env, names) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function boolEnv(env, name) {
  return TRUE_VALUES.has(String(env[name] ?? "").trim().toLowerCase());
}

export function validationWorkspaceSelectorFromEnv(env = process.env, prefix = "PRODUCTION_VALIDATION") {
  const normalizedPrefix = String(prefix || "PRODUCTION_VALIDATION").replace(/_+$/, "");
  const idNames = [
    `${normalizedPrefix}_WORKSPACE_ID`,
    "PRODUCTION_VALIDATION_WORKSPACE_ID",
  ];
  const slugNames = [
    `${normalizedPrefix}_WORKSPACE_SLUG`,
    "PRODUCTION_VALIDATION_WORKSPACE_SLUG",
    "VALIDATION_WORKSPACE_SLUG",
  ];
  const workspaceId = firstEnv(env, idNames);
  const workspaceSlug = firstEnv(env, slugNames);

  return {
    workspaceId,
    workspaceSlug: workspaceSlug ?? INTERNAL_VALIDATION_WORKSPACE_SLUG,
    explicit: Boolean(workspaceId || workspaceSlug),
  };
}

export function classifyWorkspaceSlug(slug) {
  const normalized = String(slug ?? "").trim();
  if (!normalized) return "unknown";
  if (normalized === DEMO_WORKSPACE_SLUG) return "demo";
  if (normalized === INTERNAL_VALIDATION_WORKSPACE_SLUG) return "internal-validation";
  if (normalized === INTERNAL_WORKSPACE_SLUG) return "internal";
  return "customer";
}

export function workspaceTenant(workspace) {
  return {
    id: workspace?.id ?? null,
    slug: workspace?.slug ?? null,
    label: workspace?.name ?? workspace?.slug ?? workspace?.id ?? null,
  };
}

export function selectWorkspaceForValidation(workspaces, {
  workspaceId = null,
  workspaceSlug = INTERNAL_VALIDATION_WORKSPACE_SLUG,
  allowFirstWorkspace = false,
  fallbackToFirstWorkspace = false,
  purpose = "production validation",
} = {}) {
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    throw new Error(`No workspaces were available for ${purpose}.`);
  }

  const id = workspaceId ? String(workspaceId).trim() : "";
  if (id) {
    const workspace = workspaces.find((item) => item.id === id);
    if (workspace) return workspace;
    throw new Error(`Workspace id ${id} was not available for ${purpose}.`);
  }

  const slug = workspaceSlug ? String(workspaceSlug).trim() : "";
  if (slug) {
    const workspace = workspaces.find((item) => item.slug === slug);
    if (workspace) return workspace;
    if (fallbackToFirstWorkspace) return workspaces[0];
    throw new Error(`Workspace slug ${slug} was not available for ${purpose}.`);
  }

  if (allowFirstWorkspace) return workspaces[0];
  throw new Error(`Set ${purpose} workspace id or slug before running a write validation.`);
}

export function requireInternalValidationWorkspace(workspace, {
  env = process.env,
  purpose = "production validation writes",
  allowCustomerEnv = "PRODUCTION_VALIDATION_ALLOW_CUSTOMER_WRITES",
} = {}) {
  const slug = workspace?.slug ?? null;
  const classification = classifyWorkspaceSlug(slug);

  if (classification === "internal-validation") return workspace;

  if (classification === "demo") {
    throw new Error(
      `${purpose} cannot target ${DEMO_WORKSPACE_SLUG}; the demo workspace is intentionally read-only for mutation-heavy validation.`,
    );
  }

  if (boolEnv(env, allowCustomerEnv)) return workspace;

  throw new Error(
    `${purpose} must target ${INTERNAL_VALIDATION_WORKSPACE_SLUG}. ` +
    `Resolved workspace slug was ${slug ?? "<unknown>"}. ` +
    `Set ${allowCustomerEnv}=true only for an audited exceptional run.`,
  );
}
