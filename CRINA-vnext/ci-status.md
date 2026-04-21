# CI Status for Corgtexdotcom Repositories

## Corgtexdotcom/corgtex
- **Setup:** A comprehensive GitHub Actions workflow (`ci.yml`) is present. It includes linting, typechecking, tests, PR docs validation, and a `smoke-prod` test for the `main` branch.
- **Issues:**
  1. **Failing `main` Branch Pushes:** The `smoke-prod` job fails because it cannot connect to the database. The environment variable `PRODUCTION_DATABASE_URL` is resolving to an empty string. You need to configure the following **Repository Secrets** in GitHub:
     - `PRODUCTION_DATABASE_URL`
     - `ADMIN_EMAIL`
     - `ADMIN_PASSWORD`
  2. **Typechecking Failures on PRs:** The PRs for `feature/circles-graph` (and downstream `fix-chat-drawer-url-hijack`) are failing during the `npm run typecheck` step. The `CircleGraph.tsx` component is causing errors (e.g., `Cannon find module '@xyflow/react'` and `'dagre'`), indicating these dependencies might are missing from `package.json` or not installed correctly.

## Corgtexdotcom/deploy-crina
- **Setup:** There are currently **no GitHub Action workflows** configured for this repository (the `.github/workflows` directory does not exist).
- **Recommendation:** Since this repository contains deployment configurations and Dockerfiles, you might not need a full suite, but adding a basic workflow to check the Dockerfile syntax or bash scripts (via `shellcheck`) could be beneficial.

