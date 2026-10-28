# Phase 1 — audit 2026-10-28

- Original working directory: `/home/hulk/Downloads/Xây dựng team code AI_files`.
- Not a Git repository; files are downloaded CSS/JS/page resources. Left unchanged.
- `AGENTS.md`, `opencode.jsonc`, `.opencode/agents`, `docs/TEAM-CHAT-ARCHITECTURE.md` not found in original directory or search within parent depth 3. Starter cannot be audited without its actual path.
- Node `v24.21.0`, npm `11.19.0`; `opencode` absent from PATH.
- Desktop process uses shared service launched by `/home/hulk/.config/ai.opencode.desktop/cli/2.1.4-x64/opencode-cli`.
- Official `Service.discover()` and authenticated `client.server.info()` report `2.1.4`, loopback `http://127.0.0.1:49374`.
- SDK initially latest `2.2.0`; pinned to installed-service-compatible `2.1.4`. Live `/openapi.json` confirmed session create, prompt, wait, messages, event routes. Real session creation confirmed.
- V2 sources: https://opencode.ai/v2/docs/config ; /permissions ; /api ; /build/client . No core Desktop changes.
- Default model data includes provider settings/secrets. Never expose raw model records; dashboard API strips settings/headers/credentials.

No provider credentials copied into project. Existing OpenCode DB/config not changed.
