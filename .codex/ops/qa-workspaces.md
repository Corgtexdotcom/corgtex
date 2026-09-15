# Selfserve QA workspaces

`jnj-demo` is public, illustrative, read-only exploration. `corgtex-validation` is private synthetic workflow validation. Never import client data or use customer workspaces for the fixture reset.

Use an explicit release/provisioning job, not web startup. Supply DATABASE_URL through the existing secret reference, QA_EXPECTED_DATABASE_HOST, QA_EXPECTED_DATABASE_NAME, and QA_EXPECTED_DATABASE_SCHEMA matching the verified selfserve database, VALIDATION_BOOTSTRAP_ADMIN_EMAIL, ADMIN_PASSWORD for first creation, QA_VALIDATION_MEMBER_EMAIL, and QA_VALIDATION_MEMBER_PASSWORD. Both validation identities must be distinct, ordinary global users dedicated to this workspace. Passwords belong in secret storage, never command output or committed config.

Run `node scripts/provision-qa-workspaces.mjs` for a read-only target inventory. Run with `--apply` only after target and recovery verification. Existing targets require QA_EXPECTED_DEMO_WORKSPACE_ID and QA_EXPECTED_VALIDATION_WORKSPACE_ID from the reviewed inventory; each standalone fixture seed also requires its existing target ID. Do not enable SEED_RESET_PASSWORDS. The seeds refresh known fixtures and preserve validation and public demo account passwords; fictional demo personas receive random inaccessible passwords and existing demo/persona sessions and reset codes are removed, OAuth/MCP/app tokens and agent credentials are revoked, and demo OAuth apps are disabled; they do not implement a complete wipe of accumulated test records. Archive temporary validation-run records separately using the existing smoke cleanup, preserving reports.

Verify public demo login, ordinary member and admin access, representative workflows, demo API/server-action rejection, and cross-tenant denial. Record workspace IDs, deployed SHA, fixture counts, and browser evidence in ignored artifacts. Repeat provisioning to demonstrate stable workspace IDs and fixture counts.

Grok Bot onboarding, external credentials, schedules, and report-board writes are deferred. Its eventual authority should be restricted to synthetic validation operations and read-only demo exploration.
