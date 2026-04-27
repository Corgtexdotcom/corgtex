# Public Docs History Purge Runbook

Use this only after the cleanup PR is merged and merges are frozen. This
rewrites public Git history and requires collaborator coordination.

## Preconditions

- Freeze merges to `main`.
- Announce that collaborators must re-clone or hard-reset/rebase after
  the rewrite.
- Rotate any confirmed real secret before rewriting history.
- Create a private mirror backup before running any filter command.

## Private backup

```bash
mkdir -p ~/private-repo-backups
git clone --mirror git@github.com:Corgtexdotcom/corgtex.git ~/private-repo-backups/corgtex-before-docs-purge.git
```

## Fresh mirror rewrite

Install `git-filter-repo` if needed, then run from a fresh mirror clone.

```bash
git clone --mirror git@github.com:Corgtexdotcom/corgtex.git corgtex-history-purge.git
cd corgtex-history-purge.git

cat > /tmp/corgtex-replace-text.txt <<'EOF'
sk-or-v1-...==><replace-with-provider-api-key>
super_secret_password==><replace-with-bootstrap-admin-password>
changeme_topsecret_production_cookie==><replace-with-32-character-random-secret>
SecurePass!==><replace-with-generated-password>
EOF

git filter-repo --sensitive-data-removal --force \
  --invert-paths \
  --path docs/assets/ \
  --path docs/pr-assets/ \
  --path docs/plans/ \
  --path-glob 'docs/client-readiness-*.md' \
  --path-glob 'docs/*handover*.md' \
  --path-glob 'docs/pilot-*.md' \
  --path docs/partner-analysis/ \
  --path-glob 'docs/future-work*.md' \
  --path-glob 'docs/industrial-*.md' \
  --path docs/slack-app-manifest.yml \
  --replace-text /tmp/corgtex-replace-text.txt
```

## Verify before push

```bash
if git log --all --name-only -- docs | grep -E 'docs/(assets|pr-assets|plans|partner-analysis)|docs/(client-readiness-|pilot-|future-work|industrial-)|handover|slack-app-manifest'; then
  echo "Blocked docs paths are still present in history."
  exit 1
fi
gitleaks git . --redact --verbose
```

## Push rewritten history

```bash
git push --force --mirror origin
```

After the force push, ask collaborators to re-clone or to hard-reset
local branches from the rewritten remote. Do not let old local branches
merge back into `main`; that can reintroduce purged objects.

## GitHub cache and refs

If any removed file contained a real secret or client-sensitive artifact,
open a GitHub Support request after the rewrite to remove cached PR
views and dereference stale pull request refs. GitHub's sensitive-data
removal guidance explicitly calls out PR refs, forks, and cached views
as separate cleanup concerns.
