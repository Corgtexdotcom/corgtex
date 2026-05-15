# Nightly Quality and Research

Purpose: run the slow safety net outside the normal PR loop and create a
proposal-first research surface for upgrades, model changes, and new ecosystem
tools.

Run cadence: nightly.

Workflow:

1. Run the full static, unit, integration, migration, build, and production
   dependency audit suite. The audit is reported but non-blocking until the
   existing vulnerability backlog is cleared.
2. Run the local agent E2E flow against a seeded database, local web server,
   worker, and the fake model provider.
3. Run a small read-only load smoke against `/api/health`.
4. Generate a research report covering dependency drift, production audit
   findings, model-provider availability, and popular open-source projects in
   configured watch categories.
5. Upload the report as an artifact. If `NIGHTLY_RESEARCH_CREATE_ISSUE=true`
   is configured as a repository variable, append the report to the open
   nightly research issue or create it if missing.

Agent routing:

- Scout agents may use cheaper models to read the nightly research artifact and
  classify findings into security fixes, safe dependency upgrades, model
  evaluation candidates, and product ideas.
- Builder agents may prepare PRs automatically only for high-confidence fixes or
  upgrades that stay inside the normal plan and CI gates.
- New features, new model routing, and new integration ideas must become
  proposal/demo work first. They should not auto-merge from the nightly report.
- Reviewer agents still apply `.codex/review.md`; green nightly automation does
  not replace PR review.

Guardrails:

- Do not print or persist secret values in reports, issues, or artifacts.
- Do not mutate production data from nightly research.
- Do not use `--admin`, `--no-verify`, or `prisma db push`.
- Respect `halt-agents` on related issues or PRs.
