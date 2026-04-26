# Plan: Fix Dark Mode White Flash

## Goal

Eliminate the jarring white flash that appears when navigating between pages in dark mode. This is achieved by correctly configuring `next-themes` to use the browser's native dark color scheme for initial paints, applying inline SSR backgrounds, overriding the hardcoded light-mode gradient, and scoping CSS transitions so they don't incorrectly animate the theme change.

## Risk tier

- `low`

## Out of scope

- Refactoring the entire theme system or introducing new theme tokens.
- Fixing other visual bugs unrelated to the dark mode flash on navigation.

## Files to touch

- `apps/web/app/ThemeProvider.tsx`
- `apps/web/app/[locale]/layout.tsx`
- `apps/web/app/globals.css`
- `docs/plans/fix-dark-mode-flash.md`

## Acceptance criteria

- [x] `ThemeProvider.tsx` includes `enableColorScheme` and `disableTransitionOnChange` props.
- [x] `layout.tsx` applies an inline `style={{ background: "var(--bg)" }}` to the `<body>` element.
- [x] `globals.css` includes a dark-mode gradient override for `html` and `body`.
- [x] `globals.css` scopes `--transition` exclusively to `transform`, `opacity`, and `box-shadow`.
- [x] `globals.css` usages of `var(--transition)` are updated with explicit `background-color` transitions where hover effects require them.

## Test plan

```
npm run check
npm run build
```

## Rollback

Revert the PR. No database migrations or shared state are modified.

## Labels this PR needs

