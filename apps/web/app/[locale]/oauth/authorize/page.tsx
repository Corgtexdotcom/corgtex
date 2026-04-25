import { requirePageActor } from "@/lib/auth";
import { getOAuthAppByClientId, isAllowedOAuthRedirectUri, listActorWorkspaces } from "@corgtex/domain";
import { SCOPE_REGISTRY, isKnownScope } from "@corgtex/domain";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{
    client_id?: string;
    redirect_uri?: string;
    state?: string;
    scope?: string;
  }>;
};

export default async function OAuthAuthorizePage(props: Props) {
  const searchParams = await props.searchParams;
  const t = await getTranslations("oauth");

  // Re-verify auth - if they aren't logged in, Next.js / requirePageActor
  // should ideally redirect here after login, but for now we expect them logged in
  const actor = await requirePageActor();

  const clientId = searchParams.client_id;
  const redirectUri = searchParams.redirect_uri;
  const state = searchParams.state;
  const scopeString = searchParams.scope || "";

  if (!clientId || !redirectUri) {
    return (
      <div className="flex h-screen w-full items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-6 text-center ring-1 ring-[var(--line-subtle)]">
          <p className="text-[var(--danger)]">{t("invalidAuthRequest")}</p>
        </div>
      </div>
    );
  }

  const app = await getOAuthAppByClientId(clientId).catch(() => null);

  if (!app) {
    return (
      <div className="flex h-screen w-full items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-6 text-center ring-1 ring-[var(--line-subtle)]">
          <p className="text-[var(--danger)]">{t("invalidClientConfig")}</p>
        </div>
      </div>
    );
  }

  if (!isAllowedOAuthRedirectUri(app.redirectUris, redirectUri)) {
    return (
      <div className="flex h-screen w-full items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-6 text-center ring-1 ring-[var(--line-subtle)]">
          <p className="text-[var(--danger)]">{t("invalidRedirectUri")}</p>
        </div>
      </div>
    );
  }

  // Double check workspace match. In our selected flow (Option B), the workspace is
  // tied strictly to the OAuth app created by the admin.
  // We just need to confirm the current user is a member of that workspace.
  const userWorkspaces = await listActorWorkspaces(actor);
  const targetWorkspace = userWorkspaces.find(ws => ws.id === app.workspaceId);

  if (!targetWorkspace) {
    return (
      <div className="flex h-screen w-full items-center justify-center p-4">
        <div className="w-full max-w-sm rounded-[var(--radius-lg)] bg-[var(--surface-sunken)] p-6 text-center ring-1 ring-[var(--line-subtle)]">
          <p className="text-[var(--danger)]">{t("noWorkspaceAccess", { workspaceId: app.workspaceId })}</p>
        </div>
      </div>
    );
  }

  const requestedScopes = scopeString.split(" ").filter(Boolean);
  const displayScopes = requestedScopes.length > 0 ? requestedScopes : app.scopes;
  const deniedRedirectUrl = new URL(redirectUri);
  deniedRedirectUrl.searchParams.set("error", "access_denied");
  if (state) {
    deniedRedirectUrl.searchParams.set("state", state);
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] p-4 sm:p-8">
      <div className="absolute right-4 top-4">
      </div>

      <div className="w-full max-w-[440px]">
        <div className="mb-8 flex flex-col items-center justify-center gap-4 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--surface-strong)] ring-1 ring-[var(--line-subtle)]">
            <span className="text-2xl font-bold">GPT</span>
          </div>
          <div className="text-[var(--text-muted)]">{t("connectingTo")}</div>
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--surface-strong)] ring-1 ring-[var(--line-subtle)]">
            <span className="text-xl font-bold text-[var(--danger)]">Corgtex</span>
          </div>
        </div>

        <div className="ui-card overflow-hidden">
          <div className="border-b border-[var(--line-subtle)] bg-[var(--surface-sunken)] px-6 py-5">
            <h1 className="text-xl font-bold text-[var(--text-strong)]">
              {t("approveConnection")}
            </h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {t.rich("connectionPrompt", {
                appName: app.name,
                workspaceName: targetWorkspace.name,
                strong: (chunks) => <strong>{chunks}</strong>
              })}
            </p>
          </div>

          <div className="px-6 py-6 border-b border-[var(--line-subtle)]">
             <h3 className="text-sm font-medium text-[var(--text-strong)] mb-4">
              {t("allowCustomGptTo")}
            </h3>
            <ul className="space-y-3">
              {displayScopes.map((scope) => {
                const known = isKnownScope(scope) ? SCOPE_REGISTRY[scope as keyof typeof SCOPE_REGISTRY] : null;
                return (
                  <li key={scope} className="flex flex-col gap-1 items-start text-sm">
                    <span className="font-medium text-[var(--text-strong)] bg-[var(--surface-sunken)] border border-[var(--line-subtle)] px-2 py-0.5 rounded text-xs">{known?.label || scope}</span>
                    <span className="text-[var(--text-muted)]">{known?.description || t("customPermission")}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="px-6 py-6 bg-[var(--surface-sunken)]">
            <p className="text-xs text-[var(--text-muted)] mb-4 leading-relaxed">
              {t.rich("privacyWarning", {
                link: (chunks) => <Link href="https://openai.com/privacy-policy" target="_blank" className="text-[var(--danger)] hover:underline">{chunks}</Link>
              })}
            </p>

            <form action="/api/oauth/authorize" method="POST" className="flex flex-col gap-3">
              <input type="hidden" name="clientId" value={clientId} />
              <input type="hidden" name="redirectUri" value={redirectUri} />
              <input type="hidden" name="state" value={state || ""} />
              <input type="hidden" name="scopes" value={displayScopes.join(" ")} />

              <button type="submit" className="button w-full py-2.5 text-base shadow-[0_2px_10px_rgba(255,80,80,0.2)]">
                {t("allowAccess")}
              </button>

              <Link href={deniedRedirectUrl.toString()} className="block text-center w-full text-[var(--text-muted)] hover:text-[var(--text-strong)] py-2">
                  {t("cancel")}
              </Link>
            </form>
          </div>
        </div>

        <div className="mt-8 text-center text-xs text-[var(--text-muted)]">
          {t("securedBy")}
        </div>
      </div>
    </div>
  );
}
