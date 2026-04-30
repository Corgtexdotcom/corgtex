import { env, parseAllowedWorkspaceIds, prisma, randomOpaqueToken, sha256 } from "@corgtex/shared";
import type { AppActor } from "@corgtex/shared";
import { AppError, invariant } from "./errors";
import { requireWorkspaceMembership } from "./auth";
import { getOrCreateExternalAgentIdentity } from "./agent-identity";

const BOOTSTRAP_AGENT_LABEL = "bootstrap-agent";
const BOOTSTRAP_PREFIX = "agent-";
const CREDENTIAL_PREFIX = "agentc-";

/**
 * Canonical registry of every scope an agent credential can hold.
 *
 * This is the single source of truth used by:
 *   - The MCP server (every `requireScope(...)` call must reference a scope here)
 *   - The admin UI (scope chips, default-selection, "grant missing scopes")
 *   - The OAuth consent screen (scope labels rendered to the user)
 *
 * A scope is `default: true` if it is granted automatically when an admin
 * clicks "Connect <provider>" without picking a custom scope set. The
 * working assumption is that the MCP is the user's primary interface to
 * Corgtex, so most scopes are default. Mark a scope `default: false` only
 * when it grants a power that not every agent should have by default
 * (e.g. destructive admin operations) — then surface it in the UI as
 * an opt-in toggle.
 *
 * Adding a scope here does not grant it to existing credentials. Use the
 * "Grant missing scopes" UI (or the PATCH agent-credentials endpoint)
 * to upgrade live credentials without forcing users to reconnect.
 */
