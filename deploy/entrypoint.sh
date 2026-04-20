#!/bin/sh
set -e

echo "=== entrypoint.sh ==="
# Execute the node script directly with an absolute path as instructed in AGENTS.md
exec node /app/scripts/start-web.mjs
