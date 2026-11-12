# Model recovery — P0 partial

## Further debug: activity and draft refresh

`selectModel` now rejects missing/null/array activity results with `MODEL_SESSION_ACTIVITY_UNKNOWN`, rather than assuming idle. An own activity-map key, even with null value, queues instead of switching. Selector draft reset uses Solid `on` with serialized session/model identity; unchanged polling snapshots and dependent catalog/variant reads no longer reset user selection. Preference metadata is not treated as a model selection fallback.

Added runnable regression for unknown activity, busy null entry, injected `switchModel` error `429 quota exhausted`, blocked receipt, explicit successful retry and unchanged outstanding task. This is adapter failure injection, NOT a real provider-quota test or proof that model inference succeeds. Suite 282/282 passed; build passed (`/tmp/opencode/model-debug-tests.log`). Installed with backup `.backups/model-debug-20261112T124356` and reloaded.

Desktop selected low-model draft without Apply; subsequent full snapshot remained PENDING (`/tmp/opencode/model-draft-refresh.json`). Cancel left durable medium Gemini, synchronized composer, no queued selection and all five task states unchanged. Active-turn immediate interrupt/change is still not implemented; current busy behavior remains explicit queue. No live quota failure or model prompt was triggered.

## Composer synchronization: Desktop verified

Opened existing Peer 1 tab; native composer displayed `9Router / ag/gemini-3.8-flash-medium`. Removed task-admission guard from `selectCurrentComposer`: model configuration checks native active turns and session/project/workspace/agent binding, not outstanding tasks. Regression verifies idle composer selection with own outstanding task; active and unknown activity still reject. Primary selector now allows backend busy queue; both queue readbacks require matching requestID.

Applied existing Gemini selection from Peer 1 selector. Desktop displayed `SYNCHRONIZED` and `Session API & Native Composer đã đồng bộ`. Durable preference version 5 and receipt `model_receipt_5d35a5c3-2b34-45f7-b1ab-fd85a6f2e66a` record `composerStatus:SYNCHRONIZED`, `executionAuthorized:false`, verified at `2026-11-12T02:35:46.206Z`. Location reload preserved composer Gemini and durable synchronized status. B remained outstanding; no prompt sent, no task restarted.

Evidence: `/tmp/opencode/model-composer-applied.json`, `/tmp/opencode/model-composer-reloaded.json`. Full suite 281/281 and build passed; test log `/tmp/opencode/model-composer-tests.log`. Local install backup `.backups/model-composer-20261112T093459`. Provider quota recovery and active-turn immediate interruption remain unverified/unimplemented respectively. Changes not yet pushed.

## Immediate idle switch: Desktop verified

User requested immediate change, not queued selection. Model switching now uses native active-turn state, not outstanding task state. Task stop proof remains required for task recovery/execution, not session model configuration. Active turns still queue; no forced interruption added.

Live Desktop selected Gemini for idle Peer 1 and clicked Apply. Native snapshot displayed `Current: taile/ag/gemini-3.8-flash-medium · medium` and `APPLIED`. Durable receipt `model_receipt_5273d90d-f47e-4a94-97a5-d0996316f847`, request `d78ac27c-5506-410c-92fd-a90c767b7867`, confirms Claude to Gemini; queued model cleared. B remained outstanding. Composer verification still PENDING; no prompt or execution started. Full suite 281/281 passed (`/tmp/opencode/model-immediate-tests.log`), build passed. Installed backup `.backups/model-immediate-20261112T092051`, reload completed.

Desktop also caught a real bug in initial queue UI: backend saved queued model but primary selector checked only native readback and showed MODEL_READBACK_MISMATCH. Primary selector now checks matching queued requestID before applied-model readback.

The following notes describe earlier queue-only iteration, not current idle-switch behavior.

- Member model selector no longer disables Apply merely because target is busy. Backend validates Owner ticket, model catalog, generation, session binding and expected native model as before.
- Busy target persists `queuedModel` without calling native `switchModel`, changing execution identity, starting a model or releasing task ownership. Safe Apply remains explicit, verifies native readback, then clears queued selection.
- Outstanding task belonging to another Peer no longer blocks target's presentation guard.
- UI distinguishes queued selection from applied native model and offers selecting saved model for later Apply.
- `npm run build` passed; `npm test` passed 281/281, including updated busy-session queue and independent-Peer regressions. Log: `/tmp/opencode/model-queue-tests.log`.
- Installed local with backup `.backups/model-queue-20261112T090557`; location reload returned exit 0. Desktop inspection did not yet verify selector or complete Owner queue/apply flow. No actual exhausted-quota provider test, automatic fallback or automatic queued-model application claimed.
- Remaining P0: live queue/apply verification, provider-error recovery, concurrency hardening and alignment of other routing controls. B remains outstanding; queued selection does not unblock B execution.
