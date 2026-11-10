# Kiến trúc Hệ thống & Phân tích Kỹ thuật (AI Team Architecture)

Tài liệu này mô tả kiến trúc kỹ thuật của hai thành phần trong dự án **OpenCode AI Development Team**:
1. **Native Desktop Plugin V0.8 (`native-v0.8/`)**
2. **Web Dashboard & MCP Server (`apps/`, `packages/`)**

---

## 1. Kiến trúc Native Desktop Plugin V0.8 (`native-v0.8/`)

### 1.1. Sơ đồ Phân lớp & Ranh giới Tin cậy (Trust Boundaries)

```text
+-------------------------------------------------------------------------+
| Tiến trình Electron Main (OpenCode Desktop 2.2.5 / 2.2.6)               |
|  - gui.tsx (main): Khởi chạy HostOwnerBridge + hộp thoại xác nhận Owner |
|  - host-owner-bridge.mjs: Giữ khóa bí mật Ed25519 trong RAM,            |
|    cấp single-use ticket và ký số executionPolicy                       |
+------------------------------------+------------------------------------+
                                     | UNIX Domain Socket (0600, verify-only)
                                     v
+-------------------------------------------------------------------------+
| Tiến trình Sidecar (OpenCode Plugin Runtime)                            |
|  - index.ts: Đăng ký PilotRPC & công cụ native (team_protocol,          |
|    team_worktree, team_report, team_read_report, team_send, team_inbox) |
|  - official-coordinator.mjs: Quản lý trạng thái nguyên tử (team.json),  |
|    4 nhánh Git worktree (pilot-peer-1..4), và kiểm tra DAG              |
|  - native-peer-adapter.mjs: Kiểm tra chữ ký Ed25519, trần maxCalls,     |
|    maxActive, maxAttemptsPerTask, điều phối prompt & verifyStop         |
+------------------------------------+------------------------------------+
                                     | Bubblewrap (bwrap-v1)
                                     v
+-------------------------------------------------------------------------+
| Worker / Test Sandbox (bwrap-v1)                                        |
|  - --unshare-all --cap-drop ALL --clearenv                              |
|  - Mount chỉ đọc (--ro-bind) worktree, che chắn .git                    |
|  - Cô lập mạng, /home, /tmp, chặn truy cập khóa Owner & pilotStore      |
+-------------------------------------------------------------------------+
```

### 1.2. Vòng đời Nhiệm vụ & Đồ thị Phụ thuộc (DAG Task Lifecycle)

1. **Khởi tạo (`bootstrap`):**
   - Tạo 4 nhánh và 4 thư mục Git worktree độc lập (`pilot-peer-1` .. `pilot-peer-4`) từ commit gốc của dự án.
   - Mỗi Peer gắn với một phiên OpenCode riêng biệt, bị khóa quyền `edit`, `shell`, `subagent` trực tiếp (`PEER_SESSION_PERMISSIONS`).
2. **Kế hoạch & Thảo luận (`ownerPlan` → `propose` → `discuss` → `ready` → `approve`):**
   - Các nhiệm vụ được đề xuất kèm danh sách phụ thuộc (`dependencies`), phạm vi file (`files`), năng lực yêu cầu (`requiredCapabilities`), và lệnh kiểm thử bắt buộc (`requiredChecks`).
   - Sau khi thảo luận đủ số vòng và đóng vòng (`close_round`), Owner phê duyệt kế hoạch (`approve`), cố định mã băm `planDigest`.
3. **Cấp quyền & Thực thi (`admission` → `dispatch` → `worktreeExec`):**
   - `NativePeerAdapter.admission()` xác minh chữ ký số **Ed25519** của `executionPolicy` khớp với `planDigest`, đồng thời kiểm tra hạn mức `maxActive`, `maxAttemptsPerTask`, `maxCalls`.
   - Peer gọi `team_worktree(mode="apply")` để áp dụng thay đổi file vào worktree của mình, chạy `requiredChecks` bên trong sandbox `bwrap-v1`, và tạo commit mới nếu kiểm thử đạt (`exitCode === 0`).
4. **Nộp bài, Chéo kiểm & Hợp nhất (`submit` → `review` → `integrateReviewedTask` → `done`):**
   - Peer nộp báo cáo (`team_report`) chứa mã `sourceCommit` và chuyển trạng thái sang `SUBMITTED`.
   - Một Peer độc lập khác (`reviewer !== assignee`) gọi `team_worktree(mode="verify", sourceCommit)` để chạy lại kiểm thử trong `bwrap-v1`, lập báo cáo kiểm tra và duyệt (`REVIEW`).
   - `integrateReviewedTask()` sử dụng một Git worktree tách rời (detached worktree) để hợp nhất `sourceCommit` vào `baseCommit` sau khi xác thực biên bản review độc lập và vé ủy quyền của Owner, sau đó cập nhật trạng thái `INTEGRATED` → `DONE`.

---

## 2. Kiến trúc Web Dashboard & MCP (`apps/`, `packages/`)

### 2.1. Luồng Điều phối
- **Trình duyệt → Express API (`apps/server`) → SQLite WAL (`.data/team.sqlite`) → Dispatcher → OpenCode V2 Client:** Mỗi vai trò (`admin`, `backend`, `frontend`, `devops`, `qa`) có một phiên làm việc và một Git worktree riêng.
- **Agent → MCP Streamable HTTP (`packages/team-mcp`):** Định danh từng agent ở phía server qua token MCP riêng; đối số công cụ không thể giả mạo danh tính người gửi hoặc dự án.

### 2.2. Các Nguyên tắc An toàn
- **Chỉ lắng nghe cục bộ (`127.0.0.1`):** Kiểm tra `Host`/`Origin`, sử dụng cookie `HttpOnly`/`SameSite`, và không bao giờ trả khóa API của provider về trình duyệt.
- **Khảo sát Chỉ đọc trước khi Code:** Dự án mới bắt đầu bằng một phiên Admin khảo sát chỉ đọc (`survey`), gửi đề xuất qua `team_submit_proposal`, và chờ người dùng phê duyệt phạm vi trước khi tạo phiên lập trình.
- **Kiểm chứng QA & Tích hợp Thủ công:** QA xác minh trên snapshot cố định mã băm SHA-256 thông qua `team_verify_task` trước khi đánh dấu `Done`; việc hợp nhất vào nhánh chính do con người kiểm duyệt.
