# Ops Target Metadata Qualification

The existing protected Azure PostgreSQL rehearsal workflow also supports
`qualify-target` with domain `ops`. This is not `rehearse`: it reads only the
existing target's PostgreSQL metadata, without Railway source secrets, dumps,
scratch databases, migrations or extension installation. Main, the existing
environment approval and shared non-cancelling concurrency gate remain required.

The target password stays in the existing protected environment secret and is
passed only to the preparation/probe steps. Missing credentials fail before
START. Do not extract that secret or run the full restore as a substitute.

Preparation checks the exact account/principal roles, non-authoritative resource
group, server identity/configuration, stopped state, absent firewall rules and
private endpoint connections. It persists and uploads a typed intent before any
provider effect. Its absolute deadline is one hour from preparation, with the
final fifteen minutes reserved for cleanup. START/readiness, a run-owned single
IPv4 rule, bounded connection-readiness checks and one metadata capture are the
only qualification actions. Readiness follows the existing firewall-propagation
pattern: up to five minutes of transient connection retries, each closed, using
the same verified TLS, credentials and startup read-only settings. Its sole query
checks that posture. Authentication/certificate/guard failures do not fall back.
Then one connection captures metadata; catalog capture is never retried.
Readiness and capture (including bounded disconnect) are capped by the remaining
work deadline. Readiness exhaustion means UNPROVEN, not platform incompatibility.
The probe never alters the database.

`always()` cleanup removes only the intent's rule, returns the originally stopped
server to Stopped and verifies both readbacks. A failed metadata query is not a
reason to leave compute running. Ambiguous CLI responses are reconciled by reads,
not repeated mutations. START submits with --no-wait and bounded Ready polling;
the CLI submission timeout is not a one-minute startup limit. STOP requests
terminal CLI completion with readback reconciliation after a lost response. An
ambiguous START followed by Stopped is not cleanup proof. Cleanup waits for Ready,
then issues STOP once and verifies Stopped. If Ready cannot be observed within
the remaining window, it reports unresolved rather than successful cleanup.
Unexpected target identity or foreign access fails closed.
Firewall CREATE is also submitted once. A failed/timed-out create response is
not proof that Azure rejected it: readback must establish the exact intent-owned
rule with identical start/end IPv4 (one /32), followed by a fresh provider Ready
read before the database probe. An earlier Ready read cannot establish readiness
after rule creation starts Updating. Missing rule or prolonged Updating
exhausts the original work deadline as `FIREWALL_CREATE_UNPROVEN`; it never
triggers a second CREATE or a broader rule. Identity, role, boundary and rule
ownership drift still fail closed during reconciliation.
The same unproven code covers an Azure operation-deadline rejection or a failed
Azure read that exhausts the work deadline during this reconciliation. A read
failure before that deadline retains its specific Azure error; identity or
ownership validation failures are never relabeled as deadline exhaustion.

Cleanup accepts Updating only within the verified owned execution. It waits for
the transition to settle before deleting the owned rule, and again before STOP
if deletion leaves the server Updating. Every wait shares the original cleanup
deadline (or the existing bounded recovery reserve), rather than resetting a
timeout per poll or phase. Rules and target/identity boundaries are rechecked
while waiting. Prepare and initial START still require Stopped; Updating is not
permission to adopt someone else's server operation. The ambiguous-START Stopped
guard and exact recovery provenance requirements are unchanged. Expiry is an
unresolved failure, not proof that access or compute was removed.
If a late cleanup rule read reveals the accepted CREATE while Azure enters
Updating, cleanup obtains another owned-rule read followed by a fresh settled
state before its sole DELETE attempt. It uses that paired readback without
another intervening rule read. Every settled pre-STOP read, including readiness
after Starting, handles an owned rule first observed there before proceeding to
STOP. Earlier observed ownership is retained across an absent read, and DELETE
is attempted at most once, followed by settled-state reconciliation.
Polling reads that exhaust the cleanup deadline
report `ABSOLUTE_DEADLINE_EXCEEDED`, including Azure operation-deadline and
operation-failure errors. Earlier read failures and semantic identity, role,
ownership or target-drift errors retain their original codes.
After the same execution-ownership checks, recovery observing Stopping waits
directly for Stopped without submitting another STOP. A bare stale intent never
supplies that observation: Stopping seen earlier in the same owned cleanup call
remains valid if the next read is already Stopped, even without a polling sleep.
An intent alone never
authorizes this path; an initial Stopped after ambiguous START remains unresolved.
Late cleanup may still recover the resource but explicitly fails the original
one-hour window. An Azure operation or lost runner can prevent timely cleanup:
the supervising operator must retain the absolute deadline independently. A job
timeout is not a guarantee that Azure stopped compute.

For interruption recovery, use the same workflow's `recover` operation with
`recovery_kind=target-qualification`, domain `ops` and the exact original run ID
and attempt. It downloads the original execution receipts, not the prepare-only
intent artifact, and performs no scratch database deletion. Before Azure calls,
existing read-only GitHub activity must prove the exact completed original run
attempt, attempted qualification step, unsuccessful cleanup, and no intervening
workflow run. The original START marker is required; a cleanup receipt or native
successful cleanup rejects recovery even if the target has since become Ready.
Superseded attempts, incomplete activity results and missing execution receipts
fail closed. A second recovery run is not automatically authorized by the old
intent. Lost receipts or a never-observed START transition require separately
reviewed operator reconciliation; they must not be worked around with an intent.
Default `recovery_kind=restore` preserves the existing restore
recovery path. Qualification recovery needs no PostgreSQL password, Node package
installation or database connection. Both paths share workflow concurrency.

Private artifacts separate the intent, START-attempt marker, metadata and cleanup
receipts. No credential, raw exception or Azure token is logged.
Standalone --execute receipts also reside under ignored .artifacts/target-qualification,
never beside source scripts. All receipt files are exclusive-create mode 0600.
Metadata capture is not production compatibility/capacity acceptance, and cleanup success
is not proof of a bill. The per-run intent records a USD5 transition cap; the
operator owns actual spend accounting and the separately approved cumulative
allowance. No monthly hosting budget is enlarged by this operation.

Before dispatch, independently review the complete workflow/probe/lifecycle diff,
verify the current target and protected identity, confirm the applicable spend
reservation and assign an operator to monitor cleanup. Do not start another run
while any earlier lifecycle remains unresolved.
