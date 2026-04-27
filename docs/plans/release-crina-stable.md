# Plan: CRINA Stable Client Handover

## Goal

Prepare a stable CRINA workspace release profile that exposes only client-ready modules and blocks unfinished Goals, Relationships, Cycles, Agent Governance, OS Metrics, and Settings General integrations surfaces.

## Risk tier

standard

## Files to touch

- `apps/web/lib/nav-config.ts`
- `apps/web/lib/workspace-feature-flags.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/layout.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/CommandPalette.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/leads/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/[agentId]/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/governance/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/members/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/audit/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/page.tsx`
- `apps/web/messages/en.json`
- `apps/web/messages/es.json`
- `scripts/seed-crina-stable.mjs`
- `scripts/client-readiness-smoke.mjs`
- `package.json`
- `docs/crina-stable-handover.md`
- `docs/plans/release-crina-stable.md`

## Acceptance criteria

- [x] CRINA can store disabled feature flags for Relationships, Agent Governance, and OS Metrics.
- [x] Disabled modules are removed from sidebar navigation and the command palette.
- [x] Direct access to `/leads`, `/agents`, `/agents/[agentId]`, and `/governance` is blocked when the matching flag is disabled.
- [x] Direct access to the legacy agent settings tab is blocked when Agent Governance is disabled.
- [x] Direct access to the Settings General integrations tab is blocked when Settings General is disabled.
- [x] The CRINA Settings nav entry still loads and defaults to Members when Settings General is disabled.
- [x] Members and audit pages do not link users into disabled Agent Governance surfaces.
- [x] CRINA stable seed creates the workspace profile, disabled flags, roles, safe starter records, and optional setup-account invitations from environment-provided users.
- [x] CRINA smoke can verify included routes and expected-disabled routes.
- [x] Handover runbook documents environment, seed, invitation, verification, and client handoff steps.

## Test plan

```bash
npm run check
npm run build
npm run smoke:crina
```

## Rollback

Remove or enable the CRINA workspace feature flag rows for `GOALS`, `RELATIONSHIPS`, `CYCLES`, `AGENT_GOVERNANCE`, `OS_METRICS`, and `SETTINGS_GENERAL` to restore access. Code changes are additive and preserve defaults for workspaces without explicit disabled flags.

## Labels this PR needs

None.
