# GitHub protection

Keep the repository public for contributions. Restrict updates and merges to
`main` to `beepto-codex`, `puncar-dev`, and `Corgtex-builder`, including for
administrators. Verify the selected identity before GitHub writes.

Require an up-to-date branch, resolved conversations, and passing CI:

- `Lint, Typecheck & Test`
- `Database Sync`
- `Build`
- `Docs Validation`
- `Secret Scan`
- `Client Data Scan`

Do not require a separate PR reviewer or a merge queue. Verify current GitHub
settings after any change; they are authoritative. Do not relax the required checks
or expand merge access to fix a failing check.

Production deployment is separate. Get Puncar's explicit authorization, then use
the approved Azure target and exact build, run preflight, and verify the rollout.
