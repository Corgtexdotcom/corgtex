# GitHub protection

Use native protection for `main`: one independent approval, stale-approval dismissal,
latest-push approval, resolved conversations, required checks, and merge queue.
Agents cannot push directly to main, force-push, or bypass these controls.

Required checks:

- `Lint, Typecheck & Test`
- `Database Sync`
- `Build`
- `Docs Validation`
- `PR Policy`
- `PR Metadata Policy`
- `Secret Scan`
- `Client Data Scan`

The metadata workflow executes trusted base code, validates live PR metadata, and
removes invalid PRs from the queue. Its merge-group evaluator validates actual queue
membership, current heads/bases, approvals, and metadata drift. The evaluator retains
its historical filename `scripts/review-snapshot-integrity.mjs`; there is no custom
attestation or separate snapshot publisher. Valid metadata changes do not dismiss
code approvals. The independent reviewer still assesses substantive scope changes.

The evaluator uses one author-conditioned reviewer contract in its REST decision
and final GraphQL verification:

- `beepto-codex` author: independent `puncar-dev` approval.
- Any other author: independent `beepto-codex` approval.

Only these pinned identities qualify. `beepto-codex` has node ID `U_kgDOEJnzqQ`
(verified from [PR #1620](https://github.com/Corgtexdotcom/corgtex/pull/1620));
`puncar-dev` has node ID `MDQ6VXNlcjcyODkwNDA0` (verified from
[issue #1595](https://github.com/Corgtexdotcom/corgtex/issues/1595)). A matching
login with a different ID, or a matching ID with a different login, fails closed.
The selected reviewer must currently have write, maintain or admin repository
permission. Read-only collaborator-permission evidence is fetched at each of the
three validation stages; its identity and permission are bound into snapshots.
Missing, revoked or inconsistent eligibility and API errors fail closed. This
requires the token's existing repository metadata read access; do not grant new
permissions to work around a failure.

The evaluator rejects self-review by case-insensitive login or stable GitHub node
ID. PR-author and reviewer identities are checked across the initial REST,
repeated REST and final GraphQL reads. Current-head approval, complete review
pagination, dismissal and later changes-requested handling remain mandatory.
Native review, conversation, required-check and queue controls still apply.
A different account name does not make a delivery owner's review independent.
This PR-review alternate does not change release admission or environment-approval
rules; it does not authorize a deployment.

Policy adoption has a separate bootstrap constraint: the merge-group job checks
out `merge_group.base_sha`, so an unmerged policy change cannot authorize its own
merge. The existing base requires `beepto-codex` review and cannot admit a PR
whose author is also `beepto-codex`. No compatible adoption exception is documented
here. Genuine independent ownership and review under the existing base policy
must be explicitly coordinated before publication/adoption; do not relabel the
owner's work, bypass protection, or change permissions to resolve this deadlock.

When updating required contexts, verify the replacement already succeeds on PR and
merge-group SHAs, save current settings, update only the intended contexts, and read
back the result. Preserve existing review and queue controls. Compatibility aliases
may remain during rollout; they are inexpensive wrappers, not extra review stages.
Restore saved settings if activation fails. Never bypass protection to repair it.

Use the session-authorized author and the independent reviewer selected above.
Verify the selected identity immediately before each GitHub write. The owner queues the approved PR; the reviewer
never edits or merges. Live GitHub configuration is authoritative.
