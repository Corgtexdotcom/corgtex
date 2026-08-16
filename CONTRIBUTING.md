# Contributing to Corgtex

Corgtex accepts changes through protected pull requests. Start by reading
[`AGENTS.md`](AGENTS.md); it contains the repository's engineering invariants and
agent operating model.

## Local setup

```bash
npm install
npm run prisma:generate
npm run check
npm run test:unit
```

Use the targeted tests relevant to your change. Database-backed integration tests
run with `npm run test:integration`; the database-independent production build is
`env -u DATABASE_URL npm run build`.

## Pull requests

- Start new work from current `origin/main` in a clean task branch/worktree.
- Default to one coherent PR for the complete outcome. Split only where each part is
  independently useful, safe, testable, deployable, and rollbackable.
- Put the short contract from [`.agents/plan-template.md`](.agents/plan-template.md)
  in the PR body: outcome, risk, file scope, acceptance, tests, and rollback.
- Keep the contract public-safe. Never include credentials, secrets, or customer-
  private facts.
- Update the PR body when real scope or acceptance changes; do not manufacture a
  separate planning handoff.
- Frontend changes need proof from the running application. Keep generated proof in
  ignored `.artifacts/` and link it through Corgtex Build Artifacts or a safe private
  fallback.

CI verifies the contract, declared file scope, security hygiene, tests, build, and
documentation. An independent reviewer evaluates the complete current diff and
objective risks. See [Agent delivery](docs/contributing/agent-pipeline.mdx) and
[Branching and pull requests](docs/contributing/pull-requests.mdx).

## Public documentation

`docs/` is public. Do not commit client/partner notes, handoffs, plans, screenshots,
recordings, generated QA, or Slack manifests. Keep private material in an approved
private system and generated output outside Git history.

## Code style

Use strict TypeScript, two-space indentation, double quotes, semicolons, `@/*` web
imports, and `@corgtex/*` package imports. Formatting and static rules are enforced
by `npm run check`.
