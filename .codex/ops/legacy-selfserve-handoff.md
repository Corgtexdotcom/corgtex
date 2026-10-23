# Legacy customer handoff preparation (PUN-103)

All customers belong on shared `https://selfserve.corgtex.com`. No dedicated
customer application is a restoration target. This change prepares an edge
handler; it does not attach routes, deploy, alter DNS, or restart a frozen source.

## Verified inventory and access gap

Only `chirone.corgtex.com` is enabled in this handler's exact allowlist. PUN-103
records the October 21 customer screenshot and the same public maintenance
response was independently observed October 23. Other customer hosts require
fresh authoritative inventory before allowlist expansion; no wildcard route.

Existing September 30–October 1 private acceptance evidence identifies the
Chirone selfserve workspace and scoped Corgtex Admin OAuth/MCP access. It does
not prove Ed Harrison's current membership or browser login. Current connector
reads fail with an internal error and local Chrome inspection times out. Public
health alone must not close the customer access issue.

## Prepared behavior

`deploy/legacy-handoff/worker.mjs` exports a Fetch-compatible edge handler:

- GET/HEAD browser navigation with `Accept: text/html` to known entry pages or
  recognized workspace UI paths returns temporary 302 to fixed selfserve root.
- Locale is not preserved. Deep links intentionally go to root: source object IDs
  and tenant selection need an independently verified migration map before path
  preservation. Normal selfserve authentication/membership chooses the workspace.
- Queries are discarded and an explicit empty fragment prevents browser fragment
  inheritance. No arbitrary `next`, `returnTo`, host, path or query is forwarded.
- All write methods, API/MCP/OAuth/callback/webhook routes, nonbrowser reads and
  unknown paths return 503 JSON with applicationWrites false and Retry-After.
- Exact GET/HEAD `/api/health` and `/healthz` pass through to existing origin health.
  Unowned hosts pass through. There is no database, auth or source application code.
- Responses are not cached; Referrer-Policy is no-referrer. The 302 is reversible.

## Approval and execution boundary

Before any provider mutation, the infrastructure/release owner must verify the
current DNS/CDN ownership, TLS, origin freeze identity, healthcheck paths and
existing callback/webhook inventories. If this host is already proxied by a
Fetch-compatible edge provider, the proposed production change is to deploy the
reviewed handler and attach **only** `chirone.corgtex.com/*`. No route is attached
by this PR. If the host is not already proxied, stop and prepare that provider's
specific routing plan; this module is not permission to introduce a new provider
or change DNS. Keep frozen original start commands and stopped writers unchanged.

Under separate production approval, first verify Ed's active selfserve membership
with the existing audited read path and browser login as the actual user. Do not
create credentials, invite users, or impersonate Ed as a diagnostic shortcut.
Then execute the reviewed edge routing change through the normal release owner.
Verify root and known UI GET/HEAD handoff, stripped query/fragment, 503 on POST,
OAuth, MCP and webhooks, unchanged source health/freeze proof, and authenticated
Chirone workspace access. Do not claim success from redirect or public health alone.
Rollback removes only the new edge route, restoring the existing frozen origin.

Next accountable action: Puncar should name the support/release owner for PUN-103
and obtain current Ed membership/login evidence on selfserve. PUN-103 is urgent,
unassigned Backlog with no follow-up comments as of this investigation.
