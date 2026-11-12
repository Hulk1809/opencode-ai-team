# Desktop recovery evidence

- Signature readback before renewal: `PEER_NATIVE_POLICY_SIGNATURE_INVALID`.
- Snapshot now exposes verified `executionAuthorization`; UI no longer infers authorization from policy presence.
- Owner Desktop renewal completed; signature verified and UI displayed `WORKTREE AUTHORIZED`. Existing budget stayed `usedCalls=2` (maxCalls=40).
- Recipient dropdown reproduced invalid selection. Replaced with explicit pressed-state buttons; validation retained.
- Live Owner message `1168fb73-18f6-4d7d-8609-e02bba7b87de`, request `41164936-52d6-4f67-a177-5d60efee6278`, persisted with `to=team`. Four session deliveries recorded `sent`.
- Peer 1 replied, recognized renewed grant and coordinated C directly with Peer 2.
- C reconciled expired claim, claimed and started. First attempt failed; trusted `worktree-failed` receipt recorded, no false submit/DONE.
- Peer 1 initially sent wrong component export (`renderBoard`). Owner correction `contract-correction-0033` persisted and delivered to all four sessions; Peer 1 relayed correct `renderKanban(container,tasks,onMove)` contract to Peer 2.

## C recovery, independent review and canonical completion

- C recovered through existing protocol and bounded start, without state-file edits. Successful scoped source: `405ca364c8707d2d7601af635053fbdb8b979d7b`; execution `execution_b9d7993c-27df-4c0a-b083-3d3ac7b12c11`, generation 5, work revision 3. Submission report: `report_49a9c3380a7c571fe5772308f8919b061564086acceeac9ea4c07922985b384b`.
- Reviewer first reported only wrapper command `team_worktree verify ...`; protocol correctly rejected missing exact required checks. Diagnostic now names missing checks; read response explains copying exact returned command rows. Regression verifies wrapper report rejection leaves task SUBMITTED.
- Owner message `df7c5df4-a14a-4730-a2a9-ec239b6694a1` persisted, delivered to all four sessions. Reviewer reran checks and created `report_a43d5c4d7ed7815453f79fa1d5be136f49913d5aab111c3643c808ae7c46150a`.
- C reached `DONE` through independent review/integrate/done. Receipt `integration_8947462e-e3f7-45ec-b9d8-e4c1871f599c`: canonicalCommit=resultCommit=`aa61b4e90e994c0bb30d06a84ecd5febcecf3d56`. All three required checks exited 0 in merge sandbox; README command ran A's 12 tests, all passed. Earlier standalone C worktree had 0 tests; that result was not treated as A regression evidence.
- Full plugin suite 281/281 passed (`/tmp/opencode/report-diagnostic-tests.log`); build passed. Updated live protocol/coordinator with backup `.backups/report-diagnostic-20261112T005344`, then location reload. Runner diagnostic installed earlier at `.backups/runner-diagnostic-20261112T005020`.
- Remaining: B lacks trusted stop proof; I/R pending; verify-only lifecycle and final browser E2E/screenshot coverage remain unfinished. Earlier limit statements describe earlier snapshots, not current C status. No push/deploy.

Follow-up: `reconcile` now permits early recovery of a failed scoped attempt only for its current assignee, with matching execution identity, failed stop receipt and independently verified stop predicate. Other peers, successful attempts and unproven stops remain denied. Recovery increments ownership/work revision; next `start` still consumes bounded budget. Protocol regression 10/10 passed; full suite 281/281 passed; build passed. Installed with backup `.backups/failed-recovery-20261112T004024` and location reload. Desktop notification draft was NOT sent: physical input refused `not_active` before delivery.

Earlier snapshot: B old attempt lacked trusted stop proof; C was not yet accepted, I/R pending. Current C completion is documented above. Session delivery is not proof of task completion. No state-file edits or check removal. No website deployment; subsequent source publication to GitHub is separate from these live tests.

Checks: `npm run build` passed; `npm test` passed 280/280 before protocol instruction update. Final suite output: `/tmp/opencode/live-recovery-update-tests.log`.
