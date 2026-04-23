# Update Reviewer Rules

## Context
The user requested that the Codex reviewer be allowed to point out issues in the code rather than strictly approving/rejecting based on mechanical criteria without any comment on code logic. We are updating the rules to allow the reviewer to reject PRs for objective logic flaws and to leave non-blocking advisory comments.

## Files to touch
- `.codex/review.md`
- `AGENTS.md`

## Acceptance criteria
- [x] Update `AGENTS.md` to allow the reviewer to flag objective logic or security flaws.
- [x] Update `.codex/review.md` to add a new hard rejection criterion for objective logic flaws.
- [x] Update `.codex/review.md` to explicitly permit non-blocking advisory comments.

## Test plan
- Verify CI passes.