export const SCOPE_REGISTRY = {
  // ---- core read/chat ----
  "workspace:read":      { label: "Read workspace info",        group: "core",       default: true,  delegatedDefault: true,  description: "Workspace name, description, and aggregate counts." },
  "support:write":       { label: "Write support audit",        group: "core",       default: false, delegatedDefault: false, description: "Record Corgtex Support audit entries in a customer workspace. Sensitive — support-only." },
  "archive:read":        { label: "Read archived records",      group: "core",       default: false, delegatedDefault: true,  description: "List archived workspace artifacts for recovery and audit." },
  "archive:write":       { label: "Restore and purge archives", group: "core",       default: false, delegatedDefault: true,  description: "Restore archived records or purge eligible archived records. Sensitive — same-role delegation." },
  "brain:read":          { label: "Search the Brain",           group: "core",       default: true,  delegatedDefault: true,  description: "Semantic search over policies, meeting notes, proposals, and other indexed content." },
  "conversations:write": { label: "Chat with Corgtex",          group: "core",       default: true,  delegatedDefault: true,  description: "Send messages to the Corgtex assistant (server-side LLM call)." },

  // ---- proposals ----
  "proposals:read":      { label: "Read proposals",             group: "governance", default: true,  delegatedDefault: true,  description: "List, get, and view governance proposals." },
  "proposals:write":     { label: "Create & edit proposals",    group: "governance", default: true,  delegatedDefault: true,  description: "Create, update, submit, archive, and publish proposals." },

  // ---- actions ----
  "actions:read":        { label: "Read actions",               group: "operations", default: true,  delegatedDefault: true,  description: "List and view action items." },
  "actions:write":       { label: "Create & edit actions",      group: "operations", default: true,  delegatedDefault: true,  description: "Create, update, complete, and delete action items." },

  // ---- tensions ----
  "tensions:read":       { label: "Read tensions",              group: "operations", default: true,  delegatedDefault: true,  description: "List and view tensions raised in the workspace." },
  "tensions:write":      { label: "Create & edit tensions",     group: "operations", default: true,  delegatedDefault: true,  description: "Create, update, upvote, and resolve tensions." },

  // ---- goals ----
  "goals:read":          { label: "Read goals",                  group: "operations", default: true,  delegatedDefault: true,  description: "List, get, and view workspace goals and key results." },
  "goals:write":         { label: "Create & edit goals",         group: "operations", default: true,  delegatedDefault: true,  description: "Create, update, and archive workspace goals and key results." },

  // ---- members ----
  "members:read":        { label: "Read members",               group: "people",     default: true,  delegatedDefault: true,  description: "List active members and their roles." },
  "members:write":       { label: "Manage members",             group: "people",     default: false, delegatedDefault: true,  description: "Create, update, and deactivate members. Sensitive — same-role delegation." },
  "tools:read":          { label: "Read shared tools",           group: "people",     default: true,  delegatedDefault: true,  description: "List shared workspace tool links and non-secret access notes." },
  "tools:write":         { label: "Manage shared tools",         group: "people",     default: false, delegatedDefault: true,  description: "Create, update, and archive shared workspace tool links. Sensitive — same-role delegation." },
  "tools:credentials:read": { label: "Reveal shared tool credentials", group: "people", default: false, delegatedDefault: true, description: "Reveal encrypted credentials saved on shared tool links. Sensitive — same-role delegation and audited." },

  // ---- meetings ----
  "meetings:read":       { label: "Read meetings",              group: "knowledge",  default: true,  delegatedDefault: true,  description: "List meetings and their summaries." },
  "meetings:write":      { label: "Upload & edit meetings",     group: "knowledge",  default: true,  delegatedDefault: true,  description: "Create meetings (upload minutes / transcripts) and delete them." },
  "documents:write":     { label: "Upload documents",           group: "knowledge",  default: false, delegatedDefault: true,  description: "Upload documents or data drops into workspace documents. Sensitive — same-role delegation." },

  // ---- brain (writes) ----
  "brain:write":         { label: "Write to the Brain",         group: "knowledge",  default: true,  delegatedDefault: true,  description: "Create and edit knowledge articles, post discussion comments, resolve threads." },

  // ---- cycles / sprints ----
  "cycles:read":         { label: "Read cycles",                group: "operations", default: true,  delegatedDefault: true,  description: "List cycles, allocations, and cycle updates." },
  "cycles:write":        { label: "Create & edit cycles",       group: "operations", default: true,  delegatedDefault: true,  description: "Create and update cycles, allocations, and cycle updates." },

  // ---- circles / org structure ----
  "circles:read":        { label: "Read circles",               group: "people",     default: true,  delegatedDefault: true,  description: "List circles and their members for org-structure context." },

  // ---- governance reference ----
  "governance:read":     { label: "Read governance",            group: "governance", default: true,  delegatedDefault: true,  description: "Read the constitution, active policies, and governance scoring." },

  // ---- finance ----
  "finance:read":        { label: "Read finance",               group: "finance",    default: true,  delegatedDefault: true,  description: "List spend requests and ledger accounts." },
  "finance:write":       { label: "Submit spend requests",      group: "finance",    default: false, delegatedDefault: true,  description: "Create and submit spend requests on behalf of users. Sensitive — same-role delegation." },

  // ---- support / operations ----
  "integrations:read":   { label: "Read integrations",          group: "support",    default: false, delegatedDefault: true,  description: "Inspect installed communication and OAuth integrations. Admin-only where domain rules require it." },
  "data-sources:read":   { label: "Read data feeds",            group: "support",    default: false, delegatedDefault: true,  description: "Inspect external data sources and sync health. Admin-only where domain rules require it." },
  "data-sources:write":  { label: "Sync data feeds",            group: "support",    default: false, delegatedDefault: true,  description: "Trigger external data source sync jobs. Sensitive — same-role delegation." },
  "agents:read":         { label: "Read agent runs",            group: "support",    default: false, delegatedDefault: true,  description: "Inspect agent runs, steps, and failures. Same-role delegation." },
  "runtime:read":        { label: "Read runtime jobs",          group: "support",    default: false, delegatedDefault: true,  description: "Inspect workflow jobs and runtime failures. Same-role delegation." },
  "runtime:write":       { label: "Repair runtime jobs",        group: "support",    default: false, delegatedDefault: true,  description: "Retry or discard failed workflow jobs. Sensitive — same-role delegation." },
} as const satisfies Record<string, { label: string; group: string; default: boolean; delegatedDefault: boolean; description: string }>;

export type AgentScope = keyof typeof SCOPE_REGISTRY;

