#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]; then
  echo 'Cần Node.js 24 trở lên.' >&2
  exit 1
fi
if [ ! -d node_modules ]; then npm ci; fi
npm run build
exec node --env-file-if-exists=.env --import tsx apps/server/src/index.ts
