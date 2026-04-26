# Plan: Fix Finance Page Responsive Layout

## Goal

The Finance page currently has UI/UX issues at typical viewport widths: the spend table overflows its container, content is misaligned, and there are no intermediate responsive breakpoints between full desktop and mobile (720px). This plan resolves those issues by adding horizontal scrolling to the table wrapper, introducing an 1100px breakpoint to hide the chat sidebar, tightening table cell padding, ensuring the filter and stat bars wrap/scroll gracefully, and cleaning up unused legacy CSS.

## Risk tier

- `low`

## Out of scope

- Redesigning the entire finance page or its components.
- Adding new features to the finance page.
- Changing the underlying 3-column layout structure for the entire application (beyond hiding the chat sidebar at medium viewports).

## Files to touch

- `apps/web/app/globals.css`
- `apps/web/app/[locale]/workspaces/[workspaceId]/finance/page.tsx`

- `docs/plans/fix-finance-responsive.md`

## Acceptance criteria

- [x] The `.nr-table-wrap` class has `overflow-x: auto` applied to prevent the table from overflowing the page.
- [x] A new media query (`max-width: 1100px`) hides the chat sidebar (`.ws-agent-sidebar`) and allows `.ws-main-content` to expand.
- [x] The `apps/web/app/[locale]/workspaces/[workspaceId]/finance/page.tsx` header has reduced `marginBottom`.
- [x] Unused legacy `.fin-*` classes (like `.fin-tab`, `.fin-table`, etc.) have been removed from `globals.css`.
- [x] The application builds successfully without type or lint errors.
- [x] Visual proof of the responsive layout is provided in the PR.

## Test plan

```
npm run check
npm run build
```

## Rollback

This is a pure code/styles change. Reverting the PR is safe and will restore the original layout CSS.

## Labels this PR needs

(None)
