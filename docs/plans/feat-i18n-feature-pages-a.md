# Add internationalization to smaller feature pages

This PR implements i18n for a set of smaller workspace feature pages.

## Files to touch

- apps/web/app/[locale]/workspaces/[workspaceId]/agents/page.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/agents/AccessControlTab.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/agents/AgentModelOverride.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/agents/AgentRegistryTab.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/agents/AgentSpendLimits.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/agents/ObservabilityTab.tsx
- apps/web/app/[locale]/workspaces/[workspaceId]/agents/SpendControlTab.tsx
- apps/web/messages/en.json
- apps/web/messages/es.json
- docs/plans/feat-i18n-feature-pages-a.md
- docs/assets/visual_proof_pr3a.png

## Acceptance Criteria

- [ ] Agent Governance page and all tabs use `t()` for all visible text
- [ ] New `agents` namespace added to `en.json` and `es.json` with perfect parity
- [ ] No hardcoded English strings remain in the agents pages
- [ ] `npm run check` passes
- [ ] `npm run build` succeeds

## Test Plan

- Run `npm run check` locally to ensure types and linting pass.
- Run `npm run build` locally to ensure the build works without a DB.
