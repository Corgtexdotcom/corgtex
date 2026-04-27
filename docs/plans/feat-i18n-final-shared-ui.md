# Plan: Final Phase 3 i18n Shared UI

## Goal

Finalize Corgtex internationalization by extracting hardcoded English from shared UI components, auth/demo entry points, demo-tour copy, and remaining workspace widgets. English and Spanish message catalogs must stay in exact key parity, and Spanish values should no longer contain obvious untranslated English except product names, acronyms, code samples, URLs, enum values, and language autonyms.

## Risk tier

- `standard`

## Out of scope

- Reworking locale middleware, route structure, auth behavior, workspace authorization, Prisma schema, migrations, or workspace redirect behavior.
- Restoring a public marketing landing page at `apps/web/app/[locale]/page.tsx`.
- Translating database-authored content such as workspace names, member names, uploaded document titles, proposal bodies, or recognition stories.
- Adding locales beyond `en` and `es`.

## Files to touch

- `apps/web/app/[locale]/**`
- `apps/web/lib/components/**`
- `apps/web/messages/en.json`
- `apps/web/messages/es.json`
- `docs/plans/feat-i18n-final-shared-ui.md`
- `docs/assets/feat-i18n-final-shared-ui/**`

## Acceptance criteria

- [x] All static UI copy in the audited locale app and shared components uses `next-intl`.
- [x] `apps/web/messages/en.json` and `apps/web/messages/es.json` have exact key parity.
- [x] Existing Spanish values are copy-edited so obvious English leftovers are translated, except approved product/code/autonym cases.
- [x] No auth, routing, workspace authorization, Prisma schema, migration, or middleware behavior changes.
- [x] Visual proof is committed for frontend changes.
- [x] `npm run check` passes.
- [x] `npm run build` passes.

## Test plan

```bash
npm run check
npm run build
node -e 'const fs=require("fs"); const flat=(o,p="",r={})=>{for(const [k,v] of Object.entries(o)){const key=p?p+"."+k:k; if(v&&typeof v==="object"&&!Array.isArray(v)) flat(v,key,r); else r[key]=v;} return r}; const en=flat(JSON.parse(fs.readFileSync("apps/web/messages/en.json","utf8"))); const es=flat(JSON.parse(fs.readFileSync("apps/web/messages/es.json","utf8"))); const a=Object.keys(en).filter(k=>!(k in es)); const b=Object.keys(es).filter(k=>!(k in en)); if(a.length||b.length){console.error({missingInEs:a,missingInEn:b}); process.exit(1)}'
```

Also run the app locally and commit visual proof under `docs/assets/feat-i18n-final-shared-ui/` for English and Spanish views covering login/demo, workspace demo banner or tour, deliberation composer/thread, and one circles/goals surface.

## Rollback

Pure UI localization and message-file changes. Revert the PR if message keys break runtime rendering or localized copy regresses. No database or migration rollback is needed.

## Labels this PR needs

- `large-change-approved` — final mechanical localization pass touches broad shared UI and locale app files.
