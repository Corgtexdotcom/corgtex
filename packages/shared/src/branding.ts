export const PLATFORM_NAME = "Corgtex";
export const PLATFORM_TAGLINE = "AI-native workspace operating system";

/**
 * Returns branding info for a given workspace.
 * - Client workspaces: company name is primary (big), "powered by Corgtex" is secondary (small)
 * - Demo workspace: "Corgtex" is primary (big), "J&J Demo" is secondary (small)
 */
export function workspaceBranding(workspace: { slug: string; name: string }) {
  const isDemo = workspace.slug === "jnj-demo";
  const isInternal = workspace.slug === "corgtex";
  return {
    primaryName: isDemo || isInternal ? PLATFORM_NAME : workspace.name,
    secondaryLabel: isDemo
      ? "J&J Demo"
      : isInternal
        ? "Internal"
        : `powered by ${PLATFORM_NAME}`,
    pageTitle: isDemo
      ? `${PLATFORM_NAME} · J&J Demo`
      : isInternal
        ? `${PLATFORM_NAME} · Internal`
        : workspace.name,
    isDemo,
    isInternal,
  };
}
