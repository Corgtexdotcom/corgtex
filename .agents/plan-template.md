# Plan: Short title

{/*
  This file is the canonical handoff from Planner (Claude) to Executor
  (Gemini in Antigravity) and to Reviewer (Codex). Copy this template
  into the pull request body. For local checks before a PR exists, copy
  it to `.agents/plans/<branch>.md`; that directory is intentionally
  ignored and must not be committed.

  Executor: your first action on this branch is to read the PR body, or
  the ignored local plan file if the PR has not been opened yet.

  Reviewer: reject the PR if changed files are not in "Files to touch",
  if any acceptance criterion is not ticked, or if the PR body does not
  include this plan contract.

  This plan is stored in GitHub PR metadata. Keep it public-safe: never
  include private keys, API tokens, passwords, customer-private facts,
  raw credentials, or secret values. Link private context from an
  approved internal system instead of pasting it here.
*/}

## Goal

One paragraph. What are we trying to accomplish and why. Ground it in a
concrete user-visible outcome or a concrete engineering invariant.

## Risk tier

Replace this section with exactly one list item whose value is `low`,
`standard`, or `high`. Guidance:

- `low` — docs, copy, styles, or tightly scoped non-security changes.
- `standard` — normal product or domain work.
- `high` — auth, permissions, migrations, deploy, workflows, security-sensitive logic, or broad shared behavior.

## Out of scope

Bullet list of things that could plausibly be bundled in but won't be.
This is load-bearing: Reviewer uses it to reject scope creep.

## Files to touch

Markdown list. Each item is a backtick-wrapped path or glob, one per
line. `scripts/check-plan.mjs` parses this section literally. Anything
outside this list will fail `scope-check` in CI.

- `path/to/file.ts`
- `path/to/dir/**`

## Acceptance criteria

GitHub-style checklist. Each item must be independently verifiable by
reading code or CI output. No prose. Reviewer verifies each one.

- [ ] ...
- [ ] ...

## Test plan

Executable commands, one per line in a fenced block. Reviewer checks
that CI actually ran these or that the equivalent was run.

```
npm run check
npm run test:unit
```

## Visual Proof

For UI changes under `apps/web/app/**`, `apps/web/components/**`, or
`apps/web/lib/components/**`, link actual proof from the PR body. Use
PR attachments, CI-uploaded artifacts, or another private artifact link.
Do not commit screenshots, recordings, or generated QA output to
`docs/assets/`.

Delete this section if no UI paths changed.

## Rollback

What breaks if we revert this PR? How do we revert safely? If the change
includes a migration or changes shared state, spell out the ordered
steps. If it's pure code / docs, say so explicitly.

## Labels this PR needs

List any labels required by branch protection or by the forbidden-paths
rule in `docs/contributing/agent-pipeline.mdx`. Common ones:

- `forbidden-path-approved` — touches `deploy/**`, `.github/workflows/**`,
  `prisma/migrations/**`, or auth files. Requires justification above.
- `large-change-approved` — diff exceeds the risk-tier cap. Requires
  justification above.

Leave this section empty if none apply.
