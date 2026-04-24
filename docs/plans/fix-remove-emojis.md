# Plan: Remove emojis and replace with Unicode glyphs

## Goal

Purge all colorful OS-rendered emoji from the Corgtex UI and replace them with monochrome Unicode glyphs that match the established `nav-config.ts` design system. This ensures consistency across platforms and proper rendering in light/dark mode. Additionally, an ESLint rule will be introduced to prevent future emoji usage.

## Out of scope

- Redesigning the layout or CSS of any component beyond replacing the text character.
- Changing icons to an external library like lucide-react or react-icons.

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

## Acceptance criteria

- [ ] All `🌙`, `☀️`, `💻` emoji in ThemeToggle are replaced with `☽`, `○`, `◐`.
- [ ] All `🤖` emoji are replaced with `⬡`.
- [ ] All `🔒` emoji are replaced with `◆`.
- [ ] Emoji like `⚙️`, `💾`, `🔴`, `🗑️`, `💰`, `⚡` in AgentProfileClient are replaced with glyphs.
- [ ] Meeting confirm/dismiss `✅`/`❌` replaced with `✓`/`✕`.
- [ ] Operator and MemberBriefing `⚠️` and `✨` replaced with `△` and `✧`.
- [ ] Leads `✉️`, `📅`, `📞`, `📝` replaced with `✉`, `▫`, `☏`, `✎`.
- [ ] `eslint.config.mjs` contains a `no-restricted-syntax` rule blocking emoji.
- [ ] `AGENTS.md` is updated to explicitly ban emoji icons.
- [ ] `npm run check` passes.

## Test plan

```
npm run check
npm run build
```

## Rollback

Pure code / docs change. Can be safely reverted with a standard git revert. No database migrations required.

## Labels this PR needs
