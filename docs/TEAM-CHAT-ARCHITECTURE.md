# Team Chat — actual implementation

Browser → authenticated Express API → SQLite → dispatcher → official OpenCode V2 client → distinct session/worktree per role.
Agent → authenticated MCP Streamable HTTP → durable message → recipient queue → recipient real session.
MCP capability identifies agent server-side. Tool arguments cannot impersonate sender/project.

## Boundaries

- Loopback only; Host/Origin checks; HttpOnly SameSite cookie; no provider key in browser.
- SQLite WAL stores projects, tasks, agents, messages, execution logs. Local records table uses JSON payloads; no ORM or migration framework needed yet.
- One active dispatcher per project/role. Distinct worktrees even for Admin and QA. Never modifies canonical checkout automatically.
- Six-hop conversation limit, idempotency keys, three manual attempts max. In-flight state after restart becomes uncertain, never silently replays destructive work.
- Pause stops new dispatch only, does not interrupt running tools. Approvals and shell permissions handled in existing OpenCode Desktop/CLI.
- QA-only Done with evidence. Human integration approval recorded separately. Merge/push/deploy never automatic.
- Live event stream reconnects; execution transcript reconciled after session wait. Event stream has no replay guarantee.
- Group messages dispatch Admin; targeted messages dispatch role; agent group broadcasts do not wake every role, preventing storms.
- MVP project requires existing Git root with HEAD. Arbitrary Git project supported; non-Git folders rejected explicitly.

## Known ceilings

- No automatic cross-worktree merge. Agent reports diff; QA must inspect originating worktree; human reviews and cherry-picks/merges consciously.
- No OS sandbox. Shell runs with user authority after OpenCode approval. Untrusted projects require container/VM before use.
- Backlog quality, review and collaboration depend on model + enabled MCP. No canned responses or synthetic success.
- Evidence is supplied by QA, not independent proof of every acceptance criterion. Human still reviews.
- Model switch currently available after role session exists. Permissions visible in API; editing handled in OpenCode rather than broad privilege switches in dashboard.
- No token-price estimates fabricated. Available actual usage remains in execution logs.
