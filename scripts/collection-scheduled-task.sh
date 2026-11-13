#!/bin/sh
# Portable cron entry; no installation and no login prompts. Preview is the default.
# NODE_BINARY may be an absolute executable path when cron has a minimal PATH.
set -eu
workspace=$(CDPATH= cd "$(dirname "$0")/.." && pwd -P)
cd "$workspace"
node_binary=${NODE_BINARY:-node}
exec "$node_binary" "$workspace/scripts/collect-task.ts" --backend cron "$@"
