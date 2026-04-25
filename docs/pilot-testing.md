# Pilot Testing Access

Use a dedicated tester account per pilot workspace when an agent needs to reproduce a frontend issue or verify a workflow in production-like data.

## Seed a Tester

```bash
WORKSPACE_SLUG="client-slug" \
TESTER_EMAIL="tester+client@corgtex.app" \
TESTER_PASSWORD="replace-with-shared-password" \
npm run seed:pilot-tester
```

The tester is created as an active workspace admin so it can exercise realistic workflows.

## Clean Up Agent Test Artifacts

Agents should prefix created proposal and tension titles with `[TEST]`. Cleanup archives matching proposals and cancels matching tensions; it does not hard delete data.

```bash
WORKSPACE_SLUG="client-slug" \
TESTER_EMAIL="tester+client@corgtex.app" \
npm run cleanup:test-artifacts
```
