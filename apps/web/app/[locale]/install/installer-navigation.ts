import { buildInstallerPath } from "@/lib/install-helpers";

type SearchValue = string | string[] | undefined;

export function firstInstallerParam(value: SearchValue) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function installerReturnTo(value: SearchValue, workspaceId: string, locale: string) {
  const candidate = firstInstallerParam(value);
  if (!candidate?.startsWith("/") || candidate.startsWith("//")) return null;

  let url: URL;
  try {
    url = new URL(candidate, "https://corgtex.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://corgtex.invalid" || url.hash) return null;

  const match = /^\/(?:en\/|es\/)?workspaces\/([^/]+)(\/settings)?$/.exec(url.pathname);
  if (!match || match[1] !== workspaceId) return null;
  if (!match[2]) {
    return url.searchParams.size === 1 && url.searchParams.get("onboarding") === "setup"
      ? `/${locale}/workspaces/${workspaceId}?onboarding=setup`
      : null;
  }
  if (url.searchParams.getAll("tab").length !== 1 || url.searchParams.get("tab") !== "ai-workspaces") return null;
  if ([...url.searchParams.keys()].some((key) => key !== "tab" && key !== "provider")) return null;

  const providers = url.searchParams.getAll("provider");
  if (providers.length > 1 || (providers.length === 1 && !/^[a-z0-9_-]+$/.test(providers[0]))) return null;

  const params = new URLSearchParams({ tab: "ai-workspaces" });
  if (providers.length === 1) params.set("provider", providers[0]);
  return `/${locale}/workspaces/${workspaceId}/settings?${params.toString()}`;
}

export function installerDirectoryHref(locale: string, workspaceId: string, returnTo?: string | null) {
  return `/${locale}${buildInstallerPath(null, { workspaceId, returnTo })}`;
}

export function installerTileHref(locale: string, providerKey: string, workspaceId: string, returnTo?: string | null) {
  return `/${locale}${buildInstallerPath(providerKey, { workspaceId, returnTo })}`;
}
