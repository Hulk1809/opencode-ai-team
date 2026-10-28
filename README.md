# AI Development Team — OpenCode V2

Ứng dụng thật: React/TypeScript, Express, SQLite WAL, SSE và MCP Streamable HTTP. Không mock agent hoặc hardcode câu trả lời. Service OpenCode dùng chung với Desktop/CLI, mỗi role có session và Git worktree riêng.

## Cài và chạy trên Ubuntu

1. Cài Node.js **24+**, npm và Git. Cài/mở OpenCode V2 Desktop hoặc chạy `opencode serve --service`. Provider/model phải dùng được trong OpenCode trước.
2. Mở terminal tại thư mục `ai-team`:

   ```bash
   npm ci
   cp .env.example .env
   ./start.sh
   ```

3. Mở **http://127.0.0.1:4310**. Đăng nhập bằng token in trong terminal. Token được tạo một lần tại `.data/token`, quyền `600`; không gửi token cho người khác.
4. Chọn **Projects → +**, nhập tên và đường dẫn tuyệt đối tới **Git root đã có ít nhất một commit**. Có thể dùng project bất kỳ, không buộc là source ứng dụng này.
5. Gửi yêu cầu tới `admin`. Agent được tạo theo nhu cầu; Admin khảo sát, dùng MCP tạo task rồi nhắn agent phụ trách. Chọn role trực tiếp hoặc `@frontend`, `@backend`, `@qa`, `@devops`, `@admin`.
6. Theo dõi Tasks, Sessions, Git Changes và execution logs. Duyệt shell permission trong OpenCode Desktop/CLI cùng service. Mỗi role hiển thị session ID riêng; cửa sổ không phải danh tính agent.

SDK `@opencode/client@2.1.4` khớp service đã kiểm tra. Backend dùng `Service.discover()` và `Service.headers()`, không mở port OpenCode hoặc yêu cầu copy password service. CLI trên máy khảo sát nằm tại `/home/hulk/.config/ai.opencode.desktop/cli/2.1.4-x64/opencode-cli`; thêm thư mục đó vào PATH nếu cần. Không sửa source OpenCode.

## Vận hành

- `./start.sh`: build + start localhost. `npm start`: dùng frontend đã build. `npm run dev`: server qua tsx; frontend build lại bằng `npm run build`.
- `.env`: `PORT`, `TEAM_DATA_DIR`, `TEAM_TOKEN` tùy chọn. `npm start` không tự nạp `.env`; script `start.sh` có nạp.
- SQLite `.data/team.sqlite` và worktrees `.data/worktrees/` chứa dữ liệu thật. Dừng ứng dụng trước khi sao lưu **toàn bộ `.data/`**, gồm WAL/SHM nếu còn. Không xóa folder worktree bằng tay.
- Restart giữ project/task/message. Tin đang xử lý trở thành `uncertain`; kiểm tra session thật rồi mới Retry, tối đa ba lần. Không tự retry sau mất kết nối vì có thể lặp thao tác code.
- Pause chỉ dừng dispatch mới. Session đang chạy phải interrupt từ OpenCode nếu cần.
- Model mỗi role đổi tại Agents sau khi session được tạo; dùng `provider/model`. Có thể dùng cùng model. Quyền session được lưu; sửa quyền/duyệt permission qua OpenCode.
- QA mới được chuyển Done, phải kèm evidence. Human approval ghi nhận cho tích hợp; **không tự merge**. Git Changes hiển thị diff/status từng worktree. File untracked xuất hiện trong status, chưa có nội dung trong `git diff HEAD`.
- Code ở worktree khác chưa tự xuất hiện trong worktree QA/Frontend. Agent phải cung cấp đường dẫn/diff rõ ràng; human tích hợp sau review. Không tuyên bố task dependency đã tích hợp chỉ vì task Done.
- `docs/` trong project đích dùng lưu API contract/ADR/context; công cụ inbox còn cung cấp task, project và đường dẫn worktree. Chưa có UI soạn context chuyên biệt.

## An toàn

Server chỉ bind `127.0.0.1`, có cookie HttpOnly/SameSite, kiểm tra Host/Origin và token MCP riêng cho từng agent. Không cấu hình reverse proxy/public Internet. Model API không trả provider settings/API key cho browser.

OpenCode tools **không phải sandbox hệ điều hành**. Shell có quyền user hiện tại; mặc định yêu cầu người duyệt. Không cấp “always allow” cho shell rộng. Không đưa repository không tin cậy vào máy có credential nhạy cảm; dùng container/VM riêng. Không push, deploy production, sửa credential hoặc thao tác phá hủy tự động.

## Kiểm tra

```bash
npm test
npm run build
npm audit --omit=dev
# Các lệnh dưới gọi model thật, tạo fixture Git tại /tmp/opencode,
# tạo session/worktree thật và phát sinh chi phí provider:
node --import tsx tests/live.ts
node --import tsx tests/orchestrator-live.ts
```

`tests/core.test.ts`: SQLite reopen, idempotency, conflict, hop limit, dependency, QA gate, restart uncertain và model ID. `tests/live.ts`: Backend viết file thật và hỏi Frontend qua MCP. `tests/orchestrator-live.ts`: Admin tạo task, giao Backend sửa bug toán học, QA xác minh; có thể bị chặn ở shell permission và phải báo đúng.

## Giới hạn chưa được nhận là hoàn thành

- Chưa tự tích hợp/merge worktree; approval không đồng nghĩa merge đã chạy.
- Chưa có permission editor đầy đủ, cost dashboard chuẩn hóa, independent acceptance runner hoặc container sandbox.
- Không có bảo đảm model luôn phân việc đúng; backlog là kết quả inference thật, logs là bằng chứng, không phải kịch bản chat giả.
- Realtime events không replay từ OpenCode; transcript được lấy lại cuối lượt. Khi mất kết nối cần kiểm tra session.
- Starter người dùng mô tả chưa nằm tại root được cấp; xem `docs/AUDIT.md`.
