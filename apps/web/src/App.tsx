import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { dependencies, resolveReceiver } from './helpers.ts';
import { TaskActions } from './TaskActions.tsx';
import { ProjectPlan } from './ProjectPlan.tsx';
import { columns, roles } from '../../../packages/shared/src/index.ts';

type Project = { id: string; name: string; path: string; paused: boolean; onboarding?:string; proposal?:unknown };
type Agent = { id: string; projectID: string; role: string; sessionID?: string; directory?: string; model?: string; status: string; error?: string };
type Task = { id: string; projectID?: string; title: string; status: string; assignee?: string; priority: string; dependencies: string[]; criteria?: string; evidence?: string };
type Message = { id: string; sender: string; receiver: string; body: string; status: string; createdAt: string; error?: string };
type Log = { id: string; kind: string; data: unknown; createdAt: string };
type State = { projects: Project[]; agents: Agent[]; tasks: Task[]; messages: Message[]; logs: Log[]; connection: { status: string; version?: string; error?: string } };
type Page = 'chat' | 'agents' | 'tasks' | 'sessions' | 'git' | 'settings';
const pages: { id: Page; title: string; icon: string }[] = [
  { id: 'chat', title: 'Team Chat', icon: '#' }, { id: 'agents', title: 'Agents', icon: '◈' },
  { id: 'tasks', title: 'Tasks', icon: '▤' }, { id: 'sessions', title: 'Sessions', icon: '⌘' },
  { id: 'git', title: 'Git Changes', icon: '⑂' }, { id: 'settings', title: 'Settings', icon: '⚙' },
];
const date = (value: string) => new Date(value).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const text = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300) || 'Phản hồi không hợp lệ'}`); }
  if (!response.ok) {
    const detail = data && typeof data === 'object' && 'error' in data ? text(data.error) : raw;
    throw Object.assign(new Error(detail || `HTTP ${response.status}`), { status: response.status });
  }
  return data as T;
}

function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
function Badge({ value }: { value: string }) { return <span className={`badge ${/disconnected|unknown/i.test(value) ? '' : /error|fail|blocked/i.test(value) ? 'danger' : /done|complete|idle|connected|running/i.test(value) ? 'good' : ''}`}>{value}</span>; }

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [projectID, setProjectID] = useState('');
  const [page, setPage] = useState<Page>('chat');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState(false);
  const [token, setToken] = useState('');
  const [receiver, setReceiver] = useState('team');
  const roleOptions = roles.map(role => <option key={role} value={role}>@{role}</option>);
  const [body, setBody] = useState('');
  const [modal, setModal] = useState<'project' | 'task' | null>(null);
  const [models, setModels] = useState<unknown>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [events, setEvents] = useState('Đang kết nối');
  const messageEnd = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const requestKey = useRef<{ body: string; receiver: string; projectID: string; key: string } | null>(null);
  const project = state?.projects.find(item => item.id === projectID);
  const agents = state?.agents.filter(item => item.projectID === projectID) || [];
  const tasks = state?.tasks.filter(item => !item.projectID || item.projectID === projectID) || [];

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const next = await api<State>(`/state${projectID ? `?projectID=${encodeURIComponent(projectID)}` : ''}`);
      if (current !== generation.current) return;
      setState(next); setError(''); setAuth(false);
      if (!projectID && next.projects.length) setProjectID(next.projects[0].id);
    } catch (cause) {
      if (current !== generation.current) return;
      if ((cause as { status?: number }).status === 401) setAuth(true);
      setError((cause as Error).message);
    } finally { if (current === generation.current) setLoading(false); }
  }, [projectID]);

  useEffect(() => {
    setLoading(true); setDiff(null); void refresh();
    return () => { generation.current++; };
  }, [refresh]);
  useEffect(() => {
    if (auth || !state) return;
    const source = new EventSource('/api/events', { withCredentials: true });
    source.onopen = () => setEvents('Trực tiếp');
    source.addEventListener('change', () => { void refresh(); });
    source.onerror = () => setEvents('Mất kết nối · đang thử lại');
    return () => source.close();
  }, [auth, Boolean(state), refresh]);
  useEffect(() => { messageEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [state?.messages.length, page]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setModal(null);
      if (event.key !== 'Tab' || !dialog) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [modal, busy]);

  async function act(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); await refresh(); } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  function submitMessage(event: FormEvent) {
    event.preventDefault();
    if (!body.trim() || !projectID || busy) return;
    const target = resolveReceiver(body, receiver, [...roles]);
    if (!requestKey.current || requestKey.current.body !== body || requestKey.current.receiver !== target || requestKey.current.projectID !== projectID) {
      requestKey.current = { body, receiver: target, projectID, key: crypto.randomUUID() };
    }
    const key = requestKey.current.key;
    void act(async () => {
      await api('/messages', { projectID, receiver: target, body: body.trim(), idempotencyKey: key });
      setBody(''); requestKey.current = null;
    });
  }
  function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const get = (key: string) => String(values.get(key) || '').trim();
    void act(async () => {
      if (modal === 'project') {
        const created = await api<Project>('/projects', { name: get('name'), path: get('path') });
        setProjectID(created.id);
      } else {
        await api('/tasks', { projectID, title: get('title'), assignee: get('assignee'), priority: get('priority'), dependencies: dependencies(get('dependencies')), criteria: get('criteria') });
      }
      setModal(null);
    });
  }

  return <div className="app-shell">
    <aside className="server-rail" aria-label="Không gian làm việc"><div className="brand-mark">ai<span>·</span></div><div className="rail-rule"/><button className="server active" title="AI Team" onClick={() => setPage('chat')}>AT</button><button className="server add" aria-label="Tạo dự án" onClick={() => setModal('project')}>+</button><div className="rail-bottom">AI</div></aside>
    <aside className="sidebar">
      <div className="workspace-title"><span>AI Team<span className="workspace-tag">WORKSPACE</span></span><span className="chevron">⌄</span></div>
      <div className="sidebar-scroll">
        <div className="section-label">PROJECTS <button aria-label="Tạo dự án" onClick={() => setModal('project')}>+</button></div>
        <div className="project-list">{state?.projects.map(item => <button key={item.id} className={`project-item ${projectID === item.id ? 'selected' : ''}`} onClick={() => { setProjectID(item.id); setReceiver('team'); }}><span className="project-symbol">{item.name.slice(0, 1).toUpperCase()}</span><span>{item.name}</span>{item.paused && <span className="muted">Ⅱ</span>}</button>)}{!state?.projects.length && <p className="sidebar-note">Chưa có dự án. Tạo dự án để bắt đầu.</p>}</div>
        <div className="section-label channel-label">WORKSPACE</div>
        <nav>{pages.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'selected' : ''}`} onClick={() => setPage(item.id)}><span className="nav-icon">{item.icon}</span>{item.title}{item.id === 'tasks' && tasks.length > 0 && <span className="count">{tasks.length}</span>}</button>)}</nav>
        <div className="section-label agents-label">TEAM MEMBERS <span>{agents.length}</span></div>
        {agents.map(agent => <button key={agent.id} className="member-item" onClick={() => setPage('agents')}><span className="avatar small">{agent.role.slice(0, 2).toUpperCase()}</span><span className="member-name">{agent.role}<small>{agent.status}</small></span><span className={`status-dot ${agent.error ? 'error' : ''}`} title={agent.status}/></button>)}
        {!agents.length && <p className="sidebar-note">Chưa có agent từ máy chủ.</p>}
      </div>
      <div className="workspace-footer"><span className="avatar user">U</span><div>Điều phối viên<small>Phiên đăng nhập riêng tư</small></div><button aria-label="Cài đặt" onClick={() => setPage('settings')}>⚙</button></div>
    </aside>
    <main>
      {!auth&&project?.onboarding&&<ProjectPlan key={project.id} project={project}/>}
      <header className="topbar"><div className="heading"><span className="header-icon">{pages.find(item => item.id === page)?.icon}</span><h1>{pages.find(item => item.id === page)?.title}</h1><span className="header-divider"/><span className="header-description">{project?.name || 'Không gian cộng tác của đội AI'}</span></div><div className="topbar-actions"><span className="live-label"><span className={`status-dot ${events !== 'Trực tiếp' ? 'waiting' : ''}`}/>{events}</span><button className="icon-button" title="Làm mới dữ liệu" aria-label="Làm mới dữ liệu" onClick={() => void refresh()}>↻</button></div></header>
      {error && !auth && <div className="error-banner" role="alert">{error}<button onClick={() => void refresh()}>Thử lại</button></div>}
      {auth ? <div className="auth-wrap"><form className="auth-card" onSubmit={event => { event.preventDefault(); void act(async () => { await api('/login', { token }); setToken(''); setAuth(false); }); }}><div className="eyebrow">KẾT NỐI WORKSPACE</div><h2>Đăng nhập AI Team</h2><p>Dán token từ console máy chủ. Token chỉ dùng đăng nhập; trình duyệt không lưu token.</p><label>Token máy chủ<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required autoFocus /></label>{error && <p className="error-text" role="alert">{error}</p>}<button className="primary" disabled={busy || !token.trim()}>{busy ? 'Đang kết nối…' : 'Kết nối workspace'}</button></form></div> : <>
        {page === 'chat' && <div className="chat-layout"><section className="chat-main">
          <div className="project-banner"><div className="project-banner-icon">#</div><div><div className="eyebrow">KÊNH LÀM VIỆC CHUNG</div><h2>{project?.name || 'Chào mừng đến AI Team'}</h2><p>Trao đổi, giao việc và cùng đội AI xây dựng sản phẩm.</p></div>{project && <button className="secondary" disabled={busy} onClick={() => void act(async () => { await api(`/projects/${encodeURIComponent(project.id)}/pause`, { paused: !project.paused }); })}>{project.paused ? 'Tiếp tục' : 'Tạm dừng đội'}</button>}</div>
          <div className="conversation" aria-label="Tin nhắn đội" aria-live="polite">{loading && <div className="inline-status">Đang tải cuộc trò chuyện…</div>}{!loading && !state?.messages.length && <Empty><span className="empty-symbol">#</span><h3>Cuộc trò chuyện bắt đầu từ đây</h3><p>{project ? 'Gửi yêu cầu cho cả đội hoặc @mention một vai trò.' : 'Chọn hoặc tạo dự án để trò chuyện với đội AI.'}</p></Empty>}{state?.messages.map(message => <article className="message" key={message.id}><span className={`avatar ${message.sender === 'user' ? 'user' : ''}`}>{message.sender.slice(0, 2).toUpperCase()}</span><div className="message-content"><div className="message-meta"><strong>{message.sender}</strong>{message.sender !== 'user' && <span className="bot-label">AGENT</span>}<time dateTime={message.createdAt}>{date(message.createdAt)}</time><span className="message-target">đến @{message.receiver}</span></div><div className="message-body">{message.body}</div><div className="message-status"><Badge value={message.status}/>{message.error && <><span className="error-text">{message.error}</span><button disabled={busy} onClick={() => void act(async () => { await api(`/messages/${encodeURIComponent(message.id)}/retry`, {}); })}>Gửi lại</button></>}</div></div></article>)}<div ref={messageEnd}/></div>
          <form className="composer" onSubmit={submitMessage}><div className="composer-input"><span className="compose-plus">+</span><textarea aria-label="Nội dung tin nhắn" placeholder={project ? `Nhắn tin cho ${project.name}…` : 'Chọn dự án để gửi tin nhắn'} value={body} onChange={event => setBody(event.target.value)} disabled={!projectID || busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}/></div><div className="composer-toolbar"><label>Gửi đến <select aria-label="Người nhận" value={receiver} onChange={event => setReceiver(event.target.value)}><option value="team">@team · Cả đội</option>{roleOptions}</select></label><button className="primary send-button" disabled={busy || !body.trim() || !projectID}>{busy ? 'Đang gửi…' : 'Gửi tin nhắn'} <span>↗</span></button></div></form><div className="composer-hint"><span><kbd>Enter</kbd> để gửi · <kbd>Shift + Enter</kbd> xuống dòng</span><span>Dùng @vai-trò để giao việc trực tiếp</span></div>
        </section><aside className="context-panel"><div className="context-title">TỔNG QUAN DỰ ÁN</div><div className="context-block"><div className="eyebrow">DỰ ÁN HIỆN TẠI</div><h3>{project?.name || 'Chưa chọn dự án'}</h3><p className="path-text">{project?.path || 'Đường dẫn sẽ hiển thị tại đây'}</p>{project && <Badge value={project.paused ? 'paused' : 'active'}/>}</div><div className="context-block"><div className="context-row"><h3>Đội của bạn</h3><span className="count">{agents.length}</span></div>{agents.map(agent => <div className="agent-summary" key={agent.id}><span className="avatar small">{agent.role.slice(0, 2).toUpperCase()}</span><div><strong>{agent.role}</strong><small>{agent.model || 'Chưa có model'}</small></div><Badge value={agent.status}/></div>)}{!agents.length && <p>Chưa có agent được kết nối.</p>}</div><div className="context-block"><div className="context-row"><h3>Công việc</h3><button onClick={() => setPage('tasks')}>Xem tất cả</button></div><div className="task-total">{tasks.length}<span>công việc trong dự án</span></div>{tasks.slice(0, 4).map(task => <button className="mini-task" key={task.id} onClick={() => setPage('tasks')}><span className="task-square"/><span>{task.title}</span><Badge value={task.status}/></button>)}</div><div className="connection-card"><span className="eyebrow">OPENCODE SERVER</span><div><span className={`status-dot ${state?.connection.error ? 'error' : 'waiting'}`}/>{state?.connection.status || 'Chưa có dữ liệu'}</div>{state?.connection.version && <small>Phiên bản {state.connection.version}</small>}{state?.connection.error && <p className="error-text">{state.connection.error}</p>}</div></aside></div>}
        {page === 'agents' && <section className="page-content"><PageTitle title="Đội AI của bạn" description="Trạng thái, phiên làm việc và model trực tiếp từ máy chủ."/>{!agents.length && <Empty>Chưa có agent trong dự án.</Empty>}<div className="agent-grid">{agents.map(agent => <article className="panel agent-card" key={agent.id}><div className="context-row"><span className="avatar">{agent.role.slice(0, 2).toUpperCase()}</span><Badge value={agent.status}/></div><h3>{agent.role}</h3><dl><dt>Session</dt><dd>{agent.sessionID || 'Chưa có'}</dd><dt>Thư mục</dt><dd>{agent.directory || 'Chưa có'}</dd></dl><form onSubmit={event => { event.preventDefault(); const model = String(new FormData(event.currentTarget).get('model') || '').trim(); if (model) void act(async () => { await api(`/agents/${encodeURIComponent(agent.id)}`, { model }); }); }}><label>Model<input name="model" defaultValue={agent.model || ''} key={agent.model} placeholder="provider/model" required /></label><button className="secondary" disabled={busy}>Lưu model</button></form>{agent.error && <p role="alert" className="error-text">{agent.error}</p>}</article>)}</div></section>}
        {page === 'tasks' && <section className="page-content"><PageTitle title="Bảng công việc" description="Theo dõi tiến độ, bằng chứng và phê duyệt kết quả." action={<button className="primary" disabled={!projectID} onClick={() => setModal('task')}>+ Tạo công việc</button>}/><div className="kanban">{[...new Set([...columns, ...tasks.map(task => task.status)])].map(status => <section className="kanban-column" key={status}><div className="column-title"><span>{({ Backlog: 'Tồn đọng', Todo: 'Cần làm', 'In Progress': 'Đang thực hiện', Review: 'Chờ duyệt', Blocked: 'Bị chặn', Done: 'Hoàn thành' } as Record<string, string>)[status] || status}</span><span className="count">{tasks.filter(task => task.status === status).length}</span></div>{tasks.filter(task => task.status === status).map(task => <TaskCard key={task.id} task={task} busy={busy} update={(body) => void act(async () => { await api(`/tasks/${encodeURIComponent(task.id)}`, body); })} approve={() => void act(async () => { await api(`/tasks/${encodeURIComponent(task.id)}/approve`, {}); })}/>)}{!tasks.some(task => task.status === status) && <div className="column-empty">Chưa có công việc</div>}</section>)}</div></section>}
        {page === 'sessions' && <section className="page-content"><PageTitle title="Sessions & nhật ký" description="Phiên agent và sự kiện thực tế từ máy chủ."/><div className="panel session-list">{agents.filter(agent => agent.sessionID).map(agent => <div className="session-row" key={agent.id}><strong>{agent.role}</strong><code>{agent.sessionID}</code><Badge value={agent.status}/></div>)}{!agents.some(agent => agent.sessionID) && <Empty>Chưa có phiên làm việc.</Empty>}</div><h3>Nhật ký sự kiện</h3><div className="panel logs">{state?.logs.map(log => <details key={log.id}><summary><time>{date(log.createdAt)}</time><Badge value={log.kind}/><code>{log.id}</code></summary><pre>{text(log.data)}</pre></details>)}{!state?.logs.length && <Empty>Chưa có sự kiện.</Empty>}</div></section>}
        {page === 'git' && <section className="page-content"><PageTitle title="Thay đổi mã nguồn" description={project?.path || 'Chọn dự án để xem diff.'} action={<button className="primary" disabled={!projectID || busy} onClick={() => void act(async () => { const result = await api<{ diff: string }>(`/projects/${encodeURIComponent(projectID)}/diff`); setDiff(result.diff); })}>Tải Git diff</button>}/><pre className="panel diff">{diff === null ? 'Chưa tải diff. Nhấn “Tải Git diff” để lấy thay đổi hiện tại.' : diff || 'Không có thay đổi mã nguồn.'}</pre></section>}
        {page === 'settings' && <section className="page-content"><PageTitle title="Cài đặt workspace" description="Thông tin kết nối và danh sách model do API cung cấp."/><div className="panel settings-panel"><h3>Kết nối máy chủ</h3><dl><dt>Trạng thái</dt><dd>{state?.connection.status || 'Chưa có dữ liệu'}</dd><dt>Phiên bản</dt><dd>{state?.connection.version || 'Không có dữ liệu'}</dd><dt>Sự kiện trực tiếp</dt><dd>{events}</dd></dl><p>Đăng nhập dùng cookie. Token không được lưu trong localStorage hoặc sessionStorage.</p>{state?.connection.error && <p className="error-text">{state.connection.error}</p>}</div><div className="panel settings-panel"><div className="context-row"><h3>Models khả dụng</h3><button className="secondary" disabled={busy} onClick={() => void act(async () => { setModels(await api('/models')); })}>Tải danh sách models</button></div><pre>{models === null ? 'Chưa tải danh sách model.' : text(models)}</pre></div></section>}
      </>}
    </main>
    {modal && <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget && !busy) setModal(null); }}><section className="modal panel" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div className="context-row"><h2 id="modal-title">{modal === 'project' ? 'Tạo dự án mới' : 'Tạo công việc'}</h2><button className="icon-button" aria-label="Đóng" disabled={busy} onClick={() => setModal(null)}>×</button></div><form onSubmit={submitCreate}>{modal === 'project' ? <><label>Tên dự án<input name="name" required autoFocus maxLength={120} placeholder="Tên dự án của bạn" /></label><label>Đường dẫn trên máy chủ<input name="path" required placeholder="/home/user/projects/my-app" /></label><p className="muted">Dùng đường dẫn thư mục thật trên máy chạy máy chủ.</p></> : <><label>Tiêu đề<input name="title" required autoFocus maxLength={300}/></label><div className="form-row"><label>Người thực hiện<select name="assignee" required><option value="">Chọn vai trò</option>{roles.map(role => <option key={role}>{role}</option>)}</select></label><label>Độ ưu tiên<select name="priority"><option value="medium">Trung bình</option><option value="high">Cao</option><option value="low">Thấp</option></select></label></div><label>Phụ thuộc (ID, ngăn bằng dấu phẩy)<input name="dependencies" /></label><label>Tiêu chí nghiệm thu<textarea name="criteria" required rows={3}/></label></>}{error && <p className="error-text" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setModal(null)}>Hủy</button><button className="primary" disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo mới'}</button></div></form></section></div>}
  </div>;
}

