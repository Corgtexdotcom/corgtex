// Preparation only: no routes are attached by this module.
export const LEGACY_HOSTS = Object.freeze(["chirone.corgtex.com"]);
export const DESTINATION = "https://selfserve.corgtex.com/#";

// Explicit empty fragment prevents browser inheritance of legacy fragment secrets.
// Never transfer credentials, query strings, fragments, or source artifact IDs.
// Old IDs need an independently verified migration map before path preservation.
export function legacyHandoffResponse(request) {
  const url = new URL(request.url);
  if (!LEGACY_HOSTS.includes(url.hostname) || url.port) return null;
  const read = request.method === "GET" || request.method === "HEAD";
  if (read && ["/api/health", "/healthz"].includes(url.pathname)) return null;
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
  const path = url.pathname.replace(/^\/(en|es)(?=\/|$)/, "") || "/";
  const browser = request.headers.get("accept")?.includes("text/html");
  const entry = /^\/(?:login|signup|find-account)?\/?$/.test(path);
  const workspacePage = /^\/workspaces\/[a-f0-9-]{36}(?:\/(?:actions|tensions|proposals|goals|brain|meetings|circles|members|settings|operator|finance|items)(?:\/[a-zA-Z0-9_-]+)*)?\/?$/.test(path);
  if (read && browser && (entry || workspacePage)) {
    return new Response(null, { status: 302, headers: { ...headers, Location: DESTINATION } });
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify({
    error: "source_frozen", applicationWrites: false,
  }), { status: 503, headers: { ...headers, "Content-Type": "application/json", "Retry-After": "3600" } });
}

export default {
  async fetch(request) {
    return legacyHandoffResponse(request) ?? fetch(request);
  },
};
