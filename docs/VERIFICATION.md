# Kết quả chạy thật

## Project onboarding update

- Added automatic read-only survey queue for new projects, structured proposal MCP, versioned human approval UI/API, approved-role checks and concurrency limit.
- New `tests/planning.test.ts` uses real Git fixture: no coding agent before approval, stale-version denial, duplicate role/count validation, approved-role enforcement and single approval message.
- `tests/planning-live.ts` is opt-in real model survey; does not approve coding. Result recorded separately after execution.
- Live fixture `60db3f43-67fa-48ff-9c89-5bc1575abc2b`: real Admin session `ses_e7ea9b21cffema5glqE3VHlSoG` read README, submitted proposal v1 with findings/risks/questions and role recommendations through MCP. Final state `awaiting_approval`; only Admin session existed, no coding roles created. Initial script timed out after 120 seconds; session completed afterward, final API state verified separately. Increased script timeout to 300 seconds; fresh rerun not yet performed.
- Final checks: `TEAM_HTTP_TEST=1 npm test` 7 passed, TypeScript + production build passed, production audit 0 vulnerabilities.
- Earlier `tests/live.ts` and `tests/orchestrator-live.ts` predate onboarding approval requirement; fresh projects now need approval before those direct coding scenarios. Prior successful results describe older behavior, not verification of new onboarding.

## Reliability update — 2026-10-28

- Installed Ubuntu `systemd --user` service locally, status active. Existing foreground dashboard was stopped, shared OpenCode service untouched.
- Real restart under service: persisted ID verification still 3 projects, 1 task, 46 messages.
- Controlled crash test: SIGKILL only dashboard service main process; systemd restarted automatically (`NRestarts=1`, new PID), dashboard HTTP 200. Shared OpenCode service not interrupted.
- `TEAM_HTTP_TEST=1 npm test`: 6 passed, 0 failed at initial update check; includes task dispatch intent/dependency/retry controls and actual Git snapshot stale-approval tests.
- TypeScript + frontend production build passed with new task action controls.
- Added CI workflow (not yet pushed or run on GitHub).
- New QA evidence validation and task API require fresh end-to-end model verification. Old fixture Done evidence predates new verification schema and cannot be newly approved without rerun.
- Browser automated click-through, fresh multi-turn QA defect cycle, simultaneous CLI/Desktop control and automatic integration remain incomplete. No claim these are done.

## Đạt

- OpenCode service `2.1.4`, SDK `2.1.4`, discovery + authenticated info + real session creation.
- `TEAM_HTTP_TEST=1 npm test`: **4 passed, 0 failed**. Bao gồm frontend routing helper, SQLite invariants/reopen, model parsing, HTTP auth/Origin/MCP guards.
- `npm run build`: TypeScript + Vite production đạt, 31 modules.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `tests/live.ts` chạy lại exit 0: project `663bddca-3d3e-408e-ad95-20d33419521a`, Backend `ses_e816c9557ffe7yC7La9m6ooDJ6`, Frontend `ses_e816c6a52ffeUOZWcxEEs6wVl6`; file thật `integration-proof.txt`; MCP reply thật `FRONTEND_RECEIVED`.
- Admin fixture project `943de475-3773-4403-a8bf-1bb94dbc8255`: Admin `ses_e816d925affezmX3uzJuLxPpLV` tự tạo task `a869a805-afda-4c21-a80b-74e83f6a2a02`, priority high, tiêu chí test cụ thể; giao Backend `ses_e816d125dffeHSLMokUe39LGYR`.
- Backend sửa thật `sum.mjs` từ `a-b` thành `a+b`, gửi QA qua `team_request_review`.
- QA `ses_e816c6a55ffeynYfE2xs41aMiI` đọc bản gốc/bản sửa, chạy `node sum.test.mjs` trong worktree Backend: `sum test passed`, exit 0. QA cập nhật Done kèm evidence qua MCP. Human approval vẫn false; không merge.
- Restart process server thật: capture rồi SIGTERM process vừa khởi động, start lại, verify toàn bộ ID: **3 projects, 1 task, 46 messages**, không mất dữ liệu. Không restart shared OpenCode service.
- Browser mở dashboard thật, tải màn hình login tiếng Việt từ localhost.

## Lỗi test và cách diễn giải

- Live test đầu tiên lỗi ở bước chẩn đoán permission không cần thiết sau khi file/message bus đã chạy. Đã bỏ bước, chạy lại exit 0.
- `tests/orchestrator-live.ts` timeout tại 180 giây và exit 1 vì QA chờ human approval. Không chuyển giả Done để làm test xanh. Sau đó duyệt từng permission một lần: đọc fixture, `node sum.test.mjs`, `git diff` cụ thể; phiên tiếp tục, test exit 0, QA ghi Done. Script fresh-run vẫn cần người duyệt đủ nhanh hoặc tăng timeout.
- Dashboard ban đầu có thể hiện chat rỗng từ assistant tool-only steps. Đã sửa không tạo chat cho text rỗng; giữ nguyên record kiểm thử cũ, không xóa lịch sử.

## Chưa xác nhận / chưa đủ tiêu chí

- Browser chưa có automated click-through E2E toàn bộ luồng tạo project; API tạo project và UI login đã kiểm tra riêng.
- Chưa kiểm thử DevOps coding thực tế, nhiều coding agent sửa task đồng thời, hoặc một role điều khiển qua CLI trong lúc role khác dùng Desktop.
- Chưa kiểm chứng QA tự phát hiện bug mới rồi giao sửa và chạy lại qua nhiều lượt; fixture bug do yêu cầu người dùng cung cấp, QA xác minh sau sửa.
- Chưa có automatic merge/integration, permission editor, chuẩn hóa token/cost dashboard, hoặc sandbox.
- Starter gốc thiếu tại đường dẫn được cung cấp, nên không thể xác nhận bộ đó được nhận diện.

Fixture source nằm `/tmp/opencode/`; worktrees + lịch sử `.data/` giữ lại để kiểm tra. Không xóa tự động.
