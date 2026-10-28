#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/ai-team.service"
case "${1:-status}" in
  install)
    cd "$root"
    npm run build
    mkdir -p "$(dirname "$unit")"
    if [ -e "$unit" ]; then
      echo "Service đã tồn tại: $unit. Không ghi đè; dùng systemctl --user cat ai-team." >&2
      exit 1
    fi
    ROOT="$root" NODE="$(command -v node)" UNIT="$unit" node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
writeFileSync(process.env.UNIT, `[Unit]
Description=Local AI Team dashboard
After=network.target
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=${process.env.ROOT.replaceAll('%', '%%')}
ExecStart=${quote(process.env.NODE)} --env-file-if-exists=.env --import tsx apps/server/src/index.ts
Restart=on-failure
RestartSec=3
TimeoutStopSec=15
UMask=0077

[Install]
WantedBy=default.target
`, { mode: 0o600, flag: 'wx' });
JS
    systemctl --user daemon-reload
    systemctl --user enable --now ai-team.service
    ;;
  start|stop|restart|status) systemctl --user "${1:-status}" ai-team.service ;;
  logs) journalctl --user -u ai-team.service -n 80 --no-pager ;;
  *) echo 'Usage: bash scripts/service.sh {install|start|stop|restart|status|logs}' >&2; exit 1 ;;
esac
