# Plan: <short title>

<!--
  This file is the canonical handoff from Planner (Claude) to Executor
  (Gemini in Antigravity) and to Reviewer (Codex). Copy this template to
  `docs/plans/<branch>.md`. The branch name, lowercased and with `/`
  replaced by `-`, is the filename.

  Executor: your first action on this branch is to `cat` this file and
  echo the Acceptance criteria checklist into your first commit message.

  Reviewer: reject the PR if changed files are not in "Files to touch",
  if any acceptance criterion is not ticked, or if the PR body does not
  link back to this file.
-->

## Goal

One paragraph. What are we trying to accomplish and why. Ground it in a
concrete user-visible outcome or a concrete engineering invariant.

## Out of scope

Bullet list of things that could plausibly be bundled in but won't be.
This is load-bearing: Reviewer uses it to reject scope creep.

## Files to touch

Markdown list. Each item is a backtick-wrapped path or glob, one per
line. `scripts/check-plan.mjs` parses this section literally — anything
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

## Rollback

What breaks if we revert this PR? How do we revert safely? If the change
includes a migration or changes shared state, spell out the ordered
steps. If it's pure code / docs, say so explicitly.

## Labels this PR needs

List any labels required by branch protection or by the forbidden-paths
rule in `docs/contributing/agent-pipeline.mdx`. Common ones:

- `forbidden-path-approved` — touches `deploy/**`, `.github/workflows/**`,
  `prisma/migrations/**`, or auth files. Requires justification above.
- `large-change-approved` — diff exceeds the 400-LOC / 15-file cap.
  Requires justification above.

Leave this section empty if none apply.
