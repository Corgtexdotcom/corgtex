# Governed workspace MCP configuration

Critical scope: runtime authorization activation and worker ordering. This workflow
does not connect a client, issue credentials, change consent/membership, deploy new
source, read customer/queue rows, or prove native-client acceptance.

## Authority and exact inputs

Use **Workspace MCP Configuration** (`workspace-mcp-config.yml`) from protected
`main`. It shares `fleet-release`, `cancel-in-progress: false`, the existing
`fleet-release-production` environment and fleet Azure OIDC identity. No new role,
secret, managed-target lease, registry import, build or resource is needed.
The lock serializes participating GitHub workflows only. The owner must obtain an
exclusive handoff from direct provider writers and acknowledge responsibility for
existing pending canonical work and recovery before dispatch. A quiet CI tab is
not exclusion. Protected review remains independent; do not self-approve.

Provide `operation` (`preflight`, `activate`, `disable-ingress`), full accepted SHA,
immutable ACR `corgtex/web@sha256:...` and `corgtex/worker@sha256:...` index references,
exact expected current web and worker revision names, and `exclusive_writer_ack`.
No latest/tag input or assumed current revision. The existing baseline may use an
exact `sha-<acceptedSHA>` reference only if fresh ACR resolution equals the supplied
immutable digest. Every new revision is digest-pinned. This changes reference
spelling, not accepted artifact identity. ACR resolution does not expose the old
container's pulled digest; baked runtime identity is separately verified.

The selected SHA must be an ancestor of workflow source and unchanged across the
runner's explicit worker/domain/shared/workflows/MCP/OAuth/deploy/migration
compatibility paths. A difference blocks for review, not an implicit compatibility
waiver. Main/CI green is not accepted-serving proof. This is a same-code revision
change; normal image startup still occurs, not a migration bypass or queue pause.

## Execution and evidence

`preflight` performs reads only. Activation requires both flags absent/false.
The runner verifies the fixed Azure subscription/tenant and existing service
principal, fixed app identities, Single revision mode, exact baseline revisions,
ACR digest, config hashes, actual materialized revision templates, each ready
replica's baked role/SHA, process environment flag and loopback health. Public web
health must have baked runtime SHA, no configured drift, ready database/schema.
Worker health must be running without error and have a recent successful tick.
All other retained web/worker revisions must be inactive, Stopped and zero replicas;
unknown counts or stopped traffic alone do not qualify. No old revision is stopped
automatically by this runner.

App-to-revision comparison normalizes only provider representation differences:
empty secret-reference values, default container image type, null metrics settings,
default scaling intervals and CPU-derived Consumption ephemeral storage. The full
app preservation hash remains unchanged and strict before/after writes. Unknown
fields, changed secret references and nondefault values still fail comparison.
Defaults: [scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app)
and [ephemeral storage](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts).

Activation sets only the compatible worker flag first. It waits for the exact
run-bound revision, rechecks unchanged configuration/replica health and old-worker
stop proof, then refreshes both roles immediately before enabling web. After web
acceptance, worker proof runs again. New flag-on workers may process already queued
eligible canonical work even while web is off. This operation neither inspects nor
clears that work, and cannot retract external effects or fence an old binary that
ignores the flag. A failing post-write check is a recovery handoff, not success.

Unauthenticated acceptance uses only the fixed internal validation resource:
canonical metadata names its exact URL; unauthenticated canonical GET returns the
expected 401/resource-metadata challenge when enabled, and endpoint AND metadata
return the specific disabled 503 when off. Legacy `/mcp` and `/api/mcp` discovery
must remain intact. This is not authenticated tool execution, existing-token or
native two-workspace acceptance; those remain separately authorized checks.

Receipts are uploaded even after failure, bound to run/attempt/workflow/accepted
SHA. Only bounded stages, revisions, hashes and proof summaries are retained.
Raw env, secret values, provider errors and health error text are not published.
Runtime probes select exact revision AND replica AND container via existing Azure
exec authority; a missing permission/transport response stops without a workaround.
The runner is bounded to 22 minutes (job 30); it never cancels a competing release.

## Uncertain writes and safe ingress disable

Before each single update submission the receipt records the intended revision:
`ca-corgtex-ss-prod-<role>--mcp-<runId>-1-<role>`, exact digest, baseline and flag.
Timeout/failed response stops without resubmission or automatic rollback. Do not
rerun jobs; attempts above one are rejected. The runner first attempts a bounded
read-only observation of each intended revision,
latest/ready state and stop inventory. This does not prove operation termination
and never permits retry; failed observation is explicitly retained as unavailable.
Under the retained operator handoff, reconcile that exact revision using
`az containerapp revision show`, app latest/ready
state, revision/replica inventories and fresh runtime proof. Compare with the
retained intent and config hash, including unexpected old-worker reactivation.
Absence at one instant is not proof a timed-out request cannot still finish.
Wait for a terminal provider operation or escalate; never dispatch a duplicate
write just because a receipt is missing. A later read-only preflight must name the
reconciled actual baselines. It does not resume an incomplete activation.

For recovery, `disable-ingress` sets ONLY web false using the same accepted digest,
then proves disabled canonical ingress and all old web revisions stopped. It does
not require a healthy worker to stop ingress, but still binds the declared worker
baseline/image. Worker readiness is rechecked and explicitly marked unproven when
unhealthy. Already-off ingress is verified without another write. Success is
`INGRESS_DISABLED_WORKER_RECOVERY_HANDOFF`, not complete rollback or resolved work.

Keep compatible workers while the authorized owner resolves/drains in-flight and
pending canonical work. Do not turn workers off or roll binaries back on unresolved
work: flag-off workers deny canonical execution through normal retry/failure logic;
this is NOT a resumable pause. No worker rollback, token issuance/revocation, queue
purge, role grant, source auto-revert or unguarded recovery command is provided.
If exact ingress-stop proof fails, retain the incident/writer handoff; do not claim
ingress is fenced. Native client consent and independent disconnect remain in the
workspace MCP connection runbook.

Provider primitives: [Azure CLI Container Apps](https://learn.microsoft.com/en-us/cli/azure/containerapp)
and [environment variable revision semantics](https://learn.microsoft.com/en-us/azure/container-apps/environment-variables).
