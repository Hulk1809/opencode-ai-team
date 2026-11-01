import { Command, MenuItem, Panel, Plugin, Style, usePlugin } from "@opencode/plugin/gui"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { TeamChatRPC } from "./rpc"
import { errorText } from "./safety.mjs"
import {ConversationItem,MessageBubble,ComposerTools,roleLabel} from './chat-components'
import {chatStyle} from './chat-style'
import {conversationMessages,messageStatus} from './chat-presentation.mjs'
import {inboxProjection} from './console-projection.mjs'
import {guiScope} from './gui-scope.mjs'
import {taskHandoff} from './task-handoff.mjs'
import {ownerAdminSend,ownerAdminHistory,stableRows} from './native-owner.mjs'

export const style = `
.ai-team-pane .agents{display:flex;flex-wrap:wrap;gap:8px}
.ai-team-pane .message-text{line-height:1.6}
.ai-team-pane .message-actions{display:flex;gap:6px;margin-top:8px}
.ai-team-pane .message-actions button{font-size:11px;padding:3px 8px}
.ai-team-pane textarea,.ai-team-pane select,.ai-team-pane input{background:var(--chat-bg);border:1px solid var(--chat-line);color:inherit;padding:7px;border-radius:7px;max-width:100%;box-sizing:border-box}
.ai-team-pane button{padding:7px;border-radius:8px;cursor:pointer}
.ai-team-pane button:disabled{opacity:.55}
.ai-team-pane .attachment{display:flex;gap:8px;align-items:center;flex-wrap:wrap;overflow-wrap:anywhere}
.ai-team-pane .attachment small{display:block;flex-basis:100%;color:var(--chat-muted)}
.ai-team-pane .file-grid{display:grid;gap:10px}
.ai-team-pane .kanban{display:flex;gap:12px;overflow:auto}
.ai-team-pane .kanban section{flex:0 0 200px;min-width:0}
.ai-team-pane .kanban article{padding:12px;margin:8px 0;border:1px solid var(--chat-line);border-radius:10px;overflow-wrap:anywhere}
.ai-team-pane .member code,.ai-team-pane .member small{display:block;overflow-wrap:anywhere;font-size:11px}
.ai-team-pane .file-preview pre{white-space:pre-wrap;overflow-wrap:anywhere}
`
 type Team = {exists?:boolean,name?:string,status?:string,error?:string,members?:Record<string,{role:string,sessionID:string}>,awsAuth?:any[],tasks?:any[],messages?:Array<{id:string,at:string,from:string,to:string,text:string,status:string,error?:string,batchID?:string,eventType?:string,taskID?:string,dispatchedAt?:string,admittedAt?:string,startedAt?:number,completedAt?:string,correlation?:string,tools?:Array<{id:string,name:string,status:string,executed:boolean,result:string,error?:string}>}>}
const roles=["admin","frontend","backend","devops","qa"]
type Attachment={id:string,name:string,size:number,mime:string,limitation?:string,textLength:number,visibility?:string,revision?:string}

