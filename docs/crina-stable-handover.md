# CRINA Stable Handover Runbook

## Release Profile

The CRINA stable workspace is a real client workspace, not a read-only demo.

Included modules:

- Home
- Brain and chat, only with client-safe seed content
- Members and settings
- Tensions
- Actions
- Meetings
- Proposals
- Circles
- Finance
- Audit trail

Postponed modules:

- Goals
- Relationships / CRM pipeline
- Cycles / resource allocation
- Agent Governance
- OS Metrics / OS Matrix

These postponed modules are disabled with workspace feature flags and should be hidden from navigation, hidden from the command palette, and blocked by direct route access. The `crina` workspace slug also carries safe default disables for these modules, so CRINA remains locked down even if the explicit feature flag rows are missing.

## Environment

Use an isolated CRINA environment with these required values:

```env
WORKSPACE_NAME=CRINA
WORKSPACE_SLUG=crina
REDIS_KEY_PREFIX=crina-prod
APP_URL=https://<client-url>
NEXT_PUBLIC_APP_URL=https://<client-url>
ADMIN_EMAIL=<internal-bootstrap-admin>
ADMIN_PASSWORD=<secure-bootstrap-password>
```

Also configure production database, Redis, storage, model provider, and email delivery before sending invitations.

## Seed

Run base migrations and seed first, then the CRINA stable seed:

```bash
npm run prisma:migrate:deploy
npm run seed:base
npm run seed:crina-stable
```

Provide real client users through one of these environment variables:

```env
CRINA_USERS_JSON='[
  {"email":"owner@example.com","displayName":"Owner Name","role":"ADMIN"},
  {"email":"finance@example.com","displayName":"Finance Name","role":"FINANCE_STEWARD"},
  {"email":"facilitator@example.com","displayName":"Facilitator Name","role":"FACILITATOR"},
  {"email":"member@example.com","displayName":"Member Name","role":"CONTRIBUTOR"}
]'
```

or:

```env
CRINA_USERS_CSV='Owner Name,owner@example.com,ADMIN
Finance Name,finance@example.com,FINANCE_STEWARD
Facilitator Name,facilitator@example.com,FACILITATOR
Member Name,member@example.com,CONTRIBUTOR'
```

Invitation behavior:

- By default, users are created with random passwords and setup-account tokens, but emails are not sent.
- Set `CRINA_SEND_INVITES=true` only after `RESEND_API_KEY`, `EMAIL_FROM`, and the public app URL are confirmed.
- Set `CRINA_PRINT_INVITE_LINKS=true` only for a controlled staging run.
- Do not commit or paste setup links into tickets, PRs, or handover docs.

## Verification

Run:

```bash
npm run check
npm run build
npm run smoke:crina
```

Manual checks before handover:

- A CRINA owner can set up a password from the invitation email and log in.
- Role access matches the user matrix.
- Tensions, actions, meetings, proposals, circles, finance, audit, members, and settings load.
- A user can create a tension, action, meeting, proposal, and spend request.
- Audit records appear for user actions.
- `/goals`, `/leads`, `/cycles`, `/agents`, and `/governance` return not found or another blocked response.

## Handover Notes

Send the client:

- Client URL
- Initial user/access matrix
- Included modules
- Postponed modules
- Known limitations
- Short workflow guide for tensions, meetings, proposals/circles, finance, and audit

Before production promotion, take a database backup and record the release tag, for example `crina-stable-2026-04-26`.
