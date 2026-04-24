# Goal
Remove all colorful OS-rendered emojis from the UI and replace them with monochrome Unicode glyphs that align with the design system (e.g. \`nav-config.ts\`).

## Files to touch
- `apps/web/app/ThemeToggle.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/members/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/tensions/page.tsx`

- `apps/web/app/[locale]/workspaces/[workspaceId]/brain/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/actions/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/circles/PersonNode.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/circles/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/agents/[agentId]/AgentProfileClient.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/meetings/[meetingId]/MeetingIntelligence.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/operator/page.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/members/[memberId]/MemberBriefing.tsx`
- `apps/web/app/[locale]/workspaces/[workspaceId]/leads/page.tsx`
- `eslint.config.mjs`
- `AGENTS.md`
- `docs/plans/fix-remove-emojis.md`
- `docs/assets/visual_proof_fix_remove_emojis.png`

## Acceptance Criteria
- [x] All OS-rendered emojis are removed from the files listed above.
- [x] Monochrome Unicode glyphs (e.g. ⬡, ✓, ✧) are used instead.
- [x] `eslint.config.mjs` is updated with a `no-restricted-syntax` rule to block future emoji usage.
- [x] `AGENTS.md` is updated with a rule to enforce monochrome glyphs.
- [x] Visual proof attached.

## Test plan

- `npm run check` — lint, typecheck, prisma validate
- `npm run build` — production build without DB

## Labels this PR needs

- `large-change-approved` — 16 files (1 over the 15-file cap), all small surgical emoji replacements
