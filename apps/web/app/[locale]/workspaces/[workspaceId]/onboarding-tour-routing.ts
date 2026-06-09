const LOCALE_SEGMENTS = new Set(["en", "es"]);

function stripLocalePrefix(pathname: string) {
  const [firstSegment, ...rest] = pathname.replace(/^\/+/, "").split("/");
  if (LOCALE_SEGMENTS.has(firstSegment)) {
    return `/${rest.join("/")}` || "/";
  }
  return pathname || "/";
}

function splitUrl(value: string) {
  const url = new URL(value, "https://corgtex.local");
  return {
    pathname: stripLocalePrefix(url.pathname),
    search: url.search,
  };
}

export function workspaceStepUrl(workspaceId: string, href: string) {
  return `/workspaces/${workspaceId}${href === "/" ? "" : href}`;
}

export function workspaceRouteMatches(currentUrl: string, expectedUrl: string) {
  const current = splitUrl(currentUrl);
  const expected = splitUrl(expectedUrl);
  return current.pathname === expected.pathname && current.search === expected.search;
}

