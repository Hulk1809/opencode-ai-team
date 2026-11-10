# OpenCode AI Team — Native Plugin V0.8

Plugin điều phối đội ngũ AI đa tác tử (4-Peer Git Worktree Collaboration) tích hợp trực tiếp vào **OpenCode V2 Desktop (`2.2.5` / `2.2.6`)** và Sidecar. Hỗ trợ lập kế hoạch có kiểm duyệt của Owner, thảo luận nhiều vòng, phân tách Git worktree theo từng Peer, thực thi kiểm thử trong sandbox `bwrap-v1` (Bubblewrap), chéo kiểm (cross-review) độc lập, và hợp nhất (merge) có kiểm soát.

---

## 1. Phân tích Kiến trúc & Mã nguồn (`src/`)

Dự án được thiết kế theo mô hình **Defense-in-Depth (Phòng thủ nhiều lớp)** với ranh giới quyền hạn tách biệt giữa **Electron Main (Owner Authority)**, **Sidecar Plugin Coordinator**, và **Bubblewrap Worker Sandbox (`bwrap-v1`)**.

### 1.1. Các Module Cốt lõi

| File | Vai trò & Chức năng chính |
| :--- | :--- |
| `src/index.ts` | Điểm vào (Entrypoint) của plugin trên Sidecar. Chọn engine qua `selectEngine()`, đăng ký các công cụ native (`team_*`), và mở giao diện RPC (`PilotRPC`) với kiểm tra `verifyPatchedSidecarBoundary` + `verifyHostOwnerTicket`. |
| `src/gui.tsx` | Giao diện SolidJS trên OpenCode Desktop và hàm `main(ctx)` chạy trong tiến trình Electron `main`. Tự động khởi chạy `startHostOwnerBridge` và đăng ký hộp thoại xác nhận gốc của Owner (`registerPilotOwner`). |
| `src/official-coordinator.mjs` | Bộ điều phối trạng thái trung tâm (`OfficialCoordinator`). Quản lý lưu trữ nguyên tử (`team.json` kèm khóa `.lock` và chống ghi đè `fsync`), khởi tạo 4 Peer session + 4 Git worktree (`pilot-peer-1..4`), kiểm tra quy trình thảo luận/duyệt kế hoạch, và chạy kiểm thử trong sandbox `bwrap-v1` (`runInBwrapSandbox`). |
| `src/host-owner-bridge.mjs` | Cầu nối xác thực quyền Owner (`HostOwnerBridge`) chạy trong RAM của Electron `main`. Giữ khóa bí mật **Ed25519** chỉ trong bộ nhớ `main`, phát hành ticket dùng một lần (`issueOwnerTicket`) gắn với `window`, `projectID`, `teamID`, `planDigest`, `taskID`, `sessionID`, `model`, `budget` và ký số chính sách thực thi (`signExecutionPolicy`). |
| `src/native-peer-adapter.mjs` | Bộ điều hợp thực thi phiên gốc (`NativePeerAdapter`). Kiểm tra cổng `admission()` (chữ ký Ed25519 của `executionPolicy`, `maxActive`, `maxAttemptsPerTask`, `maxCalls`), gửi prompt tới session của Peer (`dispatch`), đồng bộ kết quả (`reconcile`), và xác minh dừng an toàn (`verifyStop`). |
| `src/peer-protocol.mjs` | Máy trạng thái giao thức nhiệm vụ (`PROPOSED` → `READY` → `CLAIMED` → `RUNNING` → `SUBMITTED` → `REVIEW` → `INTEGRATED` → `DONE`). Chặn nhận việc khi các task phụ thuộc (DAG dependencies) chưa `DONE` và buộc người review phải khác người thực thi. |
| `src/peer-integration.mjs` | Hợp nhất code an toàn (`integrateReviewedTask`). Sử dụng Git worktree tách rời (detached worktree) để kiểm tra khả năng merge sạch từ `sourceCommit` vào `baseCommit` sau khi có biên bản review độc lập và vé ủy quyền của Owner. |
| `src/peer-native.mjs` | Kiểm tra ràng buộc phiên native (`verifyNativeBinding`), yêu cầu hủy thực thi (`requestCancellation`), và chứng minh trạng thái dừng (`verifyExecutionStop` với biên nhận `stop:<execID>:<subID>:<terminalID>`). |
| `src/pilot-reports.mjs` | Quản lý đọc/ghi báo cáo Markdown (`team_report`, `team_read_report`) kèm kiểm tra toàn vẹn băm SHA-256 chống giả mạo. |
| `src/pilot-pane.tsx` | Giao diện điều khiển trung tâm cho Owner: theo dõi 4 Peer card, đổi model theo từng Peer (CAS + đồng bộ Composer), quản lý `Team Chat`, `Plan`, `Tasks`, `Reports`, và `Activity & Security`. |

