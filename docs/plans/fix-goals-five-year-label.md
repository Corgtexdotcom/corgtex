# Plan: Fix goals five year label

## Goal

Fix a UI bug on the Strategic Goals page where the 5-year goal cadence was incorrectly labeled as "Annual", resulting in two identical "Annual" labels in the cadence selector. This changes the `FIVE_YEAR` label to "5Y".

## Risk tier

- `low`

## Out of scope

- Any other changes to the goals page or components.
- Modifying the underlying data models or types.

## Files to touch

- `apps/web/app/[locale]/workspaces/[workspaceId]/goals/page.tsx`
- `docs/assets/fix-goals-five-year-label/**`
- `docs/plans/fix-goals-five-year-label.md`

## Acceptance criteria

- [x] The `FIVE_YEAR` cadence label in `apps/web/app/[locale]/workspaces/[workspaceId]/goals/page.tsx` is updated from "Annual" to "5Y".
- [x] The UI correctly renders "5Y" instead of the duplicate "Annual".

## Test plan

```
npm run check
```

## Rollback

Pure UI code change. Reverting is safe.

## Labels this PR needs
