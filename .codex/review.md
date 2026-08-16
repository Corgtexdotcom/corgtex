# Corgtex review policy

Review the complete pull request at its current head and base. The reviewer is an
independent read-only identity: `beepto-codex`. Do not edit, fix, push, resolve
builder-owned threads, merge, or approve your own work.

## Review sequence

1. Read `AGENTS.md`, the PR contract, the complete diff, changed tests, labels,
   unresolved threads, and required checks.
2. Trace each acceptance criterion to code and evidence.
3. Review realistic trust boundaries first: auth, authorization, tenant isolation,
   secrets, data integrity, migrations, external effects, and rollback.
4. Confirm the exact head/base and live required checks immediately before review.
5. Submit one clear approval or one request-changes review containing all blockers.

## Request changes only for objective blockers

- The PR lacks a public-safe outcome, valid risk tier, file allowlist, acceptance
  checklist, test plan, or rollback statement.
- A changed file is outside the declared scope, or the PR mixes unrelated tasks.
- A protected path is changed without `critical` risk and a concrete justification.
- An acceptance criterion is unticked or not actually implemented.
- Required tests are missing or failing. Domain source changes require same-package
  `*.test.ts` coverage.
- A frontend path changed without proof from the running application.
- The diff exposes secrets/private data, adds an environment file, adds executable
  use of `prisma db push` or `--no-verify`, or removes a required
  `force-dynamic` boundary.
- The diff contains an objective correctness, security, privacy, data-integrity,
  migration, performance, or rollback defect with a plausible production path.
- Required CI is red, conversations are unresolved, mergeability is unknown, or the
  live head/base changed after review began.
- `halt-agents` or `needs-replan` is present.

Do not request changes for diff size alone, wording, taste, speculative architecture,
minor style, or defenses against conditions that trusted runtime code cannot create.
Leave those as optional advice only when it materially helps.

## Approval

Approve only the exact current head when every objective blocker is clear and native
GitHub protection reports the required checks and conversation state satisfied. Any
later push or base change invalidates the approval and requires a fresh review.

Native branch/ruleset controls are the target enforcement boundary. During the
staged transition, reviewer policy also requires Review Snapshot Integrity even
though it is not a native required context. Follow the one canonical procedure in
[`ops/review-snapshot-integrity.md`](ops/review-snapshot-integrity.md), include its
exact-head attestation in the approval, and rerun the publisher for the same head.
Remove that temporary protocol only after `PR Policy` and `PR Metadata Policy` are
live, required, and proven on both pull-request and merge-group SHAs.

## Special cases

- `auto-revert`: verify it cleanly reverts the named commit, contains no extra
  change or secret, and required checks pass; then review promptly.
- `force-merge`: act only on an explicit human directive for that PR. The public
  comment trail must record the bypass. It never permits secrets, `db push`, or
  `--no-verify`.

Review comments should name the failure, its impact, the smallest safe correction,
and the relevant file/line. Group related blockers in one review.
