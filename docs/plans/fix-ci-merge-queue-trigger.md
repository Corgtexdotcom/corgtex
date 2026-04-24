# Fix: CI merge queue trigger

## Problem

PR #30 was automatically removed from GitHub's merge queue because no CI
status checks responded. The merge queue fires a `merge_group` event, but
our CI workflow only triggers on `push` and `pull_request` events. Without
a matching trigger, no checks run and GitHub ejects the PR after its
timeout.

## Proposed change

Add `merge_group:` to the `on:` trigger block in `.github/workflows/ci.yml`.

PR-governance jobs (`docs`, `plan-present`, `scope-check`, `diff-size`,
`gitleaks`) already guard with `if: github.event_name == 'pull_request'`
and will correctly skip during merge-queue runs.

## Files to touch

- `.github/workflows/ci.yml`
- `docs/plans/fix-ci-merge-queue-trigger.md`

## Acceptance criteria

- [x] `merge_group` event added to CI workflow triggers
- [x] PR-only jobs remain guarded and will skip during merge queue runs
- [x] No other workflow behaviour is changed

## Test plan

- Verify the YAML is syntactically valid
- Merge a PR via the merge queue and confirm CI runs on the `merge_group` event