### 1.2. Cơ chế Bảo mật & Cô lập (`bwrap-v1`)

1. **Quyền Session Peer (`PEER_SESSION_PERMISSIONS`):**
   - Mọi session Peer bị từ chối trực tiếp các công cụ `edit`, `shell`, `subagent` không kiểm soát (`effect: 'deny'`).
   - Peer chỉ có thể ghi file và chạy lệnh kiểm thử đã đăng ký trong `requiredChecks` thông qua công cụ `team_worktree` của Coordinator.
2. **Sandbox Bubblewrap (`runInBwrapSandbox`):**
   - Thực thi với `--unshare-all --die-with-parent --new-session --cap-drop ALL --clearenv`.
   - Mount hệ thống `/usr`, `/lib`, `/bin` ở chế độ chỉ đọc (`--ro-bind`), cô lập `/tmp`, `/run`, `/var`, `/home` bằng `--tmpfs`, đóng toàn bộ file descriptor thừa (`fd > 2`), và che chắn `.git` để tiến trình test không thể sửa đổi lịch sử Git hoặc đọc bí mật của máy chủ.
   - Chặn tuyệt đối truy cập mạng, `/opt/OpenCode`, `~/.config/opencode`, `~/.config/ai.opencode.desktop`, `OPENCODE_OWNER_AUTHORITY_DIR`, và `pilotStore`.
3. **Chính sách Thực thi Ký số Ed25519 (`executionPolicy`):**
   - Mọi lệnh gọi model qua `NativePeerAdapter` phải có `executionPolicy` được ký Ed25519 bởi `HostOwnerBridge` và khớp chính xác với `planDigest` đã được Owner `approve`.
   - Kiểm soát chặt chẽ trần số lượt gọi (`maxCalls`), số phiên chạy song song (`maxActive`), và số lần thử tối đa trên mỗi task (`maxAttemptsPerTask`).

---

## 2. Hướng dẫn Cài đặt & Cấu hình

### 2.1. Yêu cầu Hệ thống
- **Hệ điều hành:** Ubuntu / Linux với `bubblewrap` (`bwrap`), `git`, và `node` >= 22.
- **Ứng dụng Host:** OpenCode V2 Desktop (`2.2.5` hoặc `2.2.6`).

### 2.2. Cấu hình trong `~/.config/opencode/opencode.json`

Thêm plugin vào mảng `"plugins"` trong file `~/.config/opencode/opencode.json`:

```json
{
  "plugins": [
    {
      "package": "/home/hulk/aiteam-dev/owner-inbox",
      "options": {
        "officialPilot": true,
        "pilotWake": false,
        "nativeDispatch": false,
        "pilotStore": "/home/hulk/.local/share/opencode/ai-team-v08-clean"
      }
    }
  ]
}
```

