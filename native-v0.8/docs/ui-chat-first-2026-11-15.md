# Chat-first UI verification — 2026-11-15

Scope: presentation only. Owner IPC, approval/signature checks, recipient routing, backend lifecycle and 2-second polling unchanged. No dependencies added.

- Header trimmed; execution controls and diagnostics use native details/summary. Peer model/session actions remain in peer details. Overview defaults closed and stacks below chat on narrow panels instead of disappearing.
- Messages retain explicit recipient; grouping requires same sender AND recipient. Delivery diagnostics moved to Activity & Security.
- Local build and 291/291 regression tests passed. Production GUI bundle: 211.57 → 211.34 kB (gzip 58.30 → 58.19 kB).

## Browser checks and measurements

Actual PilotPane/SafeReport/PilotRouting components rendered in headless Chromium, with mocked host SDK, static snapshot and disabled mutation methods. Same fixture: four idle peers, no tasks, 100 messages. This is component integration evidence, not a live Desktop reload or real execution authorization test.

At 1200×900, comparing remote baseline with changed source:

| Metric | Before | After |
| --- | ---: | ---: |
| Chat width | 955 px | 1178 px |
| Message stream height | 394 px | 437 px |
| DOM elements | 1507 | 1445 |
| Main-thread TaskDuration during 5 s idle | 3.535 ms | 3.161 ms |
| ScriptDuration during 5 s idle | 0.552 ms | 0.598 ms |
| JS heap used (not forced GC) | 9,356,792 bytes | 9,307,668 bytes |

Single samples from development renderer: CPU and heap figures are noisy; no claim of CPU improvement, FPS improvement or whole-Desktop memory reduction.

Assertions passed: no document horizontal overflow at 1200/700/375 px; Overview opens at all three widths; routing opens/closes; peer model details open/close; execution grant button remains disabled without approved plan; no uncaught JavaScript errors. Screenshots visually inspected at 375 px. Narrow layout keeps composer visible but leaves less message height; no special mobile redesign included.

Temporary harness and raw measurements: `/tmp/opencode/ui-bench/`, `/tmp/opencode/ui-bench-results.json`; screenshots `/tmp/opencode/ui-after-{1200,700,375}.png`. These are local temporary evidence, not repository fixtures. Runnable repository guard: `node --test tests/b31-compact-ui.test.mjs tests/pilot-ui.test.mjs`.
