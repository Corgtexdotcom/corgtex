# Plan: Fix Slack authorization

## Goal

Fix the production Slack OAuth flow so Corgtex and Slack use the same configured redirect URL, and harden the app routes so Slack install and callback redirects use the public application origin instead of an internal Railway host.

## Risk tier

- `high`

## Out of scope

- Changing Slack ingestion, command, interactivity, or event-processing behavior.
- Adding new Slack scopes beyond the scopes already requested by the app.
- Changing authentication, membership, or workspace permission rules.

## Files to touch

- `apps/web/app/api/integrations/slack/oauth.ts`
- `apps/web/app/api/integrations/slack/install/route.ts`
- `apps/web/app/api/integrations/slack/callback/route.ts`
- `apps/web/app/api/integrations/slack/install/route.test.ts`
- `apps/web/app/api/integrations/slack/callback/route.test.ts`
- `docs/deploy/slack-app-setup.mdx`
- `docs/docs.json`
- `docs/plans/codex-fix-slack-authorization.md`

## Acceptance criteria

- [x] Slack install generates `https://app.corgtex.com/api/integrations/slack/callback` from `APP_URL`.
- [x] Slack callback token exchange uses the same redirect URI generated during install.
- [x] Slack callback success redirects back to the public Corgtex origin.
- [x] Next.js auth redirects from Slack routes are rethrown instead of being converted into generic 500 responses.
- [x] Internal Slack setup docs state that the manifest must be applied to the Slack app whose Client ID is deployed.
- [x] Unit coverage exists for the install and callback redirect behavior.

## Test plan

```
npm exec -- vitest run --project unit apps/web/app/api/integrations/slack/install/route.test.ts apps/web/app/api/integrations/slack/callback/route.test.ts apps/web/app/api/integrations/slack/events/route.test.ts
DATABASE_URL='postgresql://postgres:postgres@localhost:5432/corgtex' npm run check
curl -i -X POST https://app.corgtex.com/api/integrations/slack/events -H 'Content-Type: application/json' --data '{"type":"event_callback"}'
```

## Rollback

This is a code and documentation change only. Revert the PR if needed, then redeploy the previous web service version. The Slack app configuration can remain in place because the redirect URL and manifest endpoints are the intended production configuration.

## Labels this PR needs

