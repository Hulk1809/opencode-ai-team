# Directed planning Desktop acceptance — in progress

- Separate canonical project: `/home/hulk/aiteam-dev/qa-directed-plan`, baseline commit `0069e1d` with PLAN.md. Previous qa-step6 remains paused.
- Team: `team_51beae0a-7013-47d0-9aa2-6fd412de0282`; four native sessions/worktrees provisioned through Owner Desktop.
- Shared plan v1 published as reference to PLAN.md; discussion remains open, no Owner approval and no execution authorization.
- Desktop compose verified Peer 1 selected, confirmation dialog verified `To: peer-1`.
- One initial Owner request asks Peer-1 to read PLAN.md, propose four assigned tasks/checks/reviewers/QA dependencies, avoid broadcast, await Owner approval before execution.
- Durable state verified messages: Owner plan record to team (action plan, not dispatched); Owner send to peer-1. Exactly one delivery, peer-1, sent.
- Native transcript check: peer-1 contains one user input; peer-2/3/4 contain zero messages. This proves initial request was not broadcast. Does not yet prove planning or execution.
- First completed model turn: Peer-1 successfully called read on `PLAN.md` and `team_protocol` action read. Tasks still empty at that observation; no repeated Owner prompting sent.
- Peer-1: `ses_e2befe25cffeL6WPcmXgcBCmnM`; peer-2: `ses_e2befe224ffe0JWFDlHTYNURXZ`; peer-3: `ses_e2befe1ecffe8GXHEZh9uVfkHw`; peer-4: `ses_e2befe1b5ffe7DkL4311NhTl4f`.

## Follow-up observation

- Peer-1 proposed all four tasks itself (`proposedBy=peer-1`). Assignments: peer-1/add, peer-2/mul, peer-3/sub, peer-4/QA. Independent reviewers: peer-2, peer-3, peer-4, peer-1 respectively. QA depends on all three implementation task IDs. File scopes and required checks match PLAN.md.
- Peer-1 sent separate handoffs to peer-2/3/4 and notified Owner; no broadcast handoff. Owner approved plan v1 and closed discussion. All tasks remain DRAFT; no execution policy exists.
- Fixed misleading authorization status: missing policy now returns `PEER_WORKTREE_POLICY_REQUIRED` before signature verification. Existing policies still require verified signatures. Regression asserts missing policy never invokes verifier and invalid signatures remain rejected.
- Validation after fix: `npm test` 290/290 passed; `npm run build` passed. Live Desktop loading of this fix not yet verified.
- Desktop continuation blocked by foreground focus: headed type and scoped key presses refused with `target_focus` / `frame_not_active`; all reported `not_delivered`. No keyboard input sent. Session search remains open; no execution authorization attempted.

## Execution authorized; directed start delivered

- Owner Desktop granted execution/integration for this project: maxActive=4, maxAttemptsPerTask=5, maxCalls=40, timeoutMs=900000. Policy binds approved plan v1 and integration capability; no push/deploy or unrestricted shell authority.
- Owner start message `41594569-61b0-4b28-aff8-1ee2a1973526` addressed only to peer-1. Confirmation dialog verified canonical project and `To: peer-1`; durable delivery is sent to peer-1 only.
- Message asks Peer-1 to execute its task, individually coordinate peer-2/3, and keep QA waiting for dependencies DONE. No tasks created by Owner.
- First typing attempt timed out and left partial IME-transformed text in composer, not submitted. Switched to US input, selected/replaced full draft, verified exact field value and confirmation before sending; restored Bamboo afterward. No partial message delivered.
- All tasks still DRAFT immediately after delivery. Native transcript confirms new user input, not yet execution progress.

Pending: targeted execution/review/integration; QA after dependencies. No Owner-created task fallback allowed. Acceptance NOT PASS yet. No commit/push.

## Owner-requested completion check

- Durable state: add SUBMITTED (reviewer peer-2), mul SUBMITTED (reviewer peer-3), sub DONE (reviewer peer-4), QA DRAFT. Execution policy usedCalls=3; collaboration still enabled.
- Native transcripts show peer-2 and peer-3 ended with `finish=error`, `error.type=aborted`, `message=Step interrupted` during pending reviews. Peer-2 completed protocol read/receipt for add; peer-3 read mul submission report. This proves interruption, not its source or a routing failure.
- Native active-session API lists none of the four test peers running. Sent deliveries are not evidence that queued prompts have finished processing.
- Canonical Git contains sub integration: merge 41ec12d, source a9b8826. Direct `node --test src/sub.mjs` passed 1/1. Add/mul are not yet integrated; final math QA has not run.
- Result: 1/4 DONE, not complete. QA remaining DRAFT is consistent with unmet dependencies. Do not declare E2E PASS or commit/push.

