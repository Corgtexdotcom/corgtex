import { requirePageActor } from "@/lib/auth";
import {
  getMcpOAuthClientByClientId,
  getOAuthAppByClientId,
  isAllowedMcpRedirectUri,
  isAllowedOAuthRedirectUri,
  isKnownScope,
  listActorWorkspaces,
  resolveMcpClientAllowedScopes,
  resolveMcpConnectorInstanceForWorkspace,
  SCOPE_REGISTRY,
} from "@corgtex/domain";
import Link from "next/link";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{
    client_id?: string;
    redirect_uri?: string;
    state?: string;
    scope?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    resource?: string;
  }>;
};

function ErrorPanel({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen w-full items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-6 text-center ring-1 ring-[var(--line-subtle)]">
        <p className="text-[var(--danger)]">{children}</p>
      </div>
    </div>
  );
}

function scopeLabel(scope: string) {
  return isKnownScope(scope) ? SCOPE_REGISTRY[scope].label : scope;
}

function scopeDescription(scope: string) {
  return isKnownScope(scope) ? SCOPE_REGISTRY[scope].description : "Custom permission requested by this connector.";
}

function scopeGroup(scope: string): string {
  return isKnownScope(scope) ? SCOPE_REGISTRY[scope].group : "other";
}

const SCOPE_GROUP_ORDER = [
  "core",
  "governance",
  "operations",
  "knowledge",
  "people",
  "finance",
  "support",
  "other",
] as const;

const SCOPE_GROUP_LABEL: Record<string, string> = {
  core: "Core access",
  governance: "Governance",
  operations: "Operations",
  knowledge: "Knowledge & meetings",
  people: "People & shared tools",
  finance: "Finance",
  support: "Integrations & runtime",
  other: "Other permissions",
};

function groupScopes(scopes: string[]): { group: string; label: string; scopes: string[] }[] {
  const byGroup = new Map<string, string[]>();
  for (const scope of scopes) {
    const group = scopeGroup(scope);
    const existing = byGroup.get(group) ?? [];
    existing.push(scope);
    byGroup.set(group, existing);
  }
  const ordered: { group: string; label: string; scopes: string[] }[] = [];
  for (const group of SCOPE_GROUP_ORDER) {
    const entries = byGroup.get(group);
    if (entries && entries.length > 0) {
      ordered.push({ group, label: SCOPE_GROUP_LABEL[group] ?? group, scopes: entries });
    }
  }
  for (const [group, entries] of byGroup) {
    if (!SCOPE_GROUP_ORDER.includes(group as typeof SCOPE_GROUP_ORDER[number])) {
      ordered.push({ group, label: SCOPE_GROUP_LABEL[group] ?? group, scopes: entries });
    }
  }
  return ordered;
}

