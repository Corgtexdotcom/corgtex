# GitHub incident synchronization recovery

The token-backed publisher retries only GET requests: at most three attempts,
250/500 ms backoff for transport/408/5xx failures, and a ten-second deadline
covering each request and its response body. A client has a two-minute total
budget. Rate-limit retries respect both Retry-After and the primary reset time;
secondary limits without timing headers wait at least one minute. If the required
wait cannot fit, synchronization fails visibly instead of retrying earlier.
401 and permission-denied 403 responses fail immediately. Partial API credentials
do not fall back to a different identity. The existing local gh path is unchanged.

Every mutation is sent once. A transport failure, timeout, server error or malformed
successful response can mean that GitHub applied the mutation. Issue/comment
creation includes a fresh operation marker. Read-only reconciliation requires the
exact marked content from a complete bounded paginated listing, including closed
issues; label and issue PATCH reconciliation require the intended state on the
exact target. A negative, ambiguous, incomplete or failed read leaves the outcome
unknown and the process exits nonzero. A rate-limited mutation is deferred without
immediate readback or resend, respecting the server's request pause. No readback
authorizes another write.

This is same-invocation recovery, not cross-cron exactly-once delivery. A later
scheduled health observation is a new operation with a new marker. Durable
suppression/replay of the same observation across process crashes would require
persistent operation authority and is outside this change. Do not replay an
uncertain operation manually as if a negative read proved it never happened.

Health-sweep emits its health JSON after the publisher completes, ahead of any
captured issue URLs. `plannedIncidents` describes the intended publication count;
`publishedIncidents` is confirmed only after complete synchronization, or null on
partial/unknown failure. `githubSync` reports complete/degraded/disabled/dry-run,
with child exit/signal information. Healthy targets remain healthy when GitHub
synchronization fails, but the monitor operation still exits nonzero. The token
publisher separately emits sanitized JSON status, retries and reconciled-write
counts on stderr; response bodies, tokens and network error details are excluded.

Run the deterministic fixtures without real credentials or provider calls:

```sh
npx vitest run --project unit scripts/ops/github-api.test.mjs scripts/ops/github-incident.test.mjs
```

The required native CI job runs these tests and the production-boundary workflow
contract for pull requests and merge groups.
No deployment, scheduler change or seven-day production recovery is implied by
these tests. GitHub issue #1570 and PUN-43 remain open until separately verified.
