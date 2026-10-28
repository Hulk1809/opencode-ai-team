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
- QA verification references real completed shell tool, exit 0, exact author workdir, timestamp after snapshot and SHA256 digest. Still not proof that test command covers every acceptance criterion. Human reviews test quality.
- Model switch currently available after role session exists. Permissions visible in API; editing handled in OpenCode rather than broad privilege switches in dashboard.
- No token-price estimates fabricated. Available actual usage remains in execution logs.

## Reliability update

- New projects queue one real Admin read-only survey automatically. Survey Admin denies edit/shell/external directory/subagent; MCP coding dispatch denied until versioned human approval. Project creation writes only orchestration state and agent infrastructure, not source edits.
- Admin submits structured proposal using `team_submit_proposal`; browser approves explicit goal, budget acknowledgement and concurrency. Budget is not enforced monetary limit; pricing not invented.
- One session per role maximum. Coding sessions created on demand only for approved roles, bounded concurrency. Legacy projects preserve prior behavior.

- Ubuntu user service, restart on failure; no global daemon or public listener.
- Health reconciles existing sessions and pending approvals; isolates per-agent failures. Uncertain deliveries remain manual, never silently re-prompt.
- Explicit task dispatch records message ID and bounded attempts. Dependency execution requires human integration attestation, not QA Done alone.
- Review snapshots support staged new files, reject unstaged untracked files, exclude managed MCP config. Stale snapshot cannot be approved.
- Approved patch downloads only. Integration attestation checks commit ancestry; does not apply patch, merge, push or prove patch equivalence.
- New MCP tools: `team_execute_task`, `team_verify_task`. QA bug creation uses existing create-task + execute-task flow; live multi-cycle QA bug discovery remains unverified.