**Giải thích các tùy chọn (`options`):**
- `officialPilot: true`: Kích hoạt bộ điều phối chính thức (`OfficialCoordinator`).
- `pilotWake: false` & `nativeDispatch: false`: Giữ cổng an toàn mặc định (không tự động đánh thức hoặc chạy ngầm ngoài tầm kiểm soát của Owner).
- `pilotStore`: Thư mục lưu trữ trạng thái `team.json` và báo cáo Markdown (`reports/`) tách biệt theo băm SHA-256 của đường dẫn dự án.

---

## 3. Hướng dẫn Sử dụng

### 3.1. Khởi tạo Đội ngũ Peer (Bootstrap)
1. Mở một dự án Git trong **OpenCode Desktop**.
2. Mở bảng điều khiển **AI Team Chat** từ thanh công cụ bên phải hoặc Command Palette (`Open AI Team Chat`).
3. Nhấn **Tạo Peer Team** và xác nhận trên hộp thoại Owner của Desktop.
4. Hệ thống tự động tạo 4 nhánh và 4 Git worktree riêng biệt (`pilot-peer-1` .. `pilot-peer-4`) cùng 4 phiên làm việc tương ứng.

### 3.2. Quy trình Làm việc 4-Peer (DAG Workflow)
1. **Lập Kế hoạch (`Plan`):**
   - Owner soạn nội dung kế hoạch (`PLAN.md`), phạm vi (`Scope`), và tiêu chí nghiệm thu rồi nhấn **Lưu plan**.
2. **Đề xuất & Thảo luận (`Propose & Discuss`):**
   - Các Peer đề xuất danh sách công việc (`propose`) kèm phụ thuộc DAG (`dependencies`), danh sách file được phép sửa (`files`), và lệnh kiểm thử bắt buộc (`requiredChecks`).
   - Đội ngũ thảo luận qua các vòng (`discuss` / `close_round`), đánh dấu nhiệm vụ sẵn sàng (`ready`), và Owner phê duyệt kế hoạch (`Decision: APPROVE`).
3. **Thực thi trên Worktree & Kiểm thử Sandbox (`Claim → Start → Worktree Apply`):**
   - Peer nhận nhiệm vụ (`claim`) khi các task phụ thuộc đã hoàn tất (`DONE`).
   - Khi được cấp quyền thực thi, Peer gọi `team_worktree(mode="apply")` để ghi code vào worktree riêng, tự động chạy `requiredChecks` bên trong sandbox `bwrap-v1`, và tạo commit Git trên nhánh của Peer.
   - Peer gửi thông điệp phối hợp (`team_send`), viết báo cáo kết quả (`team_report` kèm mã `sourceCommit`), và nộp bài (`submit`).
4. **Chéo kiểm Độc lập & Hợp nhất (`Verify → Review → Integrate → Done`):**
   - Một Peer khác (Reviewer độc lập) gọi `team_worktree(mode="verify", sourceCommit)` để kiểm증 lại commit trong sandbox `bwrap-v1`, viết báo cáo review, và phê duyệt (`review`).
   - Sau khi được kiểm duyệt, commit được hợp nhất an toàn (`integrateReviewedTask`) và nhiệm vụ chuyển sang trạng thái `DONE`, mở khóa cho các nhiệm vụ phụ thuộc ở đợt (Wave) tiếp theo.

### 3.3. Đổi Model & Dừng Khẩn cấp (Stop)
- **Đổi Model theo từng Peer:** Chọn model và variant trên từng thẻ Peer rồi nhấn **Apply model**; hệ thống xác thực qua `HostOwnerBridge` và đồng bộ với Composer.
- **Dừng Thực thi (Stop):** Nhấn nút **Stop** trên giao diện OpenCode Desktop hoặc hủy qua Coordinator; trạng thái dừng chỉ được công nhận khi `verifyStop` xác nhận phiên đã `idle` và ghi nhận biên nhận `stop-verified`.

---

## 4. Build & Kiểm thử

```bash
# Kiểm tra kiểu TypeScript và đóng gói giao diện GUI (dist/gui-experimental.cjs)
npm run build

# Chạy toàn bộ bộ kiểm thử (266 tests)
npm test
```
