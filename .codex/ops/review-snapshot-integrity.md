# Review Snapshot Integrity (temporary transition)

Review Snapshot Integrity (RSI) binds a `beepto-codex` approval to the reviewed
head SHA, base SHA, PR-body bytes, and labels. It is a temporary reviewer-policy
gate while `PR Policy` and `PR Metadata Policy` replace it. It is not a native
required branch or ruleset context; do not add it to branch protection.

## Trust boundary

- The PR publisher runs the evaluator from the trusted base SHA, publishes the
  `Review Snapshot Integrity` status on the immutable event head, and may dismiss
  stale approvals or dequeue a changed PR.
- The merge-group evaluator runs from the trusted pre-merge base with read-only
  repository and pull-request access. It resolves every live queue member and
  fails closed on missing, ambiguous, paginated, stale, or changed state.
- During transition, `PR Metadata Policy` reuses that trusted merge-group
  evaluator before publishing its own synthetic-SHA status. Cleanup must retain
  or refactor the live-member validation before removing RSI attestation code.
- Neither workflow executes PR-head code, installs dependencies, persists checkout
  credentials, or exposes a reviewer credential to Node.

## Canonical reviewer procedure

1. Re-read the live PR body, labels, complete diff, required checks, unresolved
   threads, mergeability, and exact head/base.
2. Generate the attestation only from freshly fetched `origin/main`. Only `gh`
   receives the reviewer credential; Node receives public PR JSON on stdin:

   ```bash
   PR_NUMBER=<pr-number>
   RSI_TRUSTED_ROOT="$(mktemp -d)"
   RSI_TRUSTED_DIR="$RSI_TRUSTED_ROOT/main"
   cleanup_rsi() {
     git worktree remove "$RSI_TRUSTED_DIR" >/dev/null 2>&1 || true
     rmdir "$RSI_TRUSTED_ROOT" >/dev/null 2>&1 || true
   }
   trap cleanup_rsi EXIT

   git fetch origin main
   git worktree add --detach "$RSI_TRUSTED_DIR" origin/main
   RSI_PAYLOAD="$(
     GH_CONFIG_DIR="$HOME/.config/gh-codex-reviewer" /opt/homebrew/bin/gh \
       api "repos/Corgtexdotcom/corgtex/pulls/$PR_NUMBER" |
     RSI_TRUSTED_SCRIPT="$RSI_TRUSTED_DIR/scripts/review-snapshot-integrity.mjs" \
       env -u GH_TOKEN -u GITHUB_TOKEN node --input-type=module -e \
       'import {pathToFileURL} from "node:url"; let json=""; for await (const chunk of process.stdin) json+=chunk; const m=await import(pathToFileURL(process.env.RSI_TRUSTED_SCRIPT)); const pr=JSON.parse(json); console.log(m.buildAttestationPayload(pr.number,m.computeSnapshot(pr)));'
   )"
   RSI_REVIEW_BODY="$(printf '```review-snapshot-attestation\n%s\n```' "$RSI_PAYLOAD")"

   trap - EXIT
   cleanup_rsi
   ```

3. Immediately before the approval write, verify the reviewer identity and submit
   exactly one attestation block:

   ```bash
   REVIEWER_CONFIG="$HOME/.config/gh-codex-reviewer"
   test "$(GH_CONFIG_DIR="$REVIEWER_CONFIG" /opt/homebrew/bin/gh api user --jq .login)" = "beepto-codex"
   GH_CONFIG_DIR="$REVIEWER_CONFIG" /opt/homebrew/bin/gh pr review "$PR_NUMBER" \
     --repo Corgtexdotcom/corgtex --approve --body "$RSI_REVIEW_BODY"
   ```

4. Rerun the exact `Review Snapshot Integrity Publisher` run for that head. Confirm
   its explicit status is `success` on the same head before returning approval
   evidence. A stale-head run can write only to its immutable event head.

Any later head, base, body, label, draft-state, or decisive-review change invalidates
the snapshot. Re-review from current live state; never reuse the old payload.

## Transition exit and rollback

After both replacement contexts are required and proven on PR and merge-group SHAs,
remove the RSI status, publisher, attestation requirement, and temporary aliases in
a later protected PR. Preserve/refactor the live-member validation used by
`PR Metadata Policy`. If replacement activation fails, restore the previous required
contexts first and revert through the normal protected path; never bypass protection
to repair the policy system.
