# Plan: Deliberation UI — Reusable Component + Proposal Detail Page

## Goal

Build the reusable `DeliberationThread` UI component and apply it to proposals. This creates the proposal detail page (`/proposals/[proposalId]`), redesigns the proposals list to be a clean Discourse-style topic list with clickable rows, and fixes the broken reaction submission. The `DeliberationThread` component is entity-agnostic and will be reused across finance, tensions, and meetings in PR 3.

**Depends on:** `feat/deliberation-core` (PR 1) must be merged first.

## Out of scope

- Rolling out to finance, tensions, meetings (PR 3: `feat/deliberation-rollout`)
- Data migration from old `ProposalReaction` table (PR 3 handles all migrations together)
- AI-powered advisor recommendations UI
- Removing the old `ProposalReaction` model from schema

## Files to touch

- `apps/web/lib/components/DeliberationThread.tsx`
- `apps/web/lib/components/DeliberationComposer.tsx`
- `apps/web/app/workspaces/[workspaceId]/proposals/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/proposals/[proposalId]/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/proposals/ProposalReactionsThread.tsx`
- `apps/web/app/workspaces/[workspaceId]/proposals/actions.ts`
- `apps/web/app/workspaces/[workspaceId]/actions.ts`
- `apps/web/app/globals.css`
- `docs/plans/feat-deliberation-ui.md`

## Acceptance criteria

- [x] `DeliberationThread` server component renders a chronological list of deliberation entries with author initials, name, timestamp, type badge, body, and resolution state
- [x] `DeliberationComposer` client component provides a reply form with type selector (Support, Question, Concern, Objection) and textarea, using direct action imports (not barrel re-export)
- [x] No emoji anywhere in the UI — all buttons and badges use text labels with CSS classes matching the newsroom design system
- [x] Proposals list page shows clickable rows that link to `/workspaces/{id}/proposals/{proposalId}`
- [x] Proposals list page does NOT render inline reaction/objection forms
- [x] Proposal detail page at `proposals/[proposalId]/page.tsx` renders: back link, masthead (title, status, author, date), rendered markdown body, deliberation thread, advice process section (if active), author actions sidebar
- [x] Submitting a reaction/objection/question via the composer on the detail page creates a `DeliberationEntry` and the entry appears in the thread after page refresh
- [x] Resolving an entry as the proposal author works and shows the resolution note
- [x] `ProposalReactionsThread.tsx` is deleted (no longer used)
- [x] `proposals/actions.ts` has new `postDeliberationEntryAction` and `resolveDeliberationEntryAction` server actions
- [x] The barrel re-export in `actions.ts` is updated to include new actions
- [x] CSS classes `delib-*` are added to `globals.css` following the newsroom design system
- [x] `npm run check` passes
- [x] Screen recording captured showing: list → click → detail → post reaction → resolve

## Test plan

```
npm run check
npm run test:unit
```

Manual: run `npm run dev`, navigate to proposals, verify the full flow, capture screen recording.

## Rollback

Pure UI changes. No schema modifications. The new `[proposalId]` route simply 404s if reverted. The proposals list reverts to its previous (broken) state. Safe to revert.

## Labels this PR needs

_(none)_

## Implementation notes for Executor

### DeliberationThread component (`apps/web/lib/components/DeliberationThread.tsx`)

This is a **server component** (no `"use client"` directive). It receives pre-fetched data and renders static HTML. The form actions are passed as standard `<form action={...}>` patterns.

Props interface:

```typescript
type DeliberationEntry = {
  id: string;
  entryType: string;
  authorName: string;
  authorInitials: string;
  bodyMd?: string | null;
  createdAt: Date;
  resolvedAt?: Date | null;
  resolvedNote?: string | null;
};

type DeliberationThreadProps = {
  entries: DeliberationEntry[];
  canResolve: boolean;
  resolveAction: (formData: FormData) => Promise<void>;
  hiddenFields: Record<string, string>;  // workspaceId, etc.
};
```

