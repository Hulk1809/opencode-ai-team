# OpenCode AI Team

Điều phối đội AI trên **OpenCode V2**: chia việc, làm việc trong Git worktree riêng, kiểm thử, review độc lập và tích hợp có kiểm soát.

[Native Plugin](native-v0.8/README.md) · [Tài liệu](docs/README.md) · [Kiến trúc Web/MCP](docs/TEAM-CHAT-ARCHITECTURE.md)

> **Đang phát triển.** Unit tests đạt không đồng nghĩa workflow đã được kiểm chứng toàn bộ. Native Plugin cần host OpenCode tương thích; chưa phải plugin cài lên mọi bản Desktop là chạy được.

## Chọn cách sử dụng

| Thành phần | Dùng khi | Mã nguồn |
| --- | --- | --- |
| **Native Plugin V0.8** | Điều phối 4 Peer ngay trong OpenCode Desktop; Git worktree, Owner approval, sandbox và review | [`native-v0.8/`](native-v0.8/) |
| **Web Dashboard + MCP** | Điều phối qua giao diện web; Express, React, SQLite và MCP | [`apps/`](apps/) · [`packages/`](packages/) |

Hai thành phần có bộ dependency và lệnh kiểm thử riêng. Web Dashboard không phải dependency để chạy Native Plugin.

## Native Plugin — bắt đầu

**Yêu cầu:** Linux, Git, Bubblewrap, Node.js 24 và OpenCode Desktop/Sidecar tương thích. Xem [yêu cầu host và cấu hình](native-v0.8/README.md#2-hướng-dẫn-cài-đặt--cấu-hình) trước khi cài.

```bash
cd native-v0.8
npm ci
npm run build
npm test
```

Build tạo bundle GUI trong `dist/`. Cấu hình plugin theo [hướng dẫn Native](native-v0.8/README.md), rồi mở panel **AI Team Chat** trên dự án Git.

### Đã kiểm chứng và giới hạn

- A/C của dự án test đã qua review độc lập và tích hợp canonical.
- Đổi model của Peer idle không bị task outstanding khóa; session API và composer đã được kiểm chứng đồng bộ qua Desktop/reload.
- B cũ còn thiếu stop proof; B/I/R chưa hoàn tất toàn luồng.
- Đổi model khi phiên đang trả lời vẫn dùng model chờ; chưa hỗ trợ ngắt và đổi ngay.
- Quota provider thật và E2E cuối chưa kiểm chứng đầy đủ. Xem [biên bản kiểm chứng](native-v0.8/docs/README.md).

## Web Dashboard + MCP — bắt đầu

**Yêu cầu:** Node.js 24+, npm, Git và OpenCode V2 Service/Desktop.

```bash
npm ci
cp .env.example .env
./start.sh
```

Mở **http://127.0.0.1:4310**. Token đăng nhập nằm tại `.data/token`; không commit hoặc chia sẻ token.

```bash
npm test
npm run build
```

User service tùy chọn: `bash scripts/service.sh install`. Kiểm tra bằng `bash scripts/service.sh status`.

## Bản đồ repository

```text
native-v0.8/     Native Plugin: source, tests, tài liệu và build riêng
apps/server/    Web API, SQLite store và OpenCode dispatcher
apps/web/       React dashboard
packages/       Shared schema và MCP server
tests/          Kiểm thử Web/MCP
scripts/        Vận hành Web Dashboard
docs/           Mục lục và kiến trúc
.github/        GitHub Actions
```

## Quy tắc an toàn

- Owner approval, execution authorization và model selection là các trạng thái riêng.
- Task cần stop proof, required checks, review độc lập và canonical receipt; không coi hết lease là đã dừng.
- Không commit `.env`, token, credentials, runtime state, backup hay `node_modules`.
- Giữ lockfile cho cả hai bộ dependency. Không xóa fixture hoặc module chỉ vì không xuất hiện trên giao diện.
