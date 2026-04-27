# Plan: Industrial Vilassarenca EU instance

## Goal

Create a reusable client seed and deployment support path for a dedicated Industrial Vilassarenca EU instance. The instance should launch in Spanish by default, use EUR finance defaults, keep Agent Chat available, expose the stable self-management launch surface, and disable postponed modules such as Cycles, Relationships, Agent Governance, and OS Metrics.

## Risk tier

- `low`

## Out of scope

- Creating member-to-member chat.
- Integrating Slack, Teams, or email before the client confirms its communication platform.
- Enabling OpenRouter EU routing without an enterprise EU-enabled key.
- Changing CRINA deployment settings.
- Adding database schema changes or migrations.

## Files to touch

- `.gitignore`
- `apps/web/i18n/routing.ts`
- `docs/industrial-vilassarenca-eu-handover.md`
- `docs/plans/codex-industrial-vilassarenca-eu-instance.md`
- `package.json`
- `scripts/client-readiness-smoke.mjs`
- `scripts/lib/client-stable-seed.mjs`
- `scripts/seed-industrial-vilassarenca-stable.mjs`

## Acceptance criteria

- [x] Industrial Vilassarenca has a committed stable seed script with Spanish starter content, EUR finance defaults, starter circles and roles, goals, Brain articles, kickoff meeting, proposal, tension, and action.
- [x] The reusable client seed helper supports client users, Spanish setup links, feature flags, role assignments, invite-token creation, optional invite emails, and idempotent reseeding.
- [x] `NEXT_PUBLIC_DEFAULT_LOCALE=es` can make Spanish the default locale for the client deployment.
- [x] Industrial Vilassarenca disables Cycles, Relationships, Agent Governance, and OS Metrics while leaving Agent Chat available.
- [x] The client smoke script supports Spanish login and custom output directories.
- [x] A handover runbook documents Railway EU hosting, required variables, seed behavior, verification, and OpenRouter EU routing.

## Test plan

```
node --check scripts/lib/client-stable-seed.mjs
node --check scripts/seed-industrial-vilassarenca-stable.mjs
node --check scripts/client-readiness-smoke.mjs
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corgtex npm run check
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corgtex npm run build
```

## Rollback

This change is pure code, scripts, and documentation. Revert the PR to remove the Industrial seed script, reusable helper, smoke-script additions, Spanish default-locale support, and runbook. Existing Railway resources can be left stopped or deleted separately from the Railway dashboard if the instance is no longer needed.

## Labels this PR needs

