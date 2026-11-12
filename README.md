# OpenCode AI Team — Native Plugin

Plugin điều phối **4 Peer ngay trong OpenCode V2 Desktop**: chia task theo DAG, Git worktree riêng, kiểm thử trong sandbox, review độc lập và tích hợp có kiểm soát.

[Cài đặt & kiến trúc](native-v0.8/README.md) · [Biên bản kiểm chứng](native-v0.8/docs/README.md)

> **Đang phát triển.** Cần Desktop/Sidecar tương thích. Unit tests đạt không đồng nghĩa workflow đã được kiểm chứng toàn bộ.

## Bắt đầu

**Yêu cầu:** Linux, Git, Bubblewrap, Node.js 24 và OpenCode Desktop/Sidecar tương thích. Đọc [hướng dẫn Native](native-v0.8/README.md) trước khi cấu hình host.

```bash
cd native-v0.8
npm ci
npm run build
npm test
```

Build tạo bundle GUI trong `dist/`. Khai báo đường dẫn plugin theo hướng dẫn, rồi mở panel **AI Team Chat** trên dự án Git.

## Trạng thái

| Hạng mục | Kết quả |
| --- | --- |
| Kiểm thử plugin | 282/282 đạt; build đạt |
| Review và integration live | A/C đã DONE với canonical receipt |
| Đổi model khi idle | Đổi ngay; session API và composer đã kiểm chứng đồng bộ qua Desktop/reload |
| Đổi model khi đang trả lời | Lưu model chờ; chưa có ngắt để đổi ngay |
| Workflow cuối | B thiếu stop proof; B/I/R và E2E cuối chưa hoàn tất |
| Quota provider | Có fault injection; chưa kiểm quota thật |

## Cấu trúc

```text
native-v0.8/
  src/          Coordinator, Owner bridge, sandbox và Desktop GUI
  tests/        Unit, integration, security và fault-injection tests
  scripts/      Đóng gói broker
  docs/         Biên bản kiểm chứng và giới hạn
  README.md     Hướng dẫn cài đặt và kiến trúc
.github/        CI cho Native Plugin
```

Repository hiện chỉ duy trì Native Plugin. Web Dashboard/MCP cũ đã bỏ khỏi `main`; có thể truy hồi qua lịch sử Git.

## An toàn

- Owner approval, execution authorization và model selection là các trạng thái riêng.
- Task cần stop proof, required checks, review độc lập và canonical receipt; hết lease không chứng minh đã dừng.
- Không commit credentials, token, runtime state, backup hoặc `node_modules`.
