# Legacy customer handoff preparation (PUN-103)

All customers belong on shared `https://selfserve.corgtex.com`. No dedicated
customer application is a restoration target. This PR prepares an offline Azure
Container Apps command override for the existing frozen Chirone web container.
It does not deploy, create resources, modify DNS/TLS/ingress, or restart writers.

## Architecture and current evidence limit

October 23 public DNS points `chirone.corgtex.com` directly to
`ca-corgtex-chirone-prod-web.icyglacier-a00c427b.westus3.azurecontainerapps.io`.
Use the existing web Container App, its immutable image and existing ingress;
no new edge provider is needed. Public maintenance still reports
`source-freeze-utility` and `applicationWrites:false`. Public GET `/api/health` and
`/healthz` both returned 200 with exactly `status:ok`, `mode:source-freeze-utility`
and `applicationWrites:false`. This verifies the public health body, not the
configured Azure probes or image command.

The repository's `scripts/release/core-retirement.mjs` already serializes a
built-in Node HTTP server into an inert command override. `deploy/Dockerfile.web`
uses Node 22 and normally starts `deploy/entrypoint.sh`; the new command bypasses
that application/migration entrypoint entirely. The existing Azure transport in
`scripts/release/managed-azure-container-app-transport.mjs` can read templates and
PATCH them. Its normal release builder changes images/release identity and is
**not** the approved executor for this same-image command-only operation.

Live Azure configuration is unverified. The local Azure CLI could not initialize:
the sandbox denied its session-cache write at `~/.azure/az.sess`. That access path
was stopped without an identity switch. Missing evidence includes current
subscription/resource group and resource ID, revision/traffic state, full template
and command hash, immutable image/startup proof, actual configured probes/port, and revision-correlated
health evidence. Public DNS or the older Railway Core receipt cannot fill those gaps.

## Usable offline preparation

`deploy/legacy-handoff/azure-utility.mjs` reuses the redirect decision from
`worker.mjs` and serializes a standalone Node HTTP utility. `prepareAzureHandoff`
requires a fresh (at most one hour) reviewed baseline, exact template and original
command SHA-256 digests, one explicitly configured container with no init containers, an immutable image,
the exact Chirone web resource ID, and reviewed frozen-web health/probe evidence.
Unknown topology, stale evidence, mutable images, worker targets and health with
application writes are refused. Hashes bind evidence; they do not authorize a deploy.

After obtaining that evidence through the existing authorized identity, prepare:

```sh
node scripts/prepare-legacy-azure-handoff.mjs \
  /private/path/reviewed-azure-handoff-input.json \
  .artifacts/legacy-handoff/azure-command-plan.json
```

The input has `resourceId`, `observedAt`, `hostname`, `baseline` (the current
`properties.template`), `expectedTemplateSha256`, `expectedCommandSha256`, `health`,
and `healthPaths`. Digests use the exported canonical `digest()` function;
command digest covers `{command, args}` from the current sole container. A reviewer
must independently inspect the original command as an inert source utility and
bind its hash; the generator does not infer that from a marker string. Health may
contain only status, mode, applicationWrites, businessWorker, role and proofSha256.
Only proven `/api/health` and/or `/healthz` paths may be supplied.
Every retained HTTP probe must explicitly target one of those supplied paths;
omitted paths, root probes and unreviewed paths block preparation. Probes are never
rewritten. Freshness uses the process clock; input fields cannot override it.

The CLI creates a new mode-0600 artifact with only command/args delta and hashes;
it never prints or copies baseline environment values. It does not overwrite an
existing artifact and makes no network calls. The programmatic API builds the
complete candidate in memory for comparison: only `containers[0].command` and
`containers[0].args` change. Keep full private templates out of Git and logs.

The proposed command is `/usr/bin/env -u NODE_OPTIONS -u NODE_PATH /usr/local/bin/node`
with `-e` and the self-contained program as separate Azure argument-array elements.
There is no shell, file deployment, npm startup, Prisma, DB client, queue, model,
OAuth, customer data access or outbound fetch. Verify `/usr/bin/env`, Node 22,
`/usr/local/bin/node` and the actual probe PORT in the retained image before approval.

## HTTP behavior

- GET/HEAD browser requests (`Accept: text/html`) for recognized entry or workspace
  UI paths receive temporary 302 to fixed `https://selfserve.corgtex.com/#`.
- Drop locale, queries and source IDs. Explicit empty fragment prevents browser
  inheritance. No `next`, token, callback code, tenant choice or deep-link ID is
  forwarded. Path preservation requires a separately verified migration map.
- API, MCP, OAuth, callback, webhook, nonbrowser, unknown paths and all writes
  return 503 JSON with applicationWrites false and Retry-After. Unknown Host values
  and absolute-form targets fail closed. Proxy host headers are not trusted.
- GET/HEAD only on reviewed health paths reproduce the supplied existing frozen
  health contract, including its original proof marker. Unreviewed health paths and
  health POSTs stay frozen. Responses are no-store; redirects suppress referrers.

## Exact deployment boundary: pending separate approval

The release owner must first establish current source freeze, Ed's target access,
actual resource binding, same-image executable proof and exclusive release ownership.
No business release, source thaw, source migration, SQL change or generic fleet
promotion is part of this handoff.

A separately reviewed Azure command-only operation would reread and compare the
exact resource/template/configuration/command hashes, then PATCH only this existing
web app's template using the in-memory candidate. Preserve its image, env/secrets,
identity, resources, probes, scale, ingress/custom domains, TLS and worker unchanged.
The reviewed operation must account for actual revisionSuffix/revision-mode rules:
this preparer preserves the suffix, so a nonempty suffix which Azure requires to
change blocks application until that additional revision delta is explicitly reviewed.
Do not silently extend the two-field delta or use the ordinary image-release builder.
A new utility revision and provider-managed traffic transition are production writes
requiring their own exact manifest and approval; this PR supplies no dispatch path.

Before accepting the new revision, compare provider-readback command/args and complete
candidate template with the approved candidate/source hashes. The copied old health
proof marker proves only contract continuity; it cannot identify the new program.
Validate the new revision through existing ingress with source writes still disabled,
unchanged health/proof and exactly one intended serving utility. Check root/known UI,
query/fragment stripping, POST/API/MCP/callback/webhook 503s and actual selfserve access.
Rollback restores only the previously verified **frozen** utility command/revision;
never the old application entrypoint. Retain and inspect ambiguous outcomes before retry.

Only Chirone is enabled. Other historical customer hosts require independent target
access, freeze, probe and revision evidence before reusing this preparation. Alumipres
also returned NXDOMAIN through the checked resolver and needs separate DNS disposition.
Auth/MCP/Ops/marketing hosts are excluded.

## Customer access remains unverified

September 30–October 1 evidence proves scoped Corgtex Admin OAuth/MCP access to the
Chirone selfserve tenant, not Ed Harrison's current membership/login. Current Chirone
connector reads return internal errors and local browser inspection times out.
Do not create credentials, impersonate Ed or claim restoration from public health.
Puncar should assign a PUN-103 support/release owner for current target access and
provider evidence before any execution approval.