export function TeamPane() {
  const ctx=usePlugin<typeof definition>()
  const readClient=()=>ctx.sessions.current()?.server.client??ctx.client
  const scope=guiScope()
  const [state,setState]=createSignal<Team>({exists:false})
  const [nativeMessages,setNativeMessages]=createSignal<any[]>([])
  const [transcriptError,setTranscriptError]=createSignal('')
  let refreshPending=false
  const messages=createMemo(()=>{const rows=new Map((state().messages??[]).map(m=>[m.id,m]));for(const m of nativeMessages())rows.set(m.id,m);return [...rows.values()].sort((a,b)=>a.at.localeCompare(b.at))})
  const [recipient,setRecipient]=createSignal("admin")
  const [draft,setDraft]=createSignal("")
  const drafts=new Map<string,string>()
  let draftKey=''
  const [busy,setBusy]=createSignal(false)
  const [sendStatus,setSendStatus]=createSignal('')
  let ownerAttempt:{id:string,text:string,binding?:string}|undefined
  const [error,writeError]=createSignal("")
  const setError=(message:string)=>{if(message!=='STALE_GUI_SCOPE')writeError(message)}
   const [view,setView]=createSignal("Direct Messages")
  const [showConversations,setShowConversations]=createSignal(false)
  const [showDetails,setShowDetails]=createSignal(false)
  const isChat=()=>['Team Chat','Direct Messages'].includes(view())
  const thread=(role:string)=>conversationMessages(messages(),role) as NonNullable<Team['messages']>
  const activeThread=()=>view()==='Direct Messages'?recipient():'team'
  function capture(){
    const valid=scope.capture(),project=directory(),thread=activeThread(),page=view(),client=readClient()
    return ()=>valid()&&readClient()===client&&directory()===project&&activeThread()===thread&&view()===page
  }
  function selectThread(role:string){
    setRecipient(role==='team'?'admin':role);setView(role==='team'?'Team Chat':'Direct Messages');setShowConversations(false);setShowDetails(false)
  }
  const [query,setQuery]=createSignal("")
  const [files,setFiles]=createSignal<Attachment[]>([])
  const [attached,setAttached]=createSignal<Attachment[]>([])
  const [tasks,setTasks]=createSignal<any[]>([])
  const [monitor,setMonitor]=createSignal<any[]>([])
  const [ownerRequests,setOwnerRequests]=createSignal<any[]>([])
  const [requestStatus,setRequestStatus]=createSignal('')
  const [requestProject,setRequestProject]=createSignal('')
  const [taskID,setTaskID]=createSignal('')
  let taskOpener:HTMLButtonElement|undefined
  let taskClose:HTMLButtonElement|undefined
  function closeTask(){setTaskID('');queueMicrotask(()=>taskOpener?.isConnected&&taskOpener.focus())}
  function openTask(id:string,opener:HTMLButtonElement){taskOpener=opener;setRequestID('');setTaskID(id);queueMicrotask(()=>taskClose?.focus())}
  const handoff=()=>{const task=tasks().find(t=>t.id===taskID());return task?{task,...taskHandoff(task,state().messages??[])}:null}
  const [requestID,setRequestID]=createSignal('')
  const selectedRequest=()=>ownerRequests().find(r=>r.requestID===requestID())
  let requestOpener:HTMLButtonElement|undefined
  let requestClose!:HTMLButtonElement
  function closeRequest(){const id=requestID();setRequestID('');queueMicrotask(()=>{const row=document.getElementById(`request-${id}`);(row??requestOpener)?.focus()})}
  function openRequest(id:string,opener:HTMLButtonElement){requestOpener=opener;setRequestID(id);queueMicrotask(()=>requestClose?.focus())}
  const inbox=createMemo(()=>inboxProjection(ownerRequests(),{status:requestStatus(),project:requestProject()}))
   const unresolved=()=>inbox().pending
  async function markRequest(requestID:string,status:string){
    const current=capture()
    try{await workspace('owner_request_update',{requestID,status});if(current())await load()}catch(e){if(current())setError(errorText(e))}
  }
  async function metadata(action:string,payload:Record<string,unknown>={}){
    const current=capture()
    try{await workspace(action,payload);if(current())await load()}catch(e){if(current())setError(errorText(e))}
  }
  const [modelRole,setModelRole]=createSignal("")
  const [catalog,setCatalog]=createSignal<any[]>([])
  const [modelKey,setModelKey]=createSignal("")
  const [variant,setVariant]=createSignal("")
  const [changing,setChanging]=createSignal(false)
  const [modelProposal,setModelProposal]=createSignal('')
  const selected=()=>catalog().find(m=>`${m.providerID}/${m.id}`===modelKey())
  const modelLabel=(model:any)=>model?`${model.providerID}/${model.id} · ${model.variant??"provider default"}`:"Chưa xác định"
  const HealthDetails=(props:{member:any})=><Show when={props.member.health?.error}><div role="status"><small>{props.member.health.error.kind} · {props.member.health.error.type??"unknown"} · HTTP {props.member.health.error.status??"—"}</small><p>{props.member.health.error.message}</p><Show when={!props.member.health.error.retryable}><small>Không retry tự động. Cần sửa nguyên nhân lỗi trước.</small></Show></div></Show>
  const ExecutionDetails=(props:{member:any})=><div><small>Execution: {props.member.executionState??props.member.state} · Queue: {props.member.queuedCount??0}</small><small>Task: {props.member.taskID??"—"}</small><small>Started (assistant metadata): {props.member.startedAt?new Date(props.member.startedAt).toISOString():"Chưa quan sát"}</small><small>Admitted: {props.member.admittedAt??"—"}</small><small>Completed: {props.member.completedAt??"—"}</small></div>
  async function chooseModel(member:any) {
    const current=capture(),project=directory()
    try {
      const result=await readClient().rpc(TeamChatRPC).models({directory:project,action:"list"},{location:{directory:project}}) as any
      if(!current())return
      setCatalog(result.models);setModelRole(member.role)
      const model=member.selectedModel??member.effectiveModel??member.model
      setModelKey(model?`${model.providerID}/${model.id}`:"");setVariant(model?.variant??"")
    }catch(e){if(current())setError(errorText(e))}
  }
  async function changeModel() {
    const model=selected();if(!model||changing())return
    setModelProposal(`Đề xuất model cho @${modelRole()}: ${model.providerID}/${model.id}${variant()?` · ${variant()}`:''}. Chưa áp dụng; cần Owner review.`)
  }
  const [preview,setPreview]=createSignal("")
  const [uploading,setUploading]=createSignal("")
  const [visibility,setVisibility]=createSignal('private')
  const [reply,setReply]=createSignal("")
  let picker!:HTMLInputElement
  let history!:HTMLDivElement
  let follow=true
  async function workspace(action:string,payload:Record<string,unknown>={}) {
    const project=directory(),current=capture()
    try{
      const result=await readClient().rpc(TeamChatRPC).workspace({directory:project,action,payload},{location:{directory:project},signal:AbortSignal.timeout(15000)}) as any
      if(!current())throw new Error('STALE_GUI_SCOPE')
      return result
    }catch(e){if(!current())throw new Error('STALE_GUI_SCOPE');throw e}
  }
  async function upload(list:FileList|null) {
    if(!list||uploading()||busy())return
    const current=capture()
    try {for(const file of Array.from(list)) {
      if(file.size>8*1024*1024)throw new Error("File vượt 8 MiB")
      setUploading(`Đang tải ${file.name}…`)
      const base64=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(",")[1]);r.onerror=()=>reject(new Error("Không đọc được file"));r.readAsDataURL(file)})
      if(!current())return
      const result=await workspace("upload",{name:file.name,mime:file.type,base64,visibility:visibility()})
      if(!current())return
      setAttached(old=>[...old,result]);setFiles(old=>[...old,result])
    }}catch(e){if(current())setError(errorText(e))}finally{if(current()){setUploading("");if(picker)picker.value=""}}
  }
  async function openFile(file:Attachment,download=false) {
    const current=capture()
    try {
      if(download){const data=await workspace("download",{fileID:file.id});if(!current())return;const bytes=Uint8Array.from(atob(data.base64),(c:string)=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:"application/octet-stream"}));const a=document.createElement("a");a.href=url;a.download=data.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
      else {const data=await workspace("read",{fileID:file.id,offset:0,limit:24000});if(!current())return;setPreview(`${file.name}\n${file.limitation??""}\n\n${data.text||"Không có text preview; dùng Download."}`)}
    }catch(e){if(current())setError(errorText(e))}
  }
  const directory=()=>ctx.sessions.current()?.directory ?? ""
   const [loading,setLoading]=createSignal(false)
   async function load(sync=false) {
     if(!directory())return
     if(loading()){refreshPending=true;return}
    const project=directory(),current=capture()
    setLoading(true)
    try {
       const rpc=readClient().rpc(TeamChatRPC)
      const options={location:{directory:project},signal:AbortSignal.timeout(15000)}
      const result=sync ? await rpc.sync({directory:project},options) : await rpc.snapshot({directory:project},options)
      if(!current())return
       setState(previous=>{const next=result as Team;const messages=stableRows(previous.messages??[],next.messages??[]);return JSON.stringify(previous)===JSON.stringify(next)?previous:{...next,messages}})
      setError("")
       if((result as Team).status==="ready") {
         try{const native=await ownerAdminHistory(()=>ctx.sessions.current(),TeamChatRPC);if(!current())return;setNativeMessages(old=>stableRows(old,native));setTranscriptError('')}catch(e){if(!current())return;setTranscriptError(`Native transcript chưa resync; dữ liệu trước có thể cũ: ${errorText(e)}`)}
        const fileRows=(await workspace("list")).files
        if(!current())return
        const taskRows=(await workspace("tasks")).tasks
        if(!current())return
        const members=(await workspace("monitor")).members
        if(!current())return
        const first=await workspace('owner_requests',{limit:100})
        const requests=[...first.requests];let after=first.next
        while(after!==null){if(!current())return;const page=await workspace('owner_requests',{limit:100,after,asOf:first.asOf,snapshot:first.snapshot});requests.push(...page.requests);after=page.next}
        if(!current())return
         setFiles(old=>stableRows(old,fileRows));setTasks(old=>stableRows(old,taskRows));setMonitor(old=>JSON.stringify(old)===JSON.stringify(members)?old:members)
        if(JSON.stringify(ownerRequests())!==JSON.stringify(requests))setOwnerRequests(requests)
      }
      if(follow && history)queueMicrotask(()=>{if(current()&&history)history.scrollTop=history.scrollHeight})
    } catch(e) {if(current())setError(errorText(e))} finally {if(current()){setLoading(false);if(refreshPending){refreshPending=false;queueMicrotask(()=>void load())}}}
  }
  async function send() {
    if(busy()||uploading()||(!draft().trim()&&!attached().length)) return
    const current=capture()
    const sentDraft=draft(),sentFiles=attached(),sentReply=reply(),sentRecipient=recipient()
    setBusy(true);setError("")
    try {
      if(sentRecipient!=='admin'||sentFiles.length)throw Error('OWNER_SEND_ADMIN_TEXT_ONLY')
      const text=[sentReply?`Reply: ${sentReply}`:'',sentDraft.trim()].filter(Boolean).join('\n\n')
      ownerAttempt??={id:`msg_${crypto.randomUUID().replaceAll('-','')}`,text}
      if(ownerAttempt.text!==text)throw Error('OWNER_ADMISSION_UNCERTAIN: giữ nội dung cũ để retry cùng ID; không tự gửi nội dung mới')
      setSendStatus('Đang gửi vào native queue của Admin…')
      await ownerAdminSend(()=>ctx.sessions.current(),TeamChatRPC,ownerAttempt)
      ownerAttempt=undefined
      if(!current())return
      setSendStatus('Native queue đã nhận; đang chờ Admin. Chưa xác nhận phản hồi hoặc task DONE.')
      if(draft()===sentDraft)setDraft("");if(reply()===sentReply)setReply('');await load()
    }
    catch(e){if(!ownerAttempt?.binding)ownerAttempt=undefined;if(current()){setSendStatus('Gửi thất bại hoặc chưa rõ admission; không tự retry.');setError(errorText(e))}}finally{if(current())setBusy(false)}
  }
  createEffect(()=>{
    directory();activeThread();view()
    untrack(()=>{
    if(draftKey)drafts.set(draftKey,draft())
    draftKey=JSON.stringify([directory(),activeThread()])
    scope.invalidate();setLoading(false);setBusy(false);setUploading('');setChanging(false)
    setState({exists:false});setNativeMessages([]);setTranscriptError('');refreshPending=false;setSendStatus('');setTasks([]);setMonitor([]);setFiles([]);setOwnerRequests([])
    setAttached([]);setDraft(drafts.get(draftKey)??'');setReply('');setPreview('');setError('');setModelRole('');setCatalog([])
    setRequestStatus('');setRequestProject('');follow=true
    setRequestID('');setQuery('');setShowDetails(false);setModelProposal('')
    setTaskID('')
    void load()
    })
  })
  onMount(()=>{const timer=setInterval(()=>{void load()},30000);onCleanup(()=>clearInterval(timer))})
  createEffect(()=>{
    const host=ctx.sessions.current(),client=host?.server.client,connected=host?.server.connected
    if(!client||!connected)return
    let refreshTimer:ReturnType<typeof setTimeout>|undefined
    const refresh=()=>{if(refreshTimer!==undefined)return;refreshTimer=setTimeout(()=>{refreshTimer=undefined;void load()},100)}
    onCleanup(()=>clearTimeout(refreshTimer))
    untrack(()=>{void load(true)})
    const stop=client.rpc(TeamChatRPC).events.on('changed',event=>{
      if(event.data.directory===directory())refresh()
    })
    onCleanup(stop)
    const controller=new AbortController()
    void(async()=>{
      try{for await(const event of client.event.subscribe({signal:controller.signal})){
        if(controller.signal.aborted)return
        if(event.type==='server.connected'||('data' in event&&event.data&&'sessionID' in event.data&&event.data.sessionID===state().members?.admin?.sessionID))refresh()
      }}catch{if(!controller.signal.aborted)void load()}
    })()
    onCleanup(()=>controller.abort())
  })
  onCleanup(()=>scope.dispose())
  return <div class="ai-team-host"><div class="ai-team-pane" classList={{'show-conversations':showConversations(),'show-details':showDetails()}} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();void upload(e.dataTransfer?.files??null)}}>
    <nav class="team-nav" aria-label="Cuộc trò chuyện"><strong class="brand">AI Team <small>Không gian hội thoại</small></strong><span class="nav-section">Hội thoại</span><For each={['team',...roles]}>{role=>{const messages=()=>thread(role);const last=()=>messages().at(-1);return <ConversationItem title={role==='team'?'Team Room':roleLabel(role)} initials={role==='team'?'AI':role.slice(0,2).toUpperCase()} preview={last()?.text.replace(/\s+/g,' ').slice(0,100)||'Chưa có tin nhắn'} at={last()?.at} team={role==='team'} selected={isChat()&&activeThread()===role} onSelect={()=>selectThread(role)}/>}}</For></nav>
    <main class="team-main" classList={{'chat-view':isChat()}}><header><button class="mobile-back" aria-label="Mở danh sách hội thoại" onClick={()=>setShowConversations(true)}>Hội thoại</button><div class="chat-heading"><h3>{view()==='Team Chat'?'Team Room':view()==='Direct Messages'?roleLabel(recipient()):view()==='Tasks / Kanban'?'Tasks':view()==='Owner Requests'?'Requests':'Files'}</h3><small class="dim" title={directory()}>Project: {directory().split('/').filter(Boolean).pop()||'Chưa mở project'} · {isChat()?'Hội thoại · không phải trạng thái online':'Không gian nhóm'}</small></div><div class="header-actions"><input aria-label="Tìm tin nhắn" placeholder="Tìm tin nhắn…" value={query()} onInput={e=>setQuery(e.currentTarget.value)}/><button aria-label={`Thông báo: ${unresolved()} pending, ${inbox().unread} chưa xem`} onClick={()=>setView('Owner Requests')}>Requests <span role="status">{unresolved()}</span> pending <span class="unread-count">{inbox().unread} chưa xem</span></button><button aria-label="Cài đặt và giới hạn quyền" aria-expanded={showDetails()} onClick={()=>setShowDetails(!showDetails())}>Cài đặt</button></div></header>
    <nav class="content-tabs" aria-label="Nội dung"><For each={[['Direct Messages','Chat'],['Tasks / Kanban','Tasks'],['Owner Requests','Requests'],['Files & Documents','Files']]}>{([item,label])=><button aria-current={(item==='Direct Messages'?isChat():view()===item)?'page':undefined} onClick={()=>{setView(item);setShowConversations(false)}}>{label}</button>}</For></nav>
    <Show when={view()==='Owner Requests'}><section aria-label="Owner Requests">
      <div class="inbox-toolbar"><p>{unresolved()} pending · {inbox().unread} chưa xem · {ownerRequests().filter(r=>r.status==='EXPIRED').length} hết hạn</p>
      <label>Project <select value={requestProject()} onChange={e=>setRequestProject(e.currentTarget.value)}><option value="">Tất cả trong room hiện tại</option><option value={directory()}>{directory()}</option></select></label>
      <label>Trạng thái <select value={requestStatus()} onChange={e=>setRequestStatus(e.currentTarget.value)}><option value="">Tất cả</option><For each={['PENDING_REVIEW','SEEN','EXPIRED','DISMISSED']}>{status=><option value={status}>{status}</option>}</For></select></label>
      </div><div class="request-list"><For each={inbox().requests}>{request=><button id={`request-${request.requestID}`} class="request-row" classList={{unread:request.status==='PENDING_REVIEW'}} aria-label={`Mở yêu cầu: ${request.content}`} onClick={e=>openRequest(request.requestID,e.currentTarget)}><span class="request-title"><strong>{request.content}</strong><small>{request.status==='PENDING_REVIEW'?'Chưa xem · pending':request.status==='SEEN'?'Đã xem · pending':request.status}</small></span><span>{request.requester.role}</span><span title={request.project}>{request.project.split('/').filter(Boolean).pop()}</span><span>{request.risk}</span><time>{request.createdAt.slice(0,10)}</time></button>}</For></div>
      <Show when={!inbox().requests.length}><p>Không có yêu cầu khớp bộ lọc.</p></Show>
    </section></Show>
    <Show when={selectedRequest()}>{request=><section class="request-drawer" role="region" aria-label="Chi tiết yêu cầu" onKeyDown={e=>{if(e.key==='Escape')closeRequest()}}><button ref={requestClose} onClick={closeRequest}>Đóng chi tiết</button><h3>{request().content}</h3><p>{request().status} · {request().risk}</p><p>{request().scope}</p><dl><dt>Requester</dt><dd>{request().requester.role} · nhãn chưa xác thực</dd><dt>Project</dt><dd>{request().project}</dd><dt>Request ID</dt><dd>{request().requestID}</dd><dt>Tạo / hết hạn</dt><dd>{request().createdAt} / {request().expiresAt}</dd></dl><p>AUTHORIZATION_DISABLED · SEEN/DISMISSED không phải phê duyệt.</p><Show when={['PENDING_REVIEW','SEEN'].includes(request().status)}><button onClick={()=>void markRequest(request().requestID,'SEEN')}>Đánh dấu đã xem</button><button onClick={()=>void markRequest(request().requestID,'DISMISSED')}>Dismiss · không cấp quyền</button></Show></section>}</Show>
    <Show when={loading()}><div role="status">Đang tải project…</div></Show>
    <Show when={transcriptError()}><p role="status">{transcriptError()}</p></Show>
    <Show when={view()==='Team Chat'||view()==='Tasks / Kanban'}><div class="task-links" aria-label="Trao đổi và bàn giao theo task"><For each={tasks()}>{task=><button onClick={e=>openTask(task.id,e.currentTarget)}>{task.title} · @{task.assignee} · Bàn giao / discussion</button>}</For></div></Show>
    <Show when={handoff()}>{item=><section class="request-drawer" role="region" aria-label="Task handoff" onKeyDown={e=>{if(e.key==='Escape')closeTask()}}><button ref={taskClose} onClick={closeTask}>Đóng bàn giao</button><h3>{item().task.title}</h3><p>{roleLabel(item().task.assignee)} · {item().task.status} · Stage: UNKNOWN</p><p>{item().binding?JSON.stringify(item().binding):'BLOCKED: thiếu authenticated project/broker binding'}</p><p>Dependencies: {item().dependencies.join(', ')||'—'} · Revision: {item().binding?.revision??'UNKNOWN'}</p><h4>PLAN · tiêu chí đã lưu</h4><p>Phụ trách stage: UNKNOWN · tiến độ: UNKNOWN</p><For each={item().plan}>{criterion=><p>{criterion}</p>}</For><h4>CODE · source references</h4><p>Phụ trách task: {roleLabel(item().task.assignee)} · source author: UNKNOWN</p><pre>{JSON.stringify(item().source,null,2)}</pre><h4>TEST</h4><p>QA identity: UNKNOWN · NOT_VERIFIED · metadata không chứng minh QA độc lập</p><pre>{JSON.stringify(item().evidence??'Chưa có evidence khớp revision/epoch và project scope',null,2)}</pre><h4>REVIEW</h4><p>Reviewer identity: UNKNOWN · chưa xác minh độc lập</p><pre>{JSON.stringify(item().reviews,null,2)}</pre><h4>HANDOFF · file references</h4><p>Phụ trách stage: UNKNOWN · chưa có verified handoff</p><For each={item().files}>{id=><p>{id}<Show when={files().find(f=>f.id===id)}>{file=><button onClick={()=>void openFile(file())}>Preview</button>}</Show></p>}</For><h4>Trao đổi theo task</h4><For each={item().discussion}>{message=><p><b>{roleLabel(message.from)} tới {roleLabel(message.to)}</b> · {message.status}<br/>{message.text}</p>}</For><p>Quyết định cuối / câu hỏi chưa giải quyết: UNKNOWN nếu chưa có dữ liệu structured đã xác minh. Execution BLOCKED.</p></section>}</Show>
    <Show when={error()}><div class="warn" role="alert">{error()}</div></Show>
    <Show when={state().status === "ready"} fallback={<div>
      <p>Chưa có team hoạt động trong project này.</p>
      <p>Không tạo session thay thế. Mở project đã liên kết năm sessions hiện có.</p>
      <Show when={state().status==="partial"}><div class="warn">{state().error} — sửa cấu hình rồi bấm lại để tiếp tục.</div></Show>
    </div>}>
      <Show when={view()==="Files & Documents"}><div class="file-grid"><For each={files()}>{file=><div class="attachment"><b>{file.name}</b><small>{file.size.toLocaleString()} bytes · {file.mime}</small><small>{file.limitation}</small><button onClick={()=>void openFile(file)}>Preview</button><button onClick={()=>void openFile(file,true)}>Download</button></div>}</For><Show when={!files().length}><p>Chưa có file. Dùng Attach File hoặc kéo file vào panel.</p></Show></div></Show>
      <Show when={view()==="Tasks / Kanban"}><p class="task-safety dim">Safe-terminal chưa xác minh; model idle chỉ là trạng thái hội thoại.</p><div class="kanban"><For each={["todo","waiting","busy","working","blocked","uncertain","review","done"]}>{status=><Show when={tasks().some(t=>t.status===status)}><section><h4>{status}</h4><For each={tasks().filter(t=>t.status===status)}>{task=><article><b>{task.title}</b><small>@{task.assignee} · {task.priority} · {task.status}</small><p>{task.description}</p><code>{task.id}</code><small>Dependencies: {(task.dependencies??[]).join(', ')||'—'}</small><Show when={task.buildEvidence}><details><summary>Evidence · {task.buildEvidence.status}</summary><pre>{JSON.stringify(task.buildEvidence,null,2)}</pre></details></Show></article>}</For></section></Show>}</For><Show when={!tasks().length}><p>Chưa có công việc.</p></Show></div></Show>
      <Show when={["Team Chat","Direct Messages"].includes(view())}><div class="chat-history" ref={history} role="log" aria-label="Tin nhắn team" onScroll={()=>follow=history.scrollHeight-history.scrollTop-history.clientHeight<80}>
        <Show when={!thread(activeThread()).length}><p class="dim">Bắt đầu hội thoại. Chia sẻ summary và fileID; chỉ đọc tài liệu khi cần.</p></Show>
        <For each={thread(activeThread()).filter(m=>(!m.batchID||m.eventType==='batch.assigned')&&(!query()||`${m.text} ${m.from}`.toLowerCase().includes(query().toLowerCase())))}>{(msg)=><MessageBubble own={msg.from==='owner'} from={msg.from} to={msg.to} at={msg.at} status={messageStatus(msg.status)}>
          <div class="message-text"><ctx.ui.Markdown text={msg.text}/></div><Show when={msg.error}><div class="warn">{msg.error}</div></Show>
          <Show when={msg.correlation==='ambiguous-inputs'}><small>Phản hồi trong Admin session; chưa xác định prompt nguồn vì nhiều input xen ngang.</small></Show>
          <For each={msg.tools??[]}>{tool=><details><summary>Tool {tool.name} · {tool.status} · {tool.executed?'đã thực thi':'chưa có bằng chứng thực thi'}</summary><small>Call ID: {tool.id} · Native/MCP: chưa xác định từ message contract</small><Show when={tool.result}><pre>{tool.result}</pre></Show><Show when={tool.error}><pre>{tool.error}</pre></Show></details>}</For>
          <Show when={msg.eventType==='batch.assigned'}><details><summary>Tiến độ từng task</summary><For each={(state().messages??[]).filter(m=>m.batchID===msg.batchID&&m.taskID)}>{request=><section><b>@{request.to} · {request.taskID} · {request.status}</b><p>{state().tasks?.find(t=>t.id===request.taskID)?.status}</p><small>Dispatch {request.dispatchedAt??'—'} · Admitted {request.admittedAt??'—'} · Started {request.startedAt?new Date(request.startedAt).toISOString():'—'} · Completed {request.completedAt??'—'}</small><Show when={request.error}><p>{request.error}</p></Show><pre>{JSON.stringify(state().tasks?.find(t=>t.id===request.taskID)?.logs??[],null,2)}</pre></section>}</For></details></Show>
          <div class="message-actions"><button onClick={()=>void ctx.system.copy(msg.text)}>Copy</button><button onClick={()=>{setReply(`${msg.from}: ${msg.text.slice(0,300)}`);if(roles.includes(msg.from))setRecipient(msg.from)}}>Reply</button></div>
          <Show when={msg.taskID&&state().tasks?.find(t=>t.id===msg.taskID)}>{task=><button class="task-reference" onClick={e=>openTask(task().id,e.currentTarget)}>Task: {task().title} · {task().status}</button>}</Show>
          <For each={files().filter(f=>msg.text.includes(f.id))}>{file=><div class="attachment"><b>{file.name}</b><span class="role-badge">{file.visibility??'private'}</span><small>{file.size.toLocaleString()} bytes · revision: {file.revision??'—'}</small><small>fileID: {file.id}</small><button onClick={()=>void openFile(file)}>Preview</button><button onClick={()=>void openFile(file,true)}>Download</button></div>}</For>
        </MessageBubble>}</For>
      </div></Show>
      <Show when={preview()}><section class="file-preview"><button onClick={()=>setPreview("")}>Đóng preview</button><pre>{preview()}</pre></section></Show>
       <Show when={isChat()}><div class="composer">
      <Show when={reply()}><div class="dim">Đang trả lời {reply()} <button onClick={()=>setReply("")}>Hủy</button></div></Show>
      <For each={attached()}>{file=><div class="attachment">{file.name}<button onClick={()=>setAttached(list=>list.filter(f=>f.id!==file.id))}>Bỏ đính kèm</button></div>}</For>
      <Show when={uploading()}><div role="status">{uploading()}</div><progress aria-label="Đang tải file"/></Show>
      <input ref={picker} type="file" multiple hidden onChange={e=>void upload(e.currentTarget.files)}/>
       <details class="composer-menu" onKeyDown={e=>{if(e.key==='Escape'){e.currentTarget.open=false;e.currentTarget.querySelector('summary')?.focus()}}}><summary aria-label="Thêm đính kèm và tùy chọn">+</summary><div class="composer-options"><select aria-label="File visibility" value={visibility()} onChange={e=>setVisibility(e.currentTarget.value)}><option value="private">Private (mặc định)</option><option value="restricted">Restricted (share từng người)</option><option value="team">Team Shared (project này)</option></select>
      <ComposerTools uploading={!!uploading()} onAttach={()=>picker.click()} onMention={role=>{setRecipient(role);setDraft(value=>`${value}${value&&!value.endsWith(' ')?' ':''}@${role} `)}} onEmoji={value=>setDraft(draft=>draft+value)}/>
      <select aria-label="Người nhận" value={recipient()} onChange={(e)=>setRecipient(e.currentTarget.value)}>
        <For each={roles}>{role=><option value={role}>@{role}</option>}</For>
       </select><small>Đính kèm cấp quyền cho người nhận khi gửi.</small><button disabled={busy()} onClick={()=>void load(true)}>Đồng bộ phản hồi</button></div></details>
      <textarea aria-label="Task hoặc câu hỏi" rows={2} placeholder={`Nhắn tới @${recipient()}…`} value={draft()} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.keyCode!==229){e.preventDefault();void send()}}} onInput={(e)=>{setDraft(e.currentTarget.value);const mention=e.currentTarget.value.match(/@(admin|frontend|backend|devops|qa)\b/);if(mention)setRecipient(mention[1])}} />
        <Show when={sendStatus()}><small role="status">{sendStatus()}</small></Show>
        <button class="send-button" aria-label={`Gửi tới @${recipient()}`} title="Native queue: chỉ Admin, text; target kiểm lại từ host và registry khi gửi" disabled={recipient()!=='admin' || !!attached().length || !ctx.sessions.current()?.server.connected || busy() || !!uploading() || !draft().trim()} onClick={send}>{busy()?'Đang gửi…':'Gửi'}</button>
       </div></Show>
    </Show>
    <Show when={modelRole()}><section role="region" aria-label="Đề xuất model"><h4>Đề xuất model · @{modelRole()}</h4><select aria-label="Model" value={modelKey()} onChange={e=>{setModelKey(e.currentTarget.value);setVariant("")}}><option value="">Chọn model từ server</option><For each={catalog()}>{m=><option value={`${m.providerID}/${m.id}`}>{m.providerID} / {m.name}</option>}</For></select><select aria-label="Reasoning variant" value={variant()} onChange={e=>setVariant(e.currentTarget.value)}><option value="">Provider default</option><For each={selected()?.variants??[]}>{v=><option value={v}>{v}</option>}</For></select><button disabled={!selected()} onClick={()=>void changeModel()}>Soạn đề xuất · không áp dụng</button><p role="status">{modelProposal()}</p><button onClick={()=>setModelRole("")}>Đóng</button></section></Show>
    </main>
    <Show when={showDetails()}><aside class="settings-panel" aria-label="Cài đặt và chi tiết kỹ thuật"><button onClick={()=>setShowDetails(false)}>Đóng cài đặt</button><h3>Project & giới hạn quyền</h3><p>{directory()}</p><details><summary>Quyền & an toàn</summary><p>AUTHORIZATION_DISABLED · Authenticated Owner: BLOCKED.</p><p>AWS/Azure login và execution grants không khả dụng. Model idle không phải safe-terminal; OS cleanup NOT VERIFIED.</p><button disabled title="Thiếu supported containment/cleanup boundary">Emergency Stop · chưa khả dụng</button><p>ACTIVATION_READY=false · INSTALL_READY=NO · PHASE2=BLOCKED</p><button onClick={()=>void metadata('owner_requests_expire')}>Lưu trạng thái hết hạn · metadata only</button></details><details><summary>Thông tin hội thoại hiện tại</summary><Show when={monitor().find(m=>m.role===recipient())}>{member=><><ExecutionDetails member={member()}/><HealthDetails member={member()}/><p>{modelLabel(member().selectedModel??member().effectiveModel)}</p><button onClick={()=>void chooseModel(member())}>Change Model</button></>}</Show><p>Trạng thái transcript không phải read receipt hoặc verified cleanup.</p></details></aside></Show>
  </div></div>
}

