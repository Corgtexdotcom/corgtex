# Plan: Short title

## Outcome

[What user-visible or operational result will exist when this is done? State the
completion condition; keep optional polish outside the current task.]

## Risk tier

[low | standard | high | critical]

## Scope

[What changes, what intentionally does not, and why this is one coherent PR.]

## Files to touch

- `path/to/file.ts`

## Acceptance criteria

- [ ] [A concrete behavior or evidence statement.]

## Test plan

```text
[commands that verify this change's concrete acceptance criteria]
```

[Choose proportionate local checks: documentation/policy validators for prose-only
work; focused regression and applicable static/integration/build checks for code.
For an observed runtime/provider failure, name the representative boundary test
that catches it before another live attempt. Reuse evidence only while its relevant
inputs and assumptions are unchanged. All required hosted CI and independent
exact-head review remain mandatory. Do not add a new harness solely for this plan.]

## Visual proof

[For frontend changes, link proof from the running app. Prefer Corgtex Build
Artifacts; use a private fallback when proof contains private data. Delete this
section when no frontend path changed.]

## Risk and rollback

[Name the realistic failure modes and the safe revert/recovery path.]