export const ALL_SCOPES = Object.keys(SCOPE_REGISTRY) as AgentScope[];

export const DEFAULT_SCOPES = ALL_SCOPES.filter((scope) => SCOPE_REGISTRY[scope].default);

export const DELEGATED_DEFAULT_SCOPES = ALL_SCOPES.filter((scope) => SCOPE_REGISTRY[scope].delegatedDefault);

/**
 * Backwards-compatible alias for the previous flat string list.
 * @deprecated use SCOPE_REGISTRY / ALL_SCOPES / DEFAULT_SCOPES instead.
 */
export const KNOWN_SCOPES = ALL_SCOPES;

export function isKnownScope(scope: string): scope is AgentScope {
  return scope in SCOPE_REGISTRY;
}

export function describeScope(scope: string): string {
  return isKnownScope(scope) ? SCOPE_REGISTRY[scope].description : scope;
}

export type AgentAuthProvider = {
  name: "bootstrap" | "credential";
  resolve(token: string): Promise<AppActor | null>;
};

function normalizeScopes(scopes: string[] | undefined) {
  return [...new Set((scopes ?? []).map((value) => value.trim()).filter(Boolean))];
}

/**
 * Strict scope validator. Used by every credential mutation so an admin
 * cannot persist a typo or a deprecated scope. Returns the normalized,
 * de-duplicated set on success; throws AppError(400) otherwise.
 */
function validateScopes(scopes: string[] | undefined): string[] {
  const normalized = normalizeScopes(scopes);
  const unknown = normalized.filter((scope) => !isKnownScope(scope));
  invariant(
    unknown.length === 0,
    400,
    "INVALID_INPUT",
    `Unknown scope(s): ${unknown.join(", ")}. Known scopes: ${ALL_SCOPES.join(", ")}.`,
  );
  return normalized;
}

export const bootstrapAgentAuthProvider: AgentAuthProvider = {
  name: "bootstrap",
  async resolve(token: string) {
    if (!token.startsWith(BOOTSTRAP_PREFIX)) {
      return null;
    }

    const provided = token.slice(BOOTSTRAP_PREFIX.length).trim();
    if (!env.AGENT_API_KEY || provided !== env.AGENT_API_KEY) {
      return null;
    }

    return {
      kind: "agent",
      authProvider: "bootstrap",
      label: BOOTSTRAP_AGENT_LABEL,
      workspaceIds: [...parseAllowedWorkspaceIds()],
    };
  },
};

export const credentialAgentAuthProvider: AgentAuthProvider = {
  name: "credential",
  async resolve(token: string) {
    if (!token.startsWith(CREDENTIAL_PREFIX)) {
      return null;
    }

    const secret = token.slice(CREDENTIAL_PREFIX.length).trim();
    if (!secret) {
      return null;
    }

    const credential = await prisma.agentCredential.findUnique({
      where: {
        tokenHash: sha256(secret),
      },
      select: {
        id: true,
        workspaceId: true,
        label: true,
        scopes: true,
        isActive: true,
      },
    });

    if (!credential?.isActive) {
      return null;
    }

    await prisma.agentCredential.update({
      where: { id: credential.id },
      data: {
        lastUsedAt: new Date(),
      },
    });

    const identity = await getOrCreateExternalAgentIdentity(
      credential.workspaceId,
      credential.id,
      credential.label,
      null, // Assuming no user id from just credential resolve
    );

    return {
      kind: "agent",
      authProvider: "credential",
      credentialId: credential.id,
      label: credential.label,
      workspaceIds: [credential.workspaceId],
      scopes: credential.scopes,
      agentIdentityId: identity?.id,
    };
  },
};

const agentAuthProviders: AgentAuthProvider[] = [
  credentialAgentAuthProvider,
  bootstrapAgentAuthProvider,
];

export async function resolveAgentActorFromBearer(token: string) {
  for (const provider of agentAuthProviders) {
    const actor = await provider.resolve(token);
    if (actor) {
      return actor;
    }
  }

  return null;
}

