# Plan: CRINA Hide General Settings

## Goal

Hide the Settings General integrations tab from the CRINA stable workspace because those integrations are not client-ready, while keeping the Settings entry usable by defaulting CRINA users to the Members tab.

## Risk tier

- standard

## Out of scope

- Changing or removing the underlying integration APIs.
- Changing non-CRINA workspace defaults.
- Changing the CRINA user matrix or invitation flow.

## Files to touch

- `apps/web/app/[locale]/workspaces/[workspaceId]/settings/page.tsx`
- `apps/web/lib/workspace-feature-flags.ts`
- `apps/web/messages/en.json`
- `apps/web/messages/es.json`
- `scripts/seed-crina-stable.mjs`
- `package.json`
- `docs/crina-stable-handover.md`
- `docs/plans/release-crina-stable.md`
- `docs/plans/codex-crina-hide-general-settings.md`

## Acceptance criteria

- [x] CRINA hides the Settings General tab from the Settings tab bar.
- [x] CRINA `/settings` still loads and defaults to Members.
- [x] CRINA `/settings?tab=general` returns not found when Settings General is disabled.
- [x] The CRINA stable seed explicitly disables `SETTINGS_GENERAL`.
- [x] The CRINA smoke command includes `/settings?tab=general` as an expected-disabled route.
- [x] Members settings table labels render without the missing `settings.colEmail` key.

## Test plan

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/corgtex npm run check
npm run build
```

Visual proof:

```bash
docs/assets/codex-crina-hide-general-settings/settings-members-default.png
```

## Rollback

Revert this PR, or enable the CRINA `SETTINGS_GENERAL` workspace feature flag row to restore the General tab. This change does not include a migration.

## Labels this PR needs

None.