Visual design:
- Each entry: avatar circle (initials, 32×32px, bg color derived from entryType) → header row (name · timestamp · type badge) → body text → resolve state
- Type badges use existing `tag` CSS classes: `tag success` (Support), `tag info` (Question), `tag warning` (Concern), `tag danger` (Objection), `tag` neutral (Reaction)
- Resolved entries show a collapsed note with muted styling
- Objections get a left border accent in danger color (following `fin-comment-objection` pattern)
- No emoji. Use text labels only.

### DeliberationComposer component (`apps/web/lib/components/DeliberationComposer.tsx`)

This is a **client component** (`"use client"`) because it manages form state (type selection).

**Critical:** Import the server action directly from a specific path, NOT from the barrel re-export `"../actions"`. Pass the action as a prop from the parent server component.

```typescript
type DeliberationComposerProps = {
  postAction: (formData: FormData) => Promise<void>;
  hiddenFields: Record<string, string>;
  entryTypes: Array<{ value: string; label: string; variant: string }>;
};
```

Default entry types for proposals:
```typescript
[
  { value: "SUPPORT", label: "Support", variant: "success" },
  { value: "QUESTION", label: "Question", variant: "info" },
  { value: "CONCERN", label: "Concern", variant: "warning" },
  { value: "OBJECTION", label: "Objection", variant: "danger" },
]
```

### Proposal detail page (`proposals/[proposalId]/page.tsx`)

Follow the pattern from `brain/[slug]/page.tsx`:
- `export const dynamic = "force-dynamic";`
- Fetch proposal via `getProposal(actor, { workspaceId, proposalId })`
- Fetch deliberation entries via `listDeliberationEntries(workspaceId, "PROPOSAL", proposalId)`
- Render markdown body via `renderMarkdown(proposal.bodyMd)`
- Import `postDeliberationEntryAction` and `resolveDeliberationEntryAction` from `"./actions"` (NOT the barrel) — wait, these will be in proposals/actions.ts via the new actions added. Actually import from the parent `"../actions"` if the action is exported there. But if that causes barrel issues for the composer (client component), pass the action as a prop from the server page to the composer.

### Proposals list page redesign

Transform each proposal from inline-everything to a clickable row:
```tsx
<a href={`/workspaces/${workspaceId}/proposals/${proposal.id}`} className="nr-item" style={{ display: "block", textDecoration: "none", color: "inherit" }}>
  <div className="row" style={{ alignItems: "center" }}>
    <strong className="nr-item-title">{proposal.title}</strong>
    <span className={`tag ${statusClass}`}>{proposal.status}</span>
  </div>
  <div className="nr-excerpt">...</div>
  <div className="nr-item-meta">author · date · N replies · N objections</div>
</a>
```

Keep "Draft a proposal" form at the bottom. Keep "Archive" button on list items for drafts. Remove all inline reaction forms, advice process forms, objection forms.

### CSS additions (`globals.css`)

Add inside the `@layer components` block:

```css
/* Deliberation Thread */
.delib-thread { @apply flex flex-col gap-0; }
.delib-entry { @apply py-4 border-b border-dashed border-line; }
.delib-entry:last-child { @apply border-b-0; }
.delib-header { @apply flex items-center gap-2 text-[0.85rem]; }
.delib-avatar { @apply flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-full text-[0.7rem] font-bold uppercase; }
.delib-avatar-support { @apply bg-green-100 text-green-700; }
.delib-avatar-question { @apply bg-blue-100 text-blue-700; }
.delib-avatar-concern { @apply bg-amber-100 text-amber-700; }
.delib-avatar-objection { @apply bg-red-100 text-red-700; }
.delib-avatar-reaction { @apply bg-gray-100 text-gray-600; }
.delib-body { @apply mt-2 text-[0.9rem] leading-relaxed; }
.delib-objection { @apply border-l-2 border-red-400 pl-3; }
.delib-resolved { @apply opacity-60; }
.delib-resolve-note { @apply mt-2 p-2 bg-bg-alt rounded text-[0.82rem] text-muted; }
.delib-composer { @apply mt-6 pt-6 border-t border-line; }
.delib-type-selector { @apply flex gap-2 mb-3; }
.delib-type-btn { @apply px-3 py-1 rounded-full text-[0.8rem] font-semibold border border-line cursor-pointer transition-all; }
.delib-type-btn-active { @apply border-text bg-text text-white; }
```