export async function listAgentCredentials(actor: AppActor, workspaceId: string) {
  await requireWorkspaceMembership({
    actor,
    workspaceId,
    allowedRoles: ["ADMIN"],
  });

  return prisma.agentCredential.findMany({
    where: { workspaceId },
    select: {
      id: true,
      label: true,
      scopes: true,
      isActive: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export async function issueAgentCredential(actor: AppActor, params: {
  workspaceId: string;
  label: string;
  scopes?: string[];
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  const label = params.label.trim();
  invariant(label.length > 0, 400, "INVALID_INPUT", "Credential label is required.");

  const secret = randomOpaqueToken();
  const credential = await prisma.agentCredential.create({
    data: {
      workspaceId: params.workspaceId,
      createdByUserId: actor.kind === "user" ? actor.user.id : null,
      label,
      tokenHash: sha256(secret),
      scopes: validateScopes(params.scopes),
      isActive: true,
    },
    select: {
      id: true,
      label: true,
      scopes: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    credential,
    token: `${CREDENTIAL_PREFIX}${secret}`,
  };
}

export async function rotateAgentCredential(actor: AppActor, params: {
  workspaceId: string;
  credentialId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  const credential = await prisma.agentCredential.findUnique({
    where: { id: params.credentialId },
    select: {
      id: true,
      workspaceId: true,
      label: true,
      scopes: true,
    },
  });

  invariant(credential && credential.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Agent credential not found.");

  const secret = randomOpaqueToken();
  const rotated = await prisma.agentCredential.update({
    where: { id: credential.id },
    data: {
      tokenHash: sha256(secret),
      isActive: true,
      lastUsedAt: null,
    },
    select: {
      id: true,
      label: true,
      scopes: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return {
    credential: rotated,
    token: `${CREDENTIAL_PREFIX}${secret}`,
  };
}

export async function revokeAgentCredential(actor: AppActor, params: {
  workspaceId: string;
  credentialId: string;
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  const credential = await prisma.agentCredential.findUnique({
    where: { id: params.credentialId },
    select: {
      id: true,
      workspaceId: true,
      isActive: true,
    },
  });

  invariant(credential && credential.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Agent credential not found.");
  invariant(credential.isActive, 400, "INVALID_STATE", "Agent credential is already revoked.");

  return prisma.agentCredential.update({
    where: { id: credential.id },
    data: {
      isActive: false,
    },
    select: {
      id: true,
      label: true,
      scopes: true,
      isActive: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * Update the scope set on an existing credential **without rotating the token**.
 *
 * This is the self-healing path: when the MCP server adds a new tool that
 * requires a new scope, an admin can grant the missing scope to existing
 * credentials in one click — clients (Claude Desktop, ChatGPT, Cursor) keep
 * working with the same bearer token they already have configured.
 *
 * Use this in preference to revoke+reissue, which forces every connected
 * client to be reconfigured.
 */
export async function updateAgentCredentialScopes(actor: AppActor, params: {
  workspaceId: string;
  credentialId: string;
  scopes: string[];
}) {
  await requireWorkspaceMembership({
    actor,
    workspaceId: params.workspaceId,
    allowedRoles: ["ADMIN"],
  });

  const existing = await prisma.agentCredential.findUnique({
    where: { id: params.credentialId },
    select: { id: true, workspaceId: true, isActive: true },
  });

  invariant(existing && existing.workspaceId === params.workspaceId, 404, "NOT_FOUND", "Agent credential not found.");
  invariant(existing.isActive, 400, "INVALID_STATE", "Cannot update scopes on a revoked credential. Reissue it instead.");

  return prisma.agentCredential.update({
    where: { id: existing.id },
    data: {
      scopes: validateScopes(params.scopes),
    },
    select: {
      id: true,
      label: true,
      scopes: true,
      isActive: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

export function requireAgentScope(actor: AppActor, scope: string) {
  if (actor.kind !== "agent" || actor.authProvider !== "credential") {
    return;
  }

  if (!actor.scopes?.includes(scope)) {
    throw new AppError(403, "FORBIDDEN", "Agent credential is missing the required scope.");
  }
}
