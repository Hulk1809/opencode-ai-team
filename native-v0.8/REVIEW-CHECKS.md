# Publication checks

- 107 source/test/script/config files copied byte-for-byte from current development snapshot; SHA256 manifest in `SOURCE-SHA256.json`.
- Safe subset: **130/130 PASS**, rerun before publication with existing development dependencies. Excluded `broker-lock.test.mjs`, `broker-operations.test.mjs`, `operation-http.test.mjs`, `writer-recovery.test.mjs` because they kill child processes. Full `npm test`: **NOT RUN**.
- `npm run build`: **PASS**, TypeScript noEmit + Vite, run against byte-identical development source. Fresh dependency install/build inside published folder: **NOT RUN**; no dependencies installed for publication.
- Legacy root tests/build: **NOT RUN**, legacy source unchanged except README link.
- Native/live acceptance, original sessions, restart/queue-owner handoff: **NOT RUN**. Fixture checks do not establish native compatibility or peer routing safety.
- Publication contains source fixtures, not local runtime/session state. Dependencies, build output, host source, local evidence reports/logs and `.isolated/` excluded.
- Automated credential-pattern scan is a limited check, not proof that every possible secret format is absent. No matching private key, GitHub token, API key or long native session ID found in copied files.

`ACTIVATION_READY=false`; `INSTALL_READY=NO`; peer cross-worktree and autonomous production deployment **BLOCKED**.
