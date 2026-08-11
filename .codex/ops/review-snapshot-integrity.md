# Review Snapshot Integrity

Purpose: bind every `beepto-codex` approval to the exact PR snapshot it
reviewed (head SHA, base SHA, UTF-8 PR body bytes, canonical label set) so a
stale approval can never merge mutated content.

## Components

- `scripts/review-snapshot-integrity.mjs` — offline-testable evaluator and
  publisher. Pure functions compute the snapshot, parse the attestation, and
  decide pass/fail; `publishPullRequestStatus` publishes the commit status.
- `.github/workflows/review-snapshot-integrity-pr.yml` — shadow-mode trusted
  `pull_request_target` workflow on `main` (opened, reopened, synchronize,
  edited, labeled, unlabeled, ready_for_review, converted_to_draft only). It
  publishes the explicit commit status context `Review Snapshot Integrity` on
  the immutable event PR head SHA: `pending` before evaluation, `success`
  only after a complete pass with an unchanged post-write refetch, `failure`
  on every other path. Each write is confirmed by exact returned status ID,
  state, context, and the `github-actions[bot]` creator; workflow/job names are
  deliberately distinct from the explicit context. The job has job-local `contents: read`,
  `pull-requests: write`, `statuses: write` only, uses the ephemeral
  `GITHUB_TOKEN`, checks out only the trusted base SHA without persisted
  credentials, installs nothing, and never checks out, interpolates, or
  executes PR-controlled content. PR metadata is read only through the API.
- `.github/workflows/review-snapshot-integrity-merge-group.yml` — shadow-mode
  `merge_group` `checks_requested` workflow for `main`. GitHub attaches its
  native job/check name `Review Snapshot Integrity` to the immutable synthetic
  merge-group SHA. The distinct workflow name avoids a source/name collision
  with the explicit PR-head commit status. Its job has only `contents: read`
  and `pull-requests: read`; it has no status, check, PR, or other write scope.
  It checks out only the trusted merge-group base SHA, installs nothing, and
  evaluates PR content only as API metadata.
- The status is **shadow-only**: it is not a required context and no ruleset,
  queue, Actions default, or repository setting references it.

## Attestation protocol (reviewer)

1. Complete the full `.codex/review.md` checklist against freshly pulled PR
   state: head SHA, base SHA, full PR body, labels, checks, and review
   threads must all be rechecked at approval time.
2. Generate the attestation payload with the exact trusted-worktree pipeline
   in `.codex/review.md`. Never execute the reviewed PR's script with reviewer
   credentials; only `gh` receives the credential, while the trusted
   `origin/main` evaluator receives public PR JSON on stdin.
3. Submit the approval as `beepto-codex` with exactly one attestation block in
   the body:

   ````
   ```review-snapshot-attestation
   {"v":"rsi/v1","pr":<n>,"headSha":"...","baseSha":"...","bodyDigest":"...","labelDigest":"..."}
   ```
   ````

4. **Post-approval rerun:** rerun the exact publisher workflow run for the
   current head (`gh run rerun <run-id>` or re-trigger the event) so the
   publisher observes the new approval and flips the status to `success`. A
   same-head rerun recomputes all live metadata; a stale-head run can only
   write to its immutable event head SHA and can never affect a newer head.

## Invalidation

Any same-SHA drift (body, base, labels, draft/readiness) or head
synchronization invalidates the approval: the attestation no longer matches
the live snapshot, the publisher emits `failure`, and, only after confirming
that the event head and evaluated snapshot are still current, dismisses stale
`beepto-codex` approvals, disables auto-merge, and dequeues the PR when
applicable. Stale-head runs perform no PR mutation. Title-only edits recompute
but do not change attested state. An approval and a snapshot mutation at the
identical timestamp are ambiguous and fail closed.

`pull_request_review` is intentionally not a write-capable trigger: GitHub
runs that workflow from the PR merge commit, so granting it writes would cross
the untrusted-code boundary. Native required-review protection remains the
authoritative immediate gate for dismissed or superseded reviews; reviewers
must rerun the trusted publisher after any review-state change. Likewise, a
main-branch advance is immediately guarded by strict branch protection and is
re-evaluated on the merge-group SHA by the separate read-only native check.
Because the PR-head status is shadow-only until both halves and this behavior
are observed, a stale shadow status cannot authorize a merge and blocks Gate B
activation if the complementary native or merge-group gate is absent.

## Shadow evidence and stop boundaries

- Evidence: the public `Review Snapshot Integrity` status history on PR head
  commits and native checks on synthetic merge-group SHAs, plus job summaries
  containing only PR numbers, digests, and pass/fail counts.
- Stop boundaries: never make the context required, never add `checks: write`
  or any other permission, never check out or execute PR code in the
  privileged job, never add installs/caches/artifacts.
- Canceling concurrency always has a successor run, but a canceled run can
  briefly leave `pending`. Any orphaned `pending` or successor that cannot
  publish a final state is a fail-stuck shadow signal and blocks activation;
  rerun it while shadow-only. If observed after activation, remove the
  required context first as described below.
- Merge-group membership is resolved by traversing the event's immutable
  synthetic two-parent merge-commit chain back to its exact base SHA, then
  matching each second-parent PR head to one unique, increasing-position entry
  in the ordered `main` merge queue. Each queue entry's PR head and live PR
  head/base SHAs must still match those immutable inputs.
  Empty, duplicate, non-open, malformed, ambiguous, disconnected, or paginated
  queues (more than 100 entries) fail closed. Before success, one concurrent
  final wave rechecks membership plus every included PR's complete files and
  reviews with bounded API retries and timeouts, followed by one batched
  GraphQL watermark read of every PR's `updatedAt` and head/base SHAs. A later
  body/label mutation is independently caught by the PR-head publisher, which
  fails the status and dequeues the stale approved snapshot.
- The merge-group workflow cannot validate the merge group for the PR that
  first adds it because GitHub loads this event workflow from the default
  branch. Its first real shadow evidence is therefore the next merge group
  after this PR lands. Missing or partial evidence blocks activation.
- Activation is a separately approved gate after both PRs merge and bounded
  shadow evidence passes: first add the exact context plus GitHub Actions
  source, verify queue behavior, and only then apply separately approved queue
  maxima. If activation wedges, remove the required context first, verify the
  queue recovers, and only then revert code by normal protected PR. Before
  activation, rollback is only that protected revert PR. Historical statuses
  remain public audit evidence.
