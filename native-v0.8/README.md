# AI Team V0.8 — development source for review

Snapshot source hiện tại, tách khỏi app legacy tại repository root. Chưa phải bản release/install được xác nhận. Package metadata vẫn là `0.3.0`; V0.8 là tên milestone development, không phải SDK version.

## Phạm vi và trạng thái thật

- Kiến trúc: native OpenCode plugin + Team RPC + native MCP. Không thay app legacy bằng bản này.
- Owner Chat: gửi text tới Admin đã đăng ký, đọc native transcript/tool projection; chưa xác nhận native end-to-end.
- Public mutations không có trusted caller phải fail closed; không dùng JSON sessionID/role/projectID làm authorization.
- Peer cross-worktree **BLOCKED**: global KV chia sẻ data không bảo đảm queue serialization. Mỗi `TeamRoom` có mutex riêng; hai instances cùng read/modify/write có thể mất message.
- Reviewed host source/SDK: **2.2.0**. Metadata Desktop và bundled CLI tại máy development: **2.2.5**. Running backend version **UNKNOWN**; chưa chứng minh compatibility.
- Chưa patch host, install/reload plugin hoặc chạy native live acceptance. `ACTIVATION_READY=false`, `INSTALL_READY=NO`; autonomous production deployment **BLOCKED**.

## Điểm cần AI/người review kiểm tra

1. `src/native-caller.mjs`, `src/index.ts`, `src/rpc.ts`: trusted native caller, registry/project/location checks, public RPC fail-closed.
2. `src/room.mjs`: whole-room read/modify/write, per-instance locks, queue claims, dedup/retry, restart/owner-loss. Không bỏ Location guard chỉ vì đọc được shared KV.
3. `src/native-owner.mjs`, `src/gui.tsx`: native delivery/transcript, deadlines, manual retry, stale state, redaction. Concurrent prompt-response causality chưa có parent association đáng tin cậy.
4. Minimal supported canonical routing giữ nguyên existing sessions/worktrees. Public 2.2.0 API đã đọc chưa cho canonical plugin handler invocation; cần review host contract trước quyết định patch.

## Kiểm tra source

Dependencies khai báo trong `package.json`/`package-lock.json`; không kèm `node_modules` hoặc build output. Build dùng TypeScript và Vite:

```sh
npm run build
```

`npm test` chạy toàn bộ test files, gồm tests tạo child processes và fault/crash fixtures. Không chạy trên shared runtime khi chưa review. Safe subset tại thời điểm publication loại bốn files sau:

- `tests/broker-lock.test.mjs`
- `tests/broker-operations.test.mjs`
- `tests/operation-http.test.mjs`
- `tests/writer-recovery.test.mjs`

Fixture/test PASS không đồng nghĩa native/live PASS. Xem `REVIEW-CHECKS.md` cho kết quả publication thực chạy.

## Nội dung không public

Không kèm credentials, `.env`, runtime/session/history data, local evidence logs, dependencies, downloaded OpenCode host checkout hoặc `.isolated/`. `tests/fixtures/` chỉ là source fixtures, không phải dữ liệu phiên làm việc thật. Không chạy installer, service, live agent hoặc deploy chỉ để review snapshot.