const definition=Plugin.define({
  i18n:{en:{"panel.title":"AI Team Chat","command.open":"Open AI Team Chat"}},
  main(ctx){ctx.log.write("info","AI Team Chat GUI main loaded",{version:ctx.app.version})},
  setup(ctx){
    ctx.add(Style,style+chatStyle)
    const tab={id:"main",get title(){return "AI Team Chat"},closable:"compact" as const,fallback:true}
    ctx.add(Panel,{
      id:"main",region:"side",wide:true,
      list:(input)=>input.open.includes("main") ? [tab] : [],
      render:()=> <TeamPane/>,
    })
    let opened=false
    createEffect(()=>{
      const session=ctx.sessions.current()
      if(!opened && session && ctx.layout.ready()) {
        opened=true
        ctx.layout.open(`${ctx.id}:main`,session,{tab:"select"})
      }
    })
    ctx.add(Command,()=>({
      id:"open",title:ctx.t("command.open"),keywords:"ai team chat sessions",enabled:!!ctx.sessions.current(),
      run:()=>{const session=ctx.sessions.current();if(session) ctx.layout.open(`${ctx.id}:main`,session)}
    }))
    ctx.add(MenuItem,()=>{
      const session=ctx.sessions.current()
      return {menu:"session.panel" as const,id:"open",title:"AI Team Chat",icon:"folder" as const,
        opened:!!session && ctx.layout.state(`${ctx.id}:main`,session)!=="closed",
        run:()=>{if(session)ctx.layout.open(`${ctx.id}:main`,session)}
      }
    })
  }
})
export default definition
