export function checkedTeam(value) {
  if (!value || typeof value.status !== 'string' || !['members','tasks','messages'].every(key => Array.isArray(value[key]))) throw Error('PILOT_SNAPSHOT_INVALID');
  for (const member of value.members) if (!member || typeof member.role !== 'string' || typeof member.sessionID !== 'string' || !member.sessionID.startsWith('ses_')) throw Error('PILOT_SNAPSHOT_INVALID');
  for (const task of value.tasks) if (!task || !['id','text','status','assignee'].every(key => typeof task[key] === 'string')) throw Error('PILOT_SNAPSHOT_INVALID');
  for (const message of value.messages) if (!message || !['id','text','from','to'].every(key => typeof message[key] === 'string')) throw Error('PILOT_SNAPSHOT_INVALID');
  return value;
}

export function insertAdminDraft(ctx, snapshot, text) {
  const current = ctx.sessions.current(), admins = snapshot?.team?.members?.filter(member => member.role === 'admin') ?? [];
  if (!current || current.server.id !== snapshot?.serverID || current.directory !== snapshot?.directory || admins.length !== 1 || current.id !== admins[0].sessionID) throw Error('Mở Chat với Admin trước khi chèn draft.');
  if (typeof text !== 'string' || !text.trim() || text.length > 10000) throw Error('Draft cần 1–10000 ký tự.');
  const screen = ctx.screen.current();
  if (!screen || !screen.composer.quotable()) throw Error('Native composer chưa sẵn sàng.');
  screen.composer.insert(`\n${text.trim()}\n`);
  screen.composer.focus();
}

export function taskDraft(text, assignee) {
  if (!text.trim() || !/^worker-[1-9]\d*$/.test(assignee)) throw Error('Chọn Worker và nhập task.');
  return `@admin Hãy tạo task và giao cho @${assignee}:\n${text.trim()}`;
}

export function messageTime(at) {
  const date = new Date(at);
  return at != null && Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Chưa có timestamp';
}
export function workflowDraft(text='') {
  if(typeof text!=='string'||text.length>6000)throw Error('Yêu cầu tối đa 6000 ký tự để thêm mẫu bàn giao.');
  return `@admin ${text.trim()||'Mô tả việc cần làm tại đây.'}\n\nPhạm vi: [file/chức năng được thay đổi; phần không được đụng tới]\nTiêu chí nghiệm thu: [kết quả cần đạt]\n\n1. Lập kế hoạch và chia việc cho hai Workers theo nhiệm vụ, không cố định chuyên môn.\n2. Chỉ chạy song song khi phạm vi file độc lập; phối hợp trước khi sửa cùng file.\n3. Bàn giao báo cáo Markdown: kế hoạch, thay đổi, lệnh test + exit code, lỗi còn lại. Không coi tự báo PASS là kiểm chứng độc lập.\n4. Test thất bại: sửa và chạy lại; không sửa test chỉ để xanh. Admin review diff và báo cáo trước khi đề nghị hoàn tất.\n5. Owner duyệt cuối. Không tự merge/push/deploy, đổi quyền hoặc chạy model ngoài approval hiện có.\n\nĐây là yêu cầu qua coordinator; không cấp quyền execution hay tự dispatch.`;
}
export function pilotError(error) {
  const seen = new Set();
  function message(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    for (const key of ['message', 'error', 'data', 'cause']) {
      const text = message(value[key]);
      if (text) return text;
    }
    return typeof value.type === 'string' ? value.type : '';
  }
  return message(error) || 'Không đọc được phản hồi RPC. Kiểm tra project và kết nối host, rồi thử Làm mới.';
}

export function connectionLabel({selected, loading, error, status}) {
  if (!selected) return 'Chưa chọn session';
  if (error) return 'Mất kết nối / lỗi RPC';
  if (status === 'unprovisioned') return 'Đã kết nối · chưa provision';
  if (status === 'ready') return 'Đã kết nối · sẵn sàng';
  if (status) return `Đã kết nối · ${status}`;
  return loading ? 'Đang kết nối…' : 'Chưa kết nối';
}

export function memberActivity(session, active) {
  if (!session || typeof session.id !== 'string' || !active || typeof active !== 'object' || Array.isArray(active)) return 'unavailable';
  if (!Object.hasOwn(active, session.id)) return 'idle';
  return active[session.id]?.type === 'running' ? 'running' : 'unavailable';
}