function PageTitle({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="page-title"><div><h2>{title}</h2><p>{description}</p></div>{action}</div>;
}

function TaskCard({ task, busy, update, approve }: { task: Task; busy: boolean; update: (body: { status: string; evidence: string }) => void; approve: () => void }) {
  return <><TaskActions id={task.id}/><TaskDetails task={task} busy={busy} update={update} approve={approve}/></>;
}
function TaskDetails({ task, busy, update, approve }: { task: Task; busy: boolean; update: (body: { status: string; evidence: string }) => void; approve: () => void }) {
  return <article className="task-card panel"><div className="context-row"><Badge value={task.priority}/><code className="task-id" title={task.id}>{task.id.slice(0, 8)}</code></div><h3>{task.title}</h3><p className="task-assignee">@{task.assignee || 'Chưa phân công'}</p>{task.criteria && <details><summary>Tiêu chí nghiệm thu</summary><p>{task.criteria}</p></details>}{task.dependencies?.length > 0 && <p className="muted">Phụ thuộc: {task.dependencies.join(', ')}</p>}<form key={`${task.status}:${task.evidence}`} onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); update({ status: String(values.get('status')), evidence: String(values.get('evidence')) }); }}><label className="sr-only" htmlFor={`status-${task.id}`}>Trạng thái</label><select id={`status-${task.id}`} name="status" defaultValue={task.status}>{[...new Set([...columns, task.status])].map(status => <option key={status}>{status}</option>)}</select><label>Bằng chứng<textarea name="evidence" defaultValue={task.evidence || ''} placeholder="Kết quả kiểm tra, đường dẫn, ghi chú…" rows={2}/></label><div className="task-actions"><button className="secondary" disabled={busy}>Lưu</button><button type="button" className="text-button" disabled={busy} onClick={approve}>Phê duyệt</button></div></form></article>;
}
