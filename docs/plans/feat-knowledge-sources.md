# Plan: Versatile Knowledge Sources

## Goal

Expand the **Settings → Data Sources** tab from a PostgreSQL-only database connector into a **unified knowledge ingestion hub**, renaming it to **Knowledge Sources**. Users should be able to upload files (via drag-and-drop or file system picker), upload folders in bulk, and paste plain text directly into a form. All content will enter the existing Knowledge Brain pipeline. The view will also show a log of recent uploads (Documents).

## Out of scope

- File type preview/viewer in the settings page
- Editing uploaded content after ingestion
- Folder structure preservation (files are ingested flat)
- Search/filter within uploaded documents
- Any schema or database changes

## Files to touch

- `apps/web/app/workspaces/[workspaceId]/settings/DataSourcesManager.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/page.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/FileUploader.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/TextPasteUploader.tsx`
- `apps/web/app/workspaces/[workspaceId]/settings/RecentUploads.tsx`
- `apps/web/app/api/workspaces/[workspaceId]/data-sources/text-ingest/route.ts`
- `docs/plans/feat-knowledge-sources.md`

## Acceptance criteria

- [x] Tab renamed to "Knowledge Sources"
- [x] File upload works via drag-and-drop for supported files
- [x] Multi-file selection works via file picker
- [x] Folder upload works via folder picker button
- [x] Plain text paste form accepts title, source type, and content and creates a BrainSource
- [x] Existing database connector functionality is preserved unchanged
- [x] Recently uploaded documents are listed
- [x] `npm run check` passes (lint + typecheck + prisma validate)

## Test plan

```
npm run check
npm run test:unit
```

## Rollback

Pure UI + one new API route. Safe to revert — no schema changes, no migrations. Existing functionality in Brain Sources page remains untouched.
