# OpenCode AI Development Team

Hệ thống điều phối đội ngũ AI đa tác tử (Multi-Agent Development Team) trên nền tảng **OpenCode V2**, bao gồm:
1. **Native Desktop Plugin V0.8 (`native-v0.8/`)**: Plugin tích hợp trực tiếp vào OpenCode Desktop (`2.2.5` / `2.2.6`) và Sidecar với mô hình 4-Peer Git Worktree DAG, xác thực quyền Owner bằng chữ ký số **Ed25519** (`HostOwnerBridge`), và thực thi kiểm thử trong sandbox **Bubblewrap (`bwrap-v1`)**.
2. **Web Dashboard & MCP Server (`apps/`, `packages/`)**: Giao diện điều phối qua trình duyệt kết nối tới OpenCode V2 Service qua Express, SQLite WAL, SSE và MCP Streamable HTTP.

---

## 1. Cấu trúc Thư mục Dự án

```text
opencode-ai-team/
├── native-v0.8/                  # OpenCode V2 Native Plugin (4-Peer Git Worktree + bwrap-v1 Sandbox)
│   ├── src/                      # Mã nguồn Coordinator, HostOwnerBridge, NativePeerAdapter, SolidJS GUI
│   ├── tests/                    # Bộ kiểm thử đơn vị, tích hợp, fault-injection & bảo mật (266 tests)
│   ├── scripts/                  # Tiện ích đóng gói broker release
│   └── README.md                 # Phân tích mã nguồn chi tiết & hướng dẫn sử dụng Native Plugin V0.8
├── apps/
│   ├── server/                   # Backend Express + SQLite WAL + OpenCode V2 Dispatcher
│   └── web/                      # Giao diện điều khiển React + TypeScript
├── packages/
│   ├── shared/                   # Các kiểu dữ liệu và schema dùng chung
│   └── team-mcp/                 # Máy chủ MCP Streamable HTTP định danh theo từng Agent
├── docs/
│   └── TEAM-CHAT-ARCHITECTURE.md # Phân tích kiến trúc hệ thống, luồng dữ liệu & ranh giới bảo mật
└── README.md                     # Tài liệu tổng quan & hướng dẫn sử dụng nhanh
```

---

## 2. Hướng dẫn Sử dụng Nhanh

### A. Bản Native Desktop Plugin V0.8 (`native-v0.8/`) — Khuyên dùng

Xem tài liệu phân tích mã nguồn chi tiết tại [`native-v0.8/README.md`](native-v0.8/README.md).

1. **Build và chạy kiểm thử:**
   ```bash
   cd native-v0.8
   npm ci
   npm run build
   npm test
   ```
2. **Khai báo plugin trong `~/.config/opencode/opencode.json`:**
   ```json
   {
     "plugins": [
       {
         "package": "/đường/dẫn/tới/native-v0.8",
         "options": {
           "officialPilot": true,
           "pilotWake": false,
           "nativeDispatch": false,
           "pilotStore": "/home/user/.local/share/opencode/ai-team-v08-clean"
         }
       }
     ]
   }
   ```
3. **Vận hành trong OpenCode Desktop:**
   - Mở dự án Git trong OpenCode Desktop → mở panel **AI Team Chat**.
   - Khởi tạo đội ngũ 4 Peer (`pilot-peer-1..4`), lập kế hoạch (`PLAN.md`), phân rã task theo đồ thị phụ thuộc (DAG), thực thi và chạy unit test trong sandbox `bwrap-v1`, chéo kiểm độc lập (`review`), và hợp nhất (`integrate`) về nhánh đích.

---

### B. Bản Web Dashboard & MCP (`apps/` + `packages/`)

1. **Yêu cầu:** Node.js **24+**, npm, Git, và OpenCode V2 đang chạy (`opencode serve --service` hoặc OpenCode Desktop).
2. **Khởi chạy tại thư mục gốc:**
   ```bash
   npm ci
   cp .env.example .env
   ./start.sh
   ```
3. **Truy cập Dashboard:**
   - Mở **http://127.0.0.1:4310** và đăng nhập bằng token một lần được sinh tại `.data/token` (`0600`).
   - Thêm dự án Git tại **Projects → +**, duyệt đề xuất khảo sát của Admin tại **Khảo sát và duyệt đội AI**, và theo dõi tiến độ trên **Tasks**, **Sessions**, **Git Changes**.
4. **Chạy dưới dạng Ubuntu User Service (Tùy chọn):**
   ```bash
   bash scripts/service.sh install
   bash scripts/service.sh status
   ```
5. **Kiểm thử Web Dashboard:**
   ```bash
   npm test
   npm run build
   ```

---

## 3. Tài liệu Kiến trúc

- **Kiến trúc tổng thể & ranh giới an toàn:** [`docs/TEAM-CHAT-ARCHITECTURE.md`](docs/TEAM-CHAT-ARCHITECTURE.md)
- **Phân tích mã nguồn & hướng dẫn Native Plugin V0.8:** [`native-v0.8/README.md`](native-v0.8/README.md)
