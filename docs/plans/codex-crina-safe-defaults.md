# Plan: CRINA Safe Defaults

## Goal

Make the CRINA stable profile fail closed so unfinished modules stay hidden and blocked even when explicit workspace feature flag rows are missing. Extend the controlled surface to cover Goals and Cycles, which are not part of the approved CRINA handover module list.

## Risk tier

standard

## Files to touch

- `apps/web/lib/nav-config.ts`
- `apps/web/lib/workspace-feature-flags.ts`
- `apps/web/app/[locale]/workspaces/[workspaceId]/goals/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/cycles/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/cycles/actions.ts`
- `scripts/seed-crina-stable.mjs`
- `package.json`
- `docs/crina-stable-handover.md`
- `docs/plans/codex-crina-safe-defaults.md`

## Acceptance criteria

- [x] CRINA uses safe default feature flags based on the `crina` workspace slug when database flag rows are absent.
- [x] Database feature flag rows can still explicitly override the profile defaults.
- [x] Goals and Cycles are feature-gated in navigation and direct page access.
- [x] Cycle mutation actions are blocked when the Cycles module is disabled.
- [x] CRINA stable seed writes explicit disabled rows for Goals, Relationships, Cycles, Agent Governance, and OS Metrics.
- [x] CRINA smoke checks verify Goals, Relationships, Cycles, Agent Governance, OS Metrics, and the legacy agent settings tab are blocked.
- [x] The CRINA handover runbook documents the fail-closed behavior and expanded postponed module list.

## Test plan

```bash
npm run check
npm run build
npm run smoke:crina
```

## Rollback

Enable the relevant CRINA workspace feature flag rows if one of the postponed modules should become available. Reverting this PR restores global default-on behavior for missing CRINA feature flag rows.

## Labels this PR needs

None.
