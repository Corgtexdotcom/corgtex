# Industrial Vilassarenca EU Instance Runbook

## Release profile

Industrial Vilassarenca uses a dedicated European client instance. It is not a workspace inside the CRINA deployment.

Included modules:

- Home
- Goals
- Brain
- Members
- Tensions
- Actions
- Meetings
- Proposals
- Circles
- Finance
- Audit trail
- Settings
- Agent Chat

Postponed modules:

- Cycles
- Relationships / CRM pipeline
- Agent Governance
- OS Metrics / OS Matrix

## Required environment

Use an isolated Railway project in EU West / Amsterdam for web, worker, PostgreSQL, Redis, and bucket storage.

```env
APP_URL=https://<railway-generated-domain>
NEXT_PUBLIC_APP_URL=https://<railway-generated-domain>
WORKSPACE_NAME=Industrial Vilassarenca
WORKSPACE_SLUG=industrial-vilassarenca
CLIENT_DEFAULT_LOCALE=es
NEXT_PUBLIC_DEFAULT_LOCALE=es
CLIENT_CURRENCY=EUR
REDIS_KEY_PREFIX=industrial-vilassarenca-prod
SEED_SCRIPTS=scripts/seed-industrial-vilassarenca-stable.mjs
ADMIN_EMAIL=<internal-bootstrap-admin>
ADMIN_PASSWORD=<secure-bootstrap-password>
SESSION_COOKIE_SECRET=<secure-random-secret>
```

OpenRouter must use EU in-region routing before real client content is processed:

```env
MODEL_PROVIDER=openrouter
MODEL_BASE_URL=https://eu.openrouter.ai/api/v1
```

Do not enable non-EU model routing for production client data.

Configure production database, Redis, storage bucket credentials, email delivery, and `MODEL_API_KEY` as Railway variables before redeploying web and worker. Do not send invitations until real client users and email sender settings have been confirmed.

## Seed

Run migrations and the base seed first, then the Industrial Vilassarenca stable seed:

```bash
npm run prisma:migrate:deploy
npm run seed:base
npm run seed:industrial-vilassarenca-stable
```

Provide client users with one of:

```env
CLIENT_USERS_JSON='[
  {"email":"owner@example.com","displayName":"Owner Name","role":"ADMIN"},
  {"email":"facilitator@example.com","displayName":"Facilitator Name","role":"FACILITATOR"},
  {"email":"finance@example.com","displayName":"Finance Name","role":"FINANCE_STEWARD"},
  {"email":"member@example.com","displayName":"Member Name","role":"CONTRIBUTOR"}
]'
```

or:

```env
CLIENT_USERS_CSV='Owner Name,owner@example.com,ADMIN
Facilitator Name,facilitator@example.com,FACILITATOR
Finance Name,finance@example.com,FINANCE_STEWARD
Member Name,member@example.com,CONTRIBUTOR'
```

Invitation behavior:

- By default, users are created with setup-account tokens, but emails are not sent.
- Set `CLIENT_SEND_INVITES=true` only after email configuration and public app URL are verified.
- Set `CLIENT_PRINT_INVITE_LINKS=true` only in a controlled staging run.
- Do not commit or paste setup links into tickets, PRs, or handover docs.

## Verification

Run:

```bash
npm run check
npm run build
npm run smoke:industrial-vilassarenca -- <railway-url>
```

Manual checks before handoff:

- Spanish account setup and login work.
- Home, Goals, Brain, Members, Tensions, Actions, Meetings, Proposals, Circles, Finance, Audit, Settings, and Agent Chat load.
- `/cycles`, `/leads`, `/agents`, `/governance`, and `/settings?tab=agents` are blocked.
- Runtime logs show database, Redis, S3-compatible storage, web, worker, and OpenRouter EU routing configured.
