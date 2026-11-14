# Desktop QA rework acceptance — in progress

- Project: `/home/hulk/aiteam-dev/qa-step6`; `/home/hulk/webqlcv` untouched.
- Team: `team_388d0bb2-176d-4fae-bb13-9a3d91247777`; four real native sessions and four Git worktrees provisioned through Desktop.
- Plan: `plan_42652cbd-dbce-4382-9f46-9ee0a08ffda7`, version 1, Owner approved and discussion closed.
- Desktop verified `WORKTREE AUTHORIZED`; policy: maxActive 4, maxAttemptsPerTask 5, maxCalls 40.
- Owner message `31889a57-90e3-4705-9aec-894f545cf8dc` delivered to all four sessions. Native transcripts show actual protocol calls and durable receipts, not merely sent delivery.
- Initial test instructions incorrectly used unsupported `node --check`. Owner correction sent; persisted tasks use `node --test`.
- Peer proposal after approval correctly rejected with `PROTOCOL_DISCUSSION_LIMIT`. Owner created four tasks through Desktop instead, preserving protocol authorization.
- A: `task_dc640a9a-6640-4646-b811-ec74c4db1bb5`, peer-1, `src/a.mjs`.
- B: `task_fbda75ac-9b91-4c15-9b43-02646ec4df70`, peer-2, `src/b.mjs`, intentional `mul=x+y` defect.
- C: `task_c634014c-330d-4303-ae03-a103178645df`, peer-3, `src/c.mjs`.
- QA: `task_455cbb62-0fba-4fb0-9ecf-e08ce395bc32`, peer-4, `tests/qa.test.mjs`, depends on A/B/C.
- Root cause: 60-second claim lease expired between native model turns (approximately 1–4 minutes). Peer-2 and peer-3 `start`/`renew` returned `PROTOCOL_LEASE_INVALID`; no execution had been admitted.
- Fix: bounded lease increased to 15 minutes. Regression exercises two four-minute model turns, renewal, exact expiry rejection and recovery requiring verified stop for outstanding work.
- Live host confirmed new code without restart: peer-4 protocol `read` returned `policy.leaseMS=900000`; peer-1 obtained a fresh claim under new lease. Peer-3 recovered expired claim through native `reconcile`, not by editing state.
- Latest observed state: A CLAIMED, B CLAIMED with old expired lease, C READY, QA READY (dependencies still gate admission). No final QA pass yet.
- Regression: `npm test` 286 passed, 0 failed; `npm run build` passed.

## Owner-requested pause and targeted routing fix

- Owner requested stopping test before fixing queue fan-out. Desktop disabled collaboration and revoked execution for qa-step6 only.
- Native interrupt with `resume=false` returned `interrupted=true` for all four peer sessions. `/api/session/active` then contained none of those four sessions. Native queued prompts retained, not deleted or replayed.
- Automatic task notifications no longer broadcast review/done to team. Submit/reassign wakes reviewer; rejected review wakes assignee; done wakes only owner of dependent DRAFT/READY task after all dependencies are DONE. Successful reviewer continues integrate/done in same session without extra wake.
- Owner compose defaults to peer-1, not team. Explicit team broadcast and additional @peer mentions remain supported.
- Mention delivery and inbox/receipt now share recipient rules; unrelated peers cannot acknowledge directed messages.
- Regression: `npm test` 288 passed, 0 failed; `npm run build` passed. Checks cover targeted submit/rework, QA waiting for both dependencies, idempotent handoff and tagged receipt authorization.
- Correction after Owner feedback: irrelevant delivery came from test messages explicitly addressed to team, not evidence of a queue-capacity defect. Receipt-gated backpressure was unnecessary and has been removed. Delivery does not wait for model acknowledgement.
- Routing regression tests verify direct messages reach only selected native session, repeated direct messages remain deliverable without receipts, and concurrent dispatchers do not duplicate messages. Explicit broadcast still reaches all intended peers. Tests use mocked native session APIs, not a new live Desktop acceptance run.

Remaining: paused Desktop acceptance must be resumed explicitly, with old queued input reviewed before resume; structured defect report, peer-2 rework, final QA rerun. Desktop E2E is NOT PASS. Commit/push deferred until acceptance result is known.