function ScopeGroupList({ scopes }: { scopes: string[] }) {
  const groups = groupScopes(scopes);
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <details key={group.group} open={group.group === "core"}>
          <summary className="cursor-pointer text-sm font-medium text-[var(--text-strong)]">
            {group.label} <span className="text-[var(--text-muted)]">({group.scopes.length})</span>
          </summary>
          <ul className="mt-3 space-y-3 pl-1">
            {group.scopes.map((scope) => (
              <li key={scope} className="flex flex-col items-start gap-1 text-sm">
                <span className="rounded border border-[var(--line-subtle)] bg-[var(--surface-sunken)] px-2 py-0.5 text-xs font-medium text-[var(--text-strong)]">
                  {scopeLabel(scope)}
                </span>
                <span className="text-[var(--text-muted)]">{scopeDescription(scope)}</span>
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

export default async function OAuthAuthorizePage(props: Props) {
  const searchParams = await props.searchParams;
  const actor = await requirePageActor();

  const clientId = searchParams.client_id;
  const redirectUri = searchParams.redirect_uri;
  const state = searchParams.state;
  const scopeString = searchParams.scope || "";
  const codeChallenge = searchParams.code_challenge || "";
  const codeChallengeMethod = searchParams.code_challenge_method || "";
  const resource = searchParams.resource || "";

  if (!clientId || !redirectUri) {
    return <ErrorPanel>Invalid authorization request.</ErrorPanel>;
  }

  const userWorkspaces = await listActorWorkspaces(actor);
  const mcpClient = await getMcpOAuthClientByClientId(clientId).catch(() => null);

  if (mcpClient) {
    if (!isAllowedMcpRedirectUri(mcpClient.redirectUris, redirectUri)) {
      return <ErrorPanel>The connector redirect URL is not registered.</ErrorPanel>;
    }
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      return <ErrorPanel>This connector must use browser authentication with PKCE.</ErrorPanel>;
    }

    const allowedWorkspaces = [];
    for (const workspace of userWorkspaces) {
      const instance = await resolveMcpConnectorInstanceForWorkspace(workspace.id).catch(() => null);
      if (instance) {
        allowedWorkspaces.push({ workspace, instance });
      }
    }

    if (allowedWorkspaces.length === 0) {
      return <ErrorPanel>You do not have access to a workspace registered for the Corgtex connector.</ErrorPanel>;
    }

    const displayScopes = scopeString.split(" ").filter(Boolean);
    const allowedScopes = resolveMcpClientAllowedScopes(mcpClient.scopes);
    const effectiveScopes: string[] = displayScopes.length > 0 ? displayScopes : allowedScopes;
    const deniedRedirectUrl = new URL(redirectUri);
    deniedRedirectUrl.searchParams.set("error", "access_denied");
    if (state) deniedRedirectUrl.searchParams.set("state", state);
    const currentUserLabel = actor.kind === "user"
      ? actor.user.displayName || actor.user.email
      : "this Corgtex account";
    const currentUserEmail = actor.kind === "user" ? actor.user.email : null;
    const selectedWorkspace = allowedWorkspaces[0];
    const hasMultipleWorkspaces = allowedWorkspaces.length > 1;

    return (
      <div className="relative flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] p-4 sm:p-8">
        <div className="w-full max-w-[520px]">
          <div className="mb-8 flex flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--surface-strong)] ring-1 ring-[var(--line-subtle)]">
              <span className="text-base font-bold text-[var(--danger)]">Corgtex</span>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--text-strong)]">Authorize Corgtex MCP</h1>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                Authorize this MCP client to access Corgtex.
              </p>
            </div>
          </div>

          <div className="ui-card overflow-hidden">
            <div className="border-b border-[var(--line-subtle)] bg-[var(--surface-sunken)] px-6 py-5">
              <h2 className="text-xl font-bold text-[var(--text-strong)]">
                Allow {mcpClient.name}
              </h2>
              <p className="mt-1 text-sm text-[var(--text-muted)]">
                Authorize this MCP client to access Corgtex as <span className="font-medium text-[var(--text-strong)]">{currentUserLabel}</span>
                {" "}for <span className="font-medium text-[var(--text-strong)]">{selectedWorkspace.workspace.name}</span>.
              </p>
              {actor.kind === "user" ? (
                <p className="mt-3 text-xs text-[var(--text-muted)]">
                  Current Corgtex account: <span className="font-medium text-[var(--text-strong)]">{currentUserLabel}</span>
                  {currentUserEmail && currentUserEmail !== currentUserLabel ? ` (${currentUserEmail})` : ""}
                </p>
              ) : null}
            </div>

            <form action="/api/oauth/authorize" method="POST">
              <div className="border-b border-[var(--line-subtle)] px-6 py-6">
                {hasMultipleWorkspaces ? (
                  <label className="block text-sm font-medium text-[var(--text-strong)]">
                    Workspace
                    <select
                      name="workspaceId"
                      className="mt-2 w-full rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2"
                      defaultValue={selectedWorkspace.workspace.id}
                    >
                      {allowedWorkspaces.map(({ workspace, instance }) => (
                        <option key={workspace.id} value={workspace.id}>
                          {workspace.name} ({instance.displayName})
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <div>
                    <input type="hidden" name="workspaceId" value={selectedWorkspace.workspace.id} />
                    <p className="text-sm font-medium text-[var(--text-strong)]">Workspace</p>
                    <p className="mt-2 rounded border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text-strong)]">
                      {selectedWorkspace.workspace.name} ({selectedWorkspace.instance.displayName})
                    </p>
                  </div>
                )}
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  The connector will only see the selected Corgtex workspace. Provider account email is not used for authorization.
                </p>
              </div>

              <div className="border-b border-[var(--line-subtle)] px-6 py-6">
                <h3 className="mb-4 text-sm font-medium text-[var(--text-strong)]">
                  This connector can
                </h3>
                <ScopeGroupList scopes={effectiveScopes} />
              </div>

              <div className="bg-[var(--surface-sunken)] px-6 py-6">
                <input type="hidden" name="clientId" value={clientId} />
                <input type="hidden" name="redirectUri" value={redirectUri} />
                <input type="hidden" name="state" value={state || ""} />
                <input type="hidden" name="scopes" value={effectiveScopes.join(" ")} />
                <input type="hidden" name="codeChallenge" value={codeChallenge} />
                <input type="hidden" name="codeChallengeMethod" value={codeChallengeMethod} />
                <input type="hidden" name="resource" value={resource} />

                <button type="submit" className="button w-full py-2.5 text-base">
                  Allow access
                </button>

                <Link href={deniedRedirectUrl.toString()} className="block w-full py-2 text-center text-[var(--text-muted)] hover:text-[var(--text-strong)]">
                  Cancel
                </Link>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  const app = await getOAuthAppByClientId(clientId).catch(() => null);
  if (!app) {
    return <ErrorPanel>Invalid client configuration.</ErrorPanel>;
  }
  if (!isAllowedOAuthRedirectUri(app.redirectUris, redirectUri)) {
    return <ErrorPanel>The redirect URL is not registered.</ErrorPanel>;
  }

  const targetWorkspace = userWorkspaces.find((workspace) => workspace.id === app.workspaceId);
  if (!targetWorkspace) {
    return <ErrorPanel>You do not have access to this workspace.</ErrorPanel>;
  }

  const requestedScopes = scopeString.split(" ").filter(Boolean);
  const displayScopes: string[] = requestedScopes.length > 0 ? requestedScopes : app.scopes;
  const deniedRedirectUrl = new URL(redirectUri);
  deniedRedirectUrl.searchParams.set("error", "access_denied");
  if (state) deniedRedirectUrl.searchParams.set("state", state);

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] p-4 sm:p-8">
      <div className="w-full max-w-[440px]">
        <div className="mb-8 flex flex-col items-center justify-center gap-3 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-[var(--surface-strong)] ring-1 ring-[var(--line-subtle)]">
            <span className="text-base font-bold text-[var(--danger)]">Corgtex</span>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-[var(--text-strong)]">Approve connection</h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              Allow {app.name} to access {targetWorkspace.name}.
            </p>
          </div>
        </div>

        <div className="ui-card overflow-hidden">
          <div className="border-b border-[var(--line-subtle)] px-6 py-6">
            <h3 className="mb-4 text-sm font-medium text-[var(--text-strong)]">
              This connection can
            </h3>
            <ScopeGroupList scopes={displayScopes} />
          </div>

          <div className="bg-[var(--surface-sunken)] px-6 py-6">
            <form action="/api/oauth/authorize" method="POST" className="flex flex-col gap-3">
              <input type="hidden" name="clientId" value={clientId} />
              <input type="hidden" name="redirectUri" value={redirectUri} />
              <input type="hidden" name="state" value={state || ""} />
              <input type="hidden" name="scopes" value={displayScopes.join(" ")} />

              <button type="submit" className="button w-full py-2.5 text-base">
                Allow access
              </button>

              <Link href={deniedRedirectUrl.toString()} className="block w-full py-2 text-center text-[var(--text-muted)] hover:text-[var(--text-strong)]">
                Cancel
              </Link>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