## Explicit recovery authorized by Owner

- Native inbox inspection: peer-2 had one pending queue item `msg_c2440dfd2d038a44d03feb2c834ba140`, an existing directed add-review request. Peer-3 inbox was empty. No queued messages deleted or duplicated.
- Updated that peer-2 inbox item's delivery to `steer` through native API; sent one explicit recovery prompt to peer-3 (`msg_1d4de8d4d001cS5LhEOJaasbMU`) to resume mul review using current protocol state. This is manual Owner-authorized recovery, not automatic retry or a clean uninterrupted E2E pass.
- Both native sessions resumed: peer-2 read add report; peer-3 read current protocol state. No Owner task transitions or edits to durable team.json.
- Extended missing-policy regression for undefined state, absent policy, and null policy with real verifier as well as a verifier-call guard. Focused test and build pass. Full regression before that test-only extension: 290/290 pass.
- Existing logs did not establish the source of earlier interruptions. No queue/backpressure change made on speculation.
- Follow-up: both recovered reviewers completed `team_worktree verify` in bwrap-v1 with exitCode=0 and created review reports. Add source d7393bc1995ae7fa9ac1246bfdc274aee45e4c21; mul source 9c91ffdd79d3e0e5a01037aef7647eb2358d3d16; verified base 41ec12d34bd0fb8ef72661440f5b28beaa1226f8. Both sessions still running at observation; transitions/integration pending.
- Full regression after test extension: 290/290 passed; build passed.
- Next observation: add and mul advanced to REVIEW through their independent reviewers; sub remains DONE, QA DRAFT. Native wait for peer-2 moved to background at Owner request; no completion claimed while wait remains pending.
- Re-ran plugin regression and build while native review/integration continued: both commands exited 0. Canonical final QA still pending.
- After peer-2 wait completion: add/mul/sub all DONE. Final dependency DONE generated targeted handoff to peer-4 automatically; QA advanced from DRAFT to RUNNING without Owner creating or transitioning tasks.
- Peer-4 `team_worktree apply` used bwrap-v1, base 227d30b22325bac3163d4045188de101361a42b4, QA source fead5e0f54d564a55137956103513f579604898a. `node --test tests/math.test.mjs` passed 6/6 (three imported module self-tests plus three QA tests); report created. Pending QA submission and independent peer-1 review/integration. Native peer-4 wait started in background.
- Peer-4 wait completed: QA SUBMITTED; automatic directed handoff reached reviewer peer-1. Peer-1 read current protocol state, acknowledged handoff and read QA report. Peer-1 wait started in background; final review/integration and canonical test pending.

## Final result: directed workflow completed with explicit recovery

- Peer-1 wait command returned CLI `TimeoutError`; subsequent durable inspection proved all four tasks DONE. A wait transport timeout is not task failure.
- Independent reviewers verified: add/peer-2, mul/peer-3, sub/peer-4, QA/peer-1; no assignee reviewed own task. All tasks proposed by peer-1; execution usedCalls=4.
- Peer-1 verified QA source fead5e0f54d564a55137956103513f579604898a using bwrap-v1: 6/6 pass; created review report, reviewed, integrated, marked DONE and notified Owner.
- Canonical HEAD bf40ea2 integrates QA; prior merges cb3751c (add), 227d30b (mul), 41ec12d (sub). `git status --short` empty. Canonical `node --test tests/math.test.mjs` rerun: 6 tests, 6 pass, 0 fail.
- Plugin regression: 290/290 pass; build passed. Missing-policy classification fix covered by regression; no speculative queue changes.
- Verdict: requested plan-file → directed Peer-1 planning → per-peer execution → independent review/integration → dependency-gated QA completed. This run required explicit recovery of two interrupted reviewer sessions; NOT evidence of unattended interruption recovery or an uninterrupted run.
- Structured defect/rework/final QA rerun acceptance remains separate and unproven by this all-green math plan. Plugin publication commit/push not performed; test-project local commits above are protocol-generated evidence only.
