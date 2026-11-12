import {usePlugin} from '@opencode/plugin/gui'
import {createEffect,createMemo,createSignal,For,onCleanup,onMount,Show} from 'solid-js'
import {PilotRPC} from './pilot-rpc'
import {PilotOwner} from './pilot-owner-ipc'
import {openAdminChat} from './pilot-admin-chat.mjs'
import {checkedTeam,connectionLabel,insertAdminDraft,memberActivity,messageTime,pilotError,ownerRecipient,taskDraft,workflowDraft} from './pilot-ui.mjs'
import {PeerModelSelector,PilotRouting} from './pilot-routing'
import {memberLabel,PEER_GENERATION} from './peer-team.mjs'
import {memberTasks,taskActive,taskDone,taskState,taskProgress,uniqueMessages} from './peer-presentation.mjs'
import {SafeReport} from './safe-report'

const peerShort=(id:string)=>{
  const m=/^peer-(\d+)$/i.exec(id??'')
  if(m)return `P${m[1]}`
  if(id==='owner')return 'OW'
  return (id??'P').slice(0,2).toUpperCase()
}
const peerDisplay=(id:string,members:any[]=[])=>{
  if(id==='owner')return 'Owner'
  const found=members.find((m:any)=>(m.id??m.role)===id||m.role===id)
  if(found)return memberLabel(found)
  const m=/^peer-(\d+)$/i.exec(id??'')
  return m?`Peer ${m[1]}`:id
}
const isFixtureArtifact=(a:any,tasks:any[]=[])=>{
  if(!a)return false
  if(a.fixtureProvenance==='TEST_FIXTURE'||String(a.name??'').includes('[TEST_FIXTURE]'))return true
  const t=tasks.find((x:any)=>x.id===a.taskID)
  return Boolean(t&&String(t.text??'').includes('[TEST_FIXTURE]'))
}

export function PilotPane(){
  const ctx=usePlugin()
  const [snapshot,setSnapshot]=createSignal<any>()
  const [actionError,setError]=createSignal(''),[rpcError,setRPCError]=createSignal(''),[notice,setNotice]=createSignal('')
  const error=()=>actionError()||rpcError()
  createEffect(()=>{ctx.sessions.current()?.directory;setRPCError('')})
  const [loading,setLoading]=createSignal(true),[draft,setDraft]=createSignal('')
  const [creating,setCreating]=createSignal(false),[sending,setSending]=createSignal(false)
  const [task,setTask]=createSignal(''),[assignee,setAssignee]=createSignal('worker-1')
  const [limit,setLimit]=createSignal(100),[filter,setFilter]=createSignal('')
  const [file,setFile]=createSignal('')
  const [recipient,setRecipient]=createSignal('team')
  const [activeTab,setActiveTab]=createSignal<'chat'|'tasks'|'plan'|'reports'|'activity'>('chat')
  const [selectedPeerID,setSelectedPeerID]=createSignal<string|null>(null)
  const [showOverview,setShowOverview]=createSignal(true)
  const [showRouting,setShowRouting]=createSignal(false)
  let pendingSend:{key:string,text:string,recipient:string,requestID:string}|undefined
  const [planSource,setPlanSource]=createSignal('text'),[planBody,setPlanBody]=createSignal(''),[planCriteria,setPlanCriteria]=createSignal(''),[scopeRef,setScopeRef]=createSignal('')
  let pendingPlan:{key:string,body:string,requestID:string}|undefined
  const [taskPeer,setTaskPeer]=createSignal(''),[taskReviewer,setTaskReviewer]=createSignal(''),[taskFiles,setTaskFiles]=createSignal(''),[taskCriteria,setTaskCriteria]=createSignal(''),[taskChecks,setTaskChecks]=createSignal(''),[taskDeps,setTaskDeps]=createSignal<string[]>([])
  let pendingTask:{key:string,body:string,requestID:string}|undefined
  const lines=(text:string)=>text.split('\n').map(s=>s.trim()).filter(Boolean)
  async function createTask(){
    const c=ctx.sessions.current(),p=latestPlan(),key=currentKey();if(!c||!p||!valid()||rpcError()||sending())return
    const body=JSON.stringify({operation:'createTask',projectID:team().projectID,teamID:team().teamID,canonicalRoot:c.directory,planID:p.planID,planVersion:p.version,text:task().trim(),dependencies:taskDeps(),files:lines(taskFiles()),requiredCapabilities:['collaboration'],acceptanceCriteria:lines(taskCriteria()),requiredChecks:lines(taskChecks()),...(taskPeer().trim()?{assignedPeer:taskPeer().trim().replace(/^@/,'')}:{ }),...(taskReviewer()?{reviewPeer:taskReviewer()}:{})})
    if(pendingTask?.key!==key||pendingTask.body!==body)pendingTask={key,body,requestID:crypto.randomUUID()}
    setSending(true);setError('')
    try{
      await ctx.main(PilotOwner).publishPlan({sessionID:c.id,directory:c.directory,planJSON:JSON.stringify({...JSON.parse(body),requestID:pendingTask.requestID})})
      pendingTask=undefined
      if(currentKey()===key){setTask('');setNotice('Đã tạo task; phân công không cấp quyền thực thi.');await refresh()}
    }catch(e){if(currentKey()===key)setError(pilotError(e))}finally{setSending(false)}
  }

  async function cancelExecution(record:any){
    const c=ctx.sessions.current(),key=currentKey();if(!c||!valid()||rpcError()||sending())return
    setSending(true);setError('')
    try{await ctx.main(PilotOwner).publishPlan({sessionID:c.id,directory:c.directory,planJSON:JSON.stringify({operation:'cancelExecution',requestID:crypto.randomUUID(),executionID:record.id,identity:record.identity})});if(currentKey()===key)await refresh()}
    catch(e){if(currentKey()===key)setError(pilotError(e))}finally{setSending(false)}
  }
  async function toggleCollaboration(){
    const c=ctx.sessions.current(),key=currentKey();if(!c||!valid()||rpcError()||sending())return
    setSending(true);setError('')
    try{await ctx.main(PilotOwner).publishPlan({sessionID:c.id,directory:c.directory,planJSON:JSON.stringify({operation:'collaboration',requestID:crypto.randomUUID(),enabled:!team()?.collaboration?.enabled})});if(currentKey()===key)await refresh()}
    catch(e){if(currentKey()===key)setError(pilotError(e))}finally{setSending(false)}
  }
  async function closeDiscussion(){
    const c=ctx.sessions.current(),p=latestPlan(),key=currentKey();if(!c||!p||!valid()||rpcError()||sending())return
    setSending(true);setError('')
    try{await ctx.main(PilotOwner).publishPlan({sessionID:c.id,directory:c.directory,planJSON:JSON.stringify({operation:'closeDiscussion',requestID:crypto.randomUUID(),planID:p.planID,planVersion:p.version,digest:p.digest})});if(currentKey()===key)await refresh()}
    catch(e){if(currentKey()===key)setError(pilotError(e))}finally{setSending(false)}
  }
  async function reviewSharedPlan(decision:'approve'|'reject'){
    const c=ctx.sessions.current(),p=team()?.plans?.at(-1),key=currentKey();if(!c||!p||!valid()||rpcError()||sending())return
    setSending(true);setError('')
    try{
      await ctx.main(PilotOwner).publishPlan({sessionID:c.id,directory:c.directory,planJSON:JSON.stringify({requestID:crypto.randomUUID(),planID:p.planID,expectedVersion:p.version,digest:p.digest,decision})})
      if(currentKey()===key)await refresh()
    }catch(e){if(currentKey()===key)setError(pilotError(e))}finally{setSending(false)}
  }
  async function publishPlan(){
    const c=ctx.sessions.current(),key=currentKey();if(!c||!valid()||rpcError()||sending())return
    const previous=team()?.plans?.at(-1)
    const body=JSON.stringify({expectedVersion:previous?.version??0,...(previous?{planID:previous.planID}:{}),[planSource()]:planBody(),acceptanceCriteria:planCriteria().split('\n').map(s=>s.trim()).filter(Boolean),approvedScopeRef:scopeRef()})
    if(pendingPlan?.key!==key||pendingPlan?.body!==body)pendingPlan={key,body,requestID:crypto.randomUUID()}
    setSending(true);setError('')
    try{
      await ctx.main(PilotOwner).publishPlan({sessionID:c.id,directory:c.directory,planJSON:JSON.stringify({...JSON.parse(body),requestID:pendingPlan.requestID})})
      pendingPlan=undefined
      if(currentKey()===key){setNotice('Đã lưu shared plan; không cấp execution.');await refresh()}
    }catch(e){if(currentKey()===key)setError(pilotError(e))}finally{setSending(false)}
  }
  const [report,setReport]=createSignal<any>(),[reportLoading,setReportLoading]=createSignal(false)
  const [atBottom,setAtBottom]=createSignal(true),[unread,setUnread]=createSignal(0)
  let messageList:HTMLDivElement|undefined,previousMessages:string[]=[]
  let reportRequest=0
  function scrollBottom(){if(messageList){messageList.scrollTop=messageList.scrollHeight;setAtBottom(true);setUnread(0)}}
  createEffect(()=>{
    const ids=allMessages().map((m:any)=>m.id),added=previousMessages.length?ids.filter((id:string)=>!previousMessages.includes(id)).length:0
    previousMessages=ids
    if(atBottom())queueMicrotask(scrollBottom)
    else if(added)setUnread(n=>n+added)
  })
  function older(){const el=messageList;if(!el)return;const height=el.scrollHeight,top=el.scrollTop;setLimit(v=>v+100);queueMicrotask(()=>{el.scrollTop=top+el.scrollHeight-height})}
  async function viewReport(id:string){
    const binding=valid(),key=currentKey(),request=++reportRequest;if(!binding)return
    setReportLoading(true);setError('')
    try{const result=await ctx.sessions.current()!.server.client.rpc(PilotRPC).report({directory:binding.directory,id},{location:{directory:binding.directory}});if(currentKey()===key&&request===reportRequest)setReport(result)}catch(e){if(currentKey()===key&&request===reportRequest)setError(pilotError(e))}finally{if(request===reportRequest)setReportLoading(false)}
  }
  async function exportReport(copy=false){
    const value=report(),key=currentKey();if(!value||!valid())return
    try{if(copy)await ctx.system.copy(value.content);else await ctx.system.save({name:`${value.id}.md`,content:value.content})}catch(e){if(currentKey()===key)setError(pilotError(e))}
  }
  let sequence=0,disposed=false,busy=false,lastJSON=''
  const currentKey=()=>{const c=ctx.sessions.current();return c?`${c.server.id}:${c.directory}`:''}
  const valid=()=>snapshot()?.key===currentKey()?snapshot():undefined
  const team=()=>valid()?.team?.status==='unprovisioned'?undefined:valid()?.team
  const allMessages=createMemo<any[]>((previous=[])=>{const old=new Map(previous.map(m=>[m.id,m]));return uniqueMessages(team()?.messages??[]).map((m:any)=>JSON.stringify(old.get(m.id))===JSON.stringify(m)?old.get(m.id):m)})
  const messages=createMemo(()=>{const query=filter().toLowerCase();return allMessages().filter((m:any)=>!query||`${m.text} ${m.from} ${m.to} ${m.taskID??''}`.toLowerCase().includes(query))})
  const visible=createMemo(()=>messages().slice(-limit()))
  const done=()=>team()?.tasks.filter(taskDone).length??0
  const runningPeers=()=>team()?.members?.filter((m:any)=>m.activity==='running').length??0
  const latestPlan=()=>team()?.plans?.at(-1)
  const selectedPeer=createMemo(()=>{
    const id=selectedPeerID()
    if(!id||!team()?.members)return null
    return team().members.find((m:any)=>(m.id??m.role)===id||m.role===id)??null
  })
  const tasksByColumn=createMemo(()=>{
    const all=team()?.tasks??[]
    const todo:any[]=[],doing:any[]=[],review:any[]=[],doneList:any[]=[]
    for(const t of all){
      const st=taskState(t)
      if(['DONE'].includes(st))doneList.push(t)
      else if(['REVIEW','SUBMITTED','INTEGRATED'].includes(st))review.push(t)
      else if(['CLAIMED','RUNNING','WORKING','REWORK','BLOCKED'].includes(st))doing.push(t)
      else todo.push(t)
    }
    return {todo,doing,review,done:doneList}
  })

  createEffect(()=>{currentKey();sequence++;reportRequest++;setReportLoading(false);setRecipient('team');pendingSend=undefined;setDraft('');setTask('');setTaskPeer('');setTaskReviewer('');setTaskFiles('');setTaskCriteria('');setTaskChecks('');setTaskDeps([]);pendingTask=undefined;setFile('');setPlanBody('');setPlanCriteria('');setScopeRef('');pendingPlan=undefined;setFilter('');setLimit(100);setNotice('');setError('');setReport(undefined);setSelectedPeerID(null);previousMessages=[];setUnread(0);setAtBottom(true);queueMicrotask(()=>void refresh())})
  async function refresh(){
    if(busy||disposed)return
    const current=ctx.sessions.current(),request=++sequence
    if(!current){setSnapshot(undefined);setLoading(false);return}
    busy=true;setLoading(true)
    try{
       const value=checkedTeam(await current.server.client.rpc(PilotRPC).snapshot({directory:current.directory},{location:{directory:current.directory}}))
       const activity=await current.server.client.session.active().catch(()=>null)
       value.members=value.members.map((member:any)=>({...member,activity:memberActivity({id:member.sessionID},activity)}))
      const active=ctx.sessions.current()
      if(!disposed&&request===sequence&&active?.id===current.id&&active.server.id===current.server.id&&active.directory===current.directory){
        const json=JSON.stringify(value)
        if(!valid()||json!==lastJSON){setSnapshot({team:value,serverID:current.server.id,directory:current.directory,key:currentKey()});lastJSON=json}
        setRPCError('')
      }
    }catch(e){const active=ctx.sessions.current();if(!disposed&&request===sequence&&active?.id===current.id&&active.server.id===current.server.id&&active.directory===current.directory){setRPCError(`Dữ liệu cũ; chưa xác minh kết nối. ${pilotError(e)}`)}}
    finally{busy=false;if(!disposed)setLoading(false)}
  }
  function act(action:()=>void){setNotice('');try{action()}catch(e){setError(pilotError(e))}}
  function prepareTask(){act(()=>{setDraft(taskDraft(task(),assignee()));setNotice('Yêu cầu đã soạn tại panel; chưa tạo task, chưa gửi.');})}
  function insert(){act(()=>{insertAdminDraft(ctx,valid(),draft());setNotice('Đã yêu cầu chèn draft vào native composer. Chưa gửi; kiểm tra trước khi gửi.');})}
  async function handleCreateTeam(){
    const current=ctx.sessions.current()
    if(!current){setError('Mở session trước.');return}
      const upgrading=team()?.isolation==='read-only'
      setCreating(true);setError('');setNotice(upgrading?'Đang chuyển team sang Git worktree…':'Đang khởi tạo Peer Team…')
    try{
      await ctx.main(PilotOwner).authorizeCreate({sessionID:current.id,directory:current.directory})
      setNotice(upgrading?'Đã chuyển team sang Git worktree; giữ plan/chat/model. Chưa gửi prompt hoặc cấp execution.':'Đã tạo AI Team; chưa gửi prompt hoặc cấp execution.')
      await refresh()
    }catch(e){
      setError(pilotError(e))
      setNotice('')
    }finally{
      setCreating(false)
    }
  }
  async function handleSendMessage(){
    if(sending())return
    const current=ctx.sessions.current()
    if(!current||!valid()||rpcError()){setError('Cần làm mới kết nối project trước khi gửi.');return}
    if(!draft().trim()){setError('Nhập nội dung tin nhắn.');return}
    setSending(true);setError('');setNotice('')
    let to:string
    try{to=ownerRecipient(team(),recipient())}catch(e){setSending(false);setError(pilotError(e));return}
    const key=currentKey(),text=draft().trim()
    if(pendingSend?.key!==key||pendingSend?.text!==text||pendingSend?.recipient!==to)pendingSend={key,text,recipient:to,requestID:crypto.randomUUID()}
    try{
      await ctx.main(PilotOwner).send({sessionID:current.id,directory:current.directory,recipient:to,text,requestID:pendingSend!.requestID})
      pendingSend=undefined
      if(currentKey()!==key)return
      if(draft().trim()===text)setDraft('')
      setNotice(team()?.collaboration?.enabled?'Đã lưu và xử lý hàng đợi gửi session; xem trạng thái giao nhận.':'Đã lưu; phối hợp tự động đang tắt, chưa gửi session.')
      await refresh()
    }catch(e){
      if(currentKey()===key)setError(pilotError(e))
    }finally{
      setSending(false)
    }
  }
  async function toggleExecution(refreshGrant=false){
    const c=ctx.sessions.current(),p=latestPlan(),key=currentKey();if(!c||!p||!valid()||rpcError()||sending())return
    setSending(true);setError('')
    try{
      await ctx.main(PilotOwner).publishPlan({sessionID:c.id,directory:c.directory,planJSON:JSON.stringify({operation:'execution',requestID:crypto.randomUUID(),planID:p.planID,planVersion:p.version,digest:p.digest,...(!refreshGrant&&team()?.executionPolicy&&!team()?.executionPolicy?.revokedAt?{revoke:true}:{policy:{maxActive:4,maxAttemptsPerTask:5,maxCalls:40,timeoutMs:900000,models:team().members.map((m:any)=>m.modelDefault)}})})})
      if(currentKey()===key)await refresh()
    }catch(e){if(currentKey()===key)setError(pilotError(e))}finally{setSending(false)}
  }
  function openFile(){act(()=>{
    const current=ctx.sessions.current(),screen=ctx.screen.current()
    if(!valid()||!current||!screen||!file().trim())throw Error('Chọn project và nhập path file.')
    const raw=file().trim()
    if(raw.startsWith('/')||raw.includes('\\')||raw.split('/').includes('..')||/[\x00-\x1f]/.test(raw)||/^[a-z][a-z\d+.-]*:/i.test(raw))throw Error('Chỉ mở file trong workspace hiện tại.')
    const path=screen.file.resolve(raw)
    if(screen.file.absolute(path)||path.split('/').includes('..')||/^[a-z][a-z\d+.-]*:/i.test(path))throw Error('Chỉ mở file trong workspace hiện tại.')
    if(!ctx.links.open({href:path,session:current,exact:true}))throw Error('Host không có file handler cho path này.')
  })}
  onMount(()=>{void refresh();const timer=setInterval(()=>{if(typeof document==='undefined'||!document.hidden)void refresh()},2000);onCleanup(()=>{disposed=true;clearInterval(timer);sequence++})})

  return <section class="pilot-workspace b31-workspace" aria-label="AI Team V0.8">
    {/* 1. COMPACT TEAM HEADER */}
    <header class="pilot-header b31-header">
      <div class="b31-header-left">
        <strong class="b31-brand">AI Team <small>V0.8</small></strong>
        <button class="b31-project-btn" title={team()?.canonicalRoot??ctx.sessions.current()?.directory} onClick={()=>act(()=>{const c=ctx.sessions.current();if(!c)throw Error('Mở session trước.');ctx.layout.project(c.server.id,'Chọn project AI Team')})}>
          Project: {team()?.canonicalRoot?.split('/').at(-1)??ctx.sessions.current()?.project?.name??ctx.sessions.current()?.directory?.split('/').at(-1)??'Chưa chọn'}
        </button>
        <Show when={team()}>
          <button type="button" disabled={sending()||!!rpcError()} onClick={toggleCollaboration}>{team()?.collaboration?.enabled?'Tạm dừng phối hợp':'Bật phối hợp tự động'}</button>
          <span class={`b31-pill ${latestPlan()?.ownerDecision==='approve'?'is-approved':latestPlan()?.ownerDecision==='reject'?'is-blocked':'is-pending'}`} title="Trạng thái Shared Plan">
            PLAN v{latestPlan()?.version??0} {latestPlan()?.ownerDecision==='approve'?'APPROVED':(latestPlan()?.ownerDecision??'PENDING').toUpperCase()}
          </span>
          <span class="b31-pill">{team().members.length} Peers</span>
          <span class="b31-pill" title="Nguồn: session.active() & task graph">
            {runningPeers()} Running · {done()}/{team().tasks.length} Done
          </span>
          <button type="button" disabled={sending()||!!rpcError()||latestPlan()?.ownerDecision!=='approve'} onClick={()=>toggleExecution()}>{team()?.executionPolicy&&!team()?.executionPolicy?.revokedAt?'Thu hồi execution':'Cấp quyền execution'}</button>
          <Show when={team()?.executionPolicy}><button type="button" disabled={sending()||!!rpcError()} onClick={()=>toggleExecution(true)}>Ký lại execution</button></Show>
          <span class="b31-pill" title="Scoped worktree execution; native edit/shell remain denied">
             Execution: {!rpcError()&&team()?.executionAuthorization?.authorized===true?'WORKTREE AUTHORIZED':`BLOCKED · ${rpcError()?'Mất kết nối':team()?.executionAuthorization?.reason??'Chưa xác minh quyền'}`}
          </span>
        </Show>
      </div>
      <div class="b31-header-right">
        <span class="pilot-badge" role="status">{connectionLabel({selected:!!ctx.sessions.current(),loading:loading(),error:rpcError(),status:valid()?.team?.status})}</span>
        <Show when={team()}>
          <button type="button" class="b31-btn-ghost" aria-pressed={showRouting()} onClick={()=>setShowRouting(v=>!v)}>Routing</button>
          <button type="button" class="b31-btn-ghost" aria-pressed={showOverview()} onClick={()=>setShowOverview(v=>!v)}>Overview</button>
        </Show>
        <button type="button" class="b31-btn-ghost" onClick={()=>act(()=>ctx.layout.settings())}>Settings</button>
        <Show when={team()?.mode==='peer'&&team()?.isolation==='read-only'}><button type="button" class="b31-btn-ghost" disabled={creating()} onClick={handleCreateTeam}>Chuyển sang Git worktree</button></Show>
        <button type="button" class="b31-btn-ghost" title="Chỉ đọc lại trạng thái; không tạo worktree hoặc gửi prompt" disabled={loading()} onClick={()=>void refresh()}>Làm mới</button>
      </div>
    </header>

    <p class="pilot-safety b31-safety-bar">
      <span>Chat session: {team()?.collaboration?.enabled?'BẬT':'TẠM DỪNG'} · Quyền thực thi code tách riêng · {team()?.isolation??'worktree + bwrap-v1'} · Gen: {team()?.runtime?.generation??PEER_GENERATION}</span>
    </p>

    <Show when={error()}><div role="alert" class="pilot-error b31-banner-error"><p>{actionError()?'Thao tác thất bại: ':'Đọc trạng thái thất bại: '}{error()}</p><Show when={actionError()}><button type="button" onClick={()=>setError('')}>Đóng lỗi thao tác</button></Show></div></Show>
    <Show when={notice()}><p role="status" class="b31-banner-notice">{notice()}</p></Show>
    <Show when={loading()&&!team()}><p role="status" class="b31-loading">Đang tải team…</p></Show>

    <Show when={!loading()&&!error()&&valid()?.team?.status==='unprovisioned'}>
      <div class="pilot-unprovisioned b31-unprovisioned">
        <h3>Khởi tạo AI Team cho project hiện tại</h3>
        <p>Default: 4 peers ngang hàng (Peer 1..4). Git: worktree riêng cho mỗi Peer. Không Git: collaboration mode, code editing disabled.</p>
        <button class="b31-btn-primary" disabled={creating()} onClick={handleCreateTeam}>{creating()?'Đang tạo team…':'Tạo Peer Team (4 AI)'}</button>
      </div>
    </Show>

    <Show when={team()}>
      {/* Advanced Model Routing Panel (kept before .pilot-columns for contract invariant) */}
      <details class="pilot-routing-panel" classList={{'is-hidden':!showRouting()}} open={showRouting()} onToggle={e=>setShowRouting(e.currentTarget.open)}>
        <summary>Model routing · cấu hình và trạng thái native ({team().members.length} Peers)</summary>
        <PilotRouting team={team()} serverID={valid().serverID}/>
      </details>

      {/* 2. FOUR PEER STRIP (70% Ensemble monitoring + session/model access) */}
      <aside aria-label="Thành viên" class="pilot-members" tabindex="0">
        <div class="b31-peer-strip">
        <div class="b31-peer-strip-grid">
          <For each={team().members}>{(m:any,idx)=>{
            const peerKey=()=>m.id??m.role
            const tasks=()=>memberTasks(team(),m)
            const current=()=>tasks().find(taskActive)
            const doneCount=()=>tasks().filter(taskDone).length
            const totalCount=()=>tasks().length
            const sel=()=>m.model?.selection??m.modelPreference?.observed??m.modelDefault
            const isSelected=()=>selectedPeerID()===peerKey()
            const actState=()=>m.activity??'unavailable'
            const curTaskState=()=>current()?taskState(current()):null
            return <article aria-label={`Member ${memberLabel(m)}`} class="b31-peer-card" classList={{'is-selected':isSelected(),'is-running':actState()==='running'}}>
              <div class="b31-peer-card-top">
                <button type="button" class="b31-peer-identity" aria-label={`Chi tiết ${memberLabel(m)}`} onClick={()=>setSelectedPeerID(isSelected()?null:peerKey())}>
                  <span class={`b31-peer-avatar peer-color-${(idx()%4)+1}`}>{peerShort(peerKey())}</span>
                  <strong>{memberLabel(m)}</strong>
                </button>
                <div class="b31-peer-badges">
                  <span class={`b31-activity-badge is-${actState()}`} title="Nguồn: session.active() · không suy từ task">
                    <span class="b31-dot"/>
                    {actState()==='running'?'Running':actState()==='idle'?'Idle':'Unavailable'}
                  </span>
                  <Show when={curTaskState()}>
                    <span class={`b31-task-pill is-${curTaskState()!.toLowerCase()}`}>{curTaskState()}</span>
                  </Show>
                </div>
              </div>

              <div class="b31-peer-model-row" onClick={()=>setSelectedPeerID(isSelected()?null:peerKey())} title="Click để mở Model Selector & chi tiết Peer">
                <span class="b31-model-name pilot-truncate">
                  {sel()?`${sel().providerID} / ${sel().id??sel().modelID}`:'Chưa ghim model native'}
                </span>
                <span class="b31-variant-pill">{sel()?.variant??'default'}</span>
              </div>

              <div class="b31-peer-task-row">
                <small class="pilot-truncate" title={current()?.text??(totalCount()?`Hoàn tất ${doneCount()}/${totalCount()} tasks`:'Không có task active')}>
                  {current()?current().text.replace(/^\[TEST_FIXTURE\]\s*/,''):totalCount()?`Đã xong ${doneCount()}/${totalCount()} tasks`:'Không có task active'}
                </small>
                <span class="b31-peer-progress-label">{doneCount()}/{totalCount()}</span>
              </div>
              <progress max={totalCount()||1} value={doneCount()} aria-label={`Tiến độ ${memberLabel(m)}`}/>

              <div class="b31-peer-card-actions">
                <button type="button" class="b31-peer-mini-btn" aria-label={`Mở session ${m.role}`} onClick={()=>act(()=>{if(!valid())throw Error('Snapshot đã đổi.');ctx.tabs.open({server:valid().serverID,id:m.sessionID},{focus:true})})}>Session ↗</button>
                <button type="button" class="b31-peer-mini-btn" aria-label={`Nhắc @${m.role}`} onClick={()=>{setActiveTab('chat');setDraft(v=>`${v}${v?' ':''}@${m.role} `)}}>@mention</button>
                <button type="button" class="b31-peer-mini-btn" aria-expanded={isSelected()} onClick={()=>setSelectedPeerID(isSelected()?null:peerKey())}>Model ▾</button>
              </div>
            </article>
          }}</For>
        </div>

        {/* PEER DETAIL & B2.2 CAS MODEL SELECTOR POPOVER/DRAWER */}
        <Show when={selectedPeer()}>{(peer)=>{
          const pTasks=()=>memberTasks(team(),peer())
          const pReports=()=>(team().artifacts??[]).filter((a:any)=>a.owner===(peer().id??peer().role)||a.owner===peer().role)
          return <section class="b31-peer-detail" role="dialog" aria-label={`Chi tiết ${memberLabel(peer())}`}>
            <div class="b31-peer-detail-grid">
              <PeerModelSelector
                team={team()}
                member={peer()}
                serverID={valid().serverID}
                onClose={()=>setSelectedPeerID(null)}
                onApplied={()=>void refresh()}
              />
              <div class="b31-peer-info-card">
                <div class="pilot-section-head">
                  <strong>{memberLabel(peer())} · Session & Worktree</strong>
                  <button type="button" class="b31-btn-ghost" onClick={()=>setSelectedPeerID(null)}>Đóng ✕</button>
                </div>
                <p><small>Session ID:</small> <code>{peer().sessionID}</code> · <span class="pilot-badge">{peer().activity??'unknown'}</span></p>
                <p><small>Branch:</small> <code>{peer().branch??'non-git / shared'}</code> · <small>Worktree:</small> <code>{peer().directory}</code></p>
                <div class="b31-peer-detail-actions">
                  <button type="button" class="b31-btn-primary" onClick={()=>act(()=>{if(!valid())throw Error('Snapshot đã đổi.');ctx.tabs.open({server:valid().serverID,id:peer().sessionID},{focus:true})})}>
                    Mở session {peer().role} để chọn model native
                  </button>
                  <button type="button" class="b31-btn-ghost" onClick={()=>{setActiveTab('chat');setRecipient(peer().id??peer().role);setDraft(v=>`${v}${v?' ':''}@${peer().role} `)}}>
                    Nhắn riêng @{peer().role}
                  </button>
                </div>
                <div class="b31-peer-sublist">
                  <strong>Tasks ({pTasks().length}) & Reports ({pReports().length})</strong>
                  <Show when={!pTasks().length}><p class="pilot-muted">Chưa có task giao cho {memberLabel(peer())}.</p></Show>
                  <For each={pTasks()}>{(t:any)=><div class="b31-mini-row">
                    <span class={`b31-task-pill is-${taskState(t).toLowerCase()}`}>{taskState(t)}</span>
                    <span class="pilot-truncate">{t.text}</span>
                    <small>Reviewer: {t.reviewer??'—'}</small>
                  </div>}</For>
                  <For each={pReports()}>{(a:any)=><div class="b31-mini-row">
                    <button type="button" class="b31-link-btn" onClick={()=>void viewReport(a.id)}>📄 {a.name}</button>
                    <Show when={isFixtureArtifact(a,team().tasks)}><span class="b31-fixture-pill">TEST_FIXTURE</span></Show>
                  </div>}</For>
                </div>
              </div>
            </div>
          </section>
        }}</Show>
        </div>
      </aside>

      {/* 3. MAIN NAVIGATION TABS BAR */}
      <nav class="b31-tabs" role="tablist" aria-label="AI Team Views">
        <div class="b31-tabs-left">
          <button type="button" role="tab" aria-selected={activeTab()==='chat'} class="b31-tab" classList={{'is-active':activeTab()==='chat'}} onClick={()=>setActiveTab('chat')}>
            Team Chat <span class="b31-tab-badge">{allMessages().length}</span>
            <Show when={unread()>0}><span class="b31-unread-pill">{unread()} mới</span></Show>
          </button>
          <button type="button" role="tab" aria-selected={activeTab()==='tasks'} class="b31-tab" classList={{'is-active':activeTab()==='tasks'}} onClick={()=>setActiveTab('tasks')}>
            Tasks <span class="b31-tab-badge">{done()}/{team().tasks.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={activeTab()==='plan'} class="b31-tab" classList={{'is-active':activeTab()==='plan'}} onClick={()=>setActiveTab('plan')}>
            Plan <span class="b31-tab-badge">v{latestPlan()?.version??0}</span>
          </button>
          <button type="button" role="tab" aria-selected={activeTab()==='reports'} class="b31-tab" classList={{'is-active':activeTab()==='reports'}} onClick={()=>setActiveTab('reports')}>
            Reports <span class="b31-tab-badge">{team().artifacts?.length??0}</span>
          </button>
          <button type="button" role="tab" aria-selected={activeTab()==='activity'} class="b31-tab" classList={{'is-active':activeTab()==='activity'}} onClick={()=>setActiveTab('activity')}>
            Activity & Security <span class="b31-tab-badge">{(team().approvals?.length??0)+(team().integrations?.length??0)}</span>
          </button>
        </div>
        <div class="b31-tabs-right">
          <input class="b31-search-input" aria-label="Tìm messages" placeholder="Tìm messages, @peer, task…" value={filter()} onInput={e=>setFilter(e.currentTarget.value)}/>
          <Show when={filter()}><button type="button" class="b31-btn-ghost" onClick={()=>setFilter('')}>Xóa lọc</button></Show>
        </div>
      </nav>

      {/* 4. MAIN WORKSPACE COLUMNS (Central Active View + Collapsible Overview Panel) */}
      <div class="pilot-columns" classList={{'with-overview':showOverview()}}>
        <main class="pilot-chat b31-central-pane">
          {/* TAB 1: CENTRAL TEAM CHAT (Zalo / Messenger style) */}
          <Show when={activeTab()==='chat'}>
            <div class="pilot-section-head b31-chat-subhead">
              <div>
                <h3>Team Chat</h3>
                <small class="pilot-muted">Nhóm thảo luận {team().members.length} Peers & Owner · {team()?.collaboration?.enabled?'Gửi prompt qua native queue':'Chỉ lưu tin, chưa gửi session'}</small>
              </div>
              <div class="b31-chat-subactions">
                <button type="button" class="b31-btn-ghost" onClick={()=>act(()=>{setDraft(team().mode==='peer'?`${draft()}\n\nPlan: [mục tiêu]\nPhạm vi: [được phép]\nTiêu chí nghiệm thu: [checks]\nPeers đề xuất, tự nhận task và review chéo. Không cấp quyền execution.`:workflowDraft(draft()));setNotice('Đã thêm mẫu bàn giao vào bản nháp. Chưa gửi hoặc cấp quyền chạy.');})}>
                  + Mẫu giao việc
                </button>
                <Show when={team().mode!=='peer'}>
                  <button type="button" disabled={!valid()} onClick={()=>act(()=>openAdminChat(ctx,valid()))}>Chat với Admin</button>
                </Show>
              </div>
            </div>

            <div ref={messageList} class="pilot-messages b31-chat-stream" aria-label="Shared messages" tabindex="0" onScroll={e=>{const el=e.currentTarget,bottom=el.scrollHeight-el.scrollTop-el.clientHeight<40;setAtBottom(bottom);if(bottom)setUnread(0)}}>
              <Show when={messages().length>limit()}>
                <button type="button" class="b31-load-older" onClick={older}>Xem 100 messages cũ hơn ({messages().length-visible().length})</button>
              </Show>
              <Show when={!messages().length}>
                <div class="b31-empty-state">
                  <p>Chưa có message phù hợp.</p>
                  <small>Gửi tin nhắn bên dưới để trao đổi với cả nhóm hoặc @peer-1..4.</small>
                </div>
              </Show>
              <For each={visible()}>{(m:any,index)=>{
                const isOwner=()=>m.from==='owner'
                const grouped=()=>index()>0&&visible()[index()-1]?.from===m.from
                const peerIdx=()=>{const n=/^peer-(\d+)$/i.exec(m.from??'');return n?((Number(n[1])-1)%4)+1:1}
                const att=()=>m.artifactID?team().artifacts?.find((a:any)=>a.id===m.artifactID):null
                return <article class="pilot-message b31-msg-row" classList={{'pilot-owner':isOwner(),'pilot-grouped':grouped()}}>
                  <Show when={!isOwner()}>
                    <span class={`pilot-avatar b31-msg-avatar peer-color-${peerIdx()}`} aria-hidden="true">{peerShort(m.from)}</span>
                  </Show>
                  <div class="b31-msg-bubble">
                    <div class="pilot-section-head b31-msg-meta">
                      <strong>{peerDisplay(m.from,team().members)}</strong>
                      <Show when={m.to&&m.to!=='team'}><span class="b31-recipient-tag">→ {peerDisplay(m.to,team().members)}</span></Show>
                      <time title={m.at}>{messageTime(m.at)}</time>
                    </div>
                    <div class="b31-msg-body"><SafeReport text={m.text}/></div>
                    <Show when={m.artifactID}>
                      <div class="pilot-attachment b31-attachment-card">
                        <div>
                          <strong>📄 {att()?.name??'Báo cáo Markdown'}</strong>
                          <small>Markdown Report · {m.artifactID}</small>
                          <Show when={isFixtureArtifact(att(),team().tasks)}>
                            <span class="b31-fixture-pill" title="Controlled verification artifact, not live AI execution">TEST_FIXTURE (Controlled Verification)</span>
                          </Show>
                        </div>
                        <button type="button" class="b31-btn-primary" onClick={()=>void viewReport(m.artifactID)}>Xem báo cáo</button>
                      </div>
                    </Show>
                    <div class="b31-msg-footer">
                      <small>{m.action??'message'} {m.taskID?`· Task ${m.taskID.slice(0,14)}`:''} {m.wake?.status?`· Wake: ${m.wake.status}`:''}</small>
                      <Show when={!isOwner()}>
                        <button type="button" class="b31-reply-chip" onClick={()=>{setRecipient(m.from);setDraft(v=>v.includes(`@${m.from}`)?v:`@${m.from} ${v}`)}}>Reply</button>
                      </Show>
                    </div>
                    <Show when={m.wake?.error}><p class="pilot-error">{m.wake.error}</p></Show>
                  </div>
                </article>
              }}</For>
            </div>

            <Show when={unread()}>
              <button type="button" class="b31-unread-floating" onClick={scrollBottom}>{unread()} tin nhắn mới · Xuống cuối ↓</button>
            </Show>

            {/* Inline Report Preview inside Chat when clicked */}
            <Show when={reportLoading()}><p role="status">Đang tải báo cáo…</p></Show>
            <Show when={report()}>
              <section aria-label="Markdown report" class="pilot-report b31-inline-report">
                <div class="pilot-section-head">
                  <div>
                    <h3>{report().name}</h3>
                    <small>{report().owner} · {report().taskID} · {report().at}</small>
                    <Show when={isFixtureArtifact(report(),team().tasks)}>
                      <span class="b31-fixture-pill">TEST_FIXTURE (Controlled Verification — Not Live Execution)</span>
                    </Show>
                  </div>
                  <div class="pilot-composer-actions">
                    <button type="button" onClick={()=>void exportReport(true)}>Copy Markdown</button>
                    <button type="button" onClick={()=>void exportReport()}>Export .md</button>
                    <button type="button" onClick={()=>setReport(undefined)}>Đóng báo cáo</button>
                  </div>
                </div>
                <p class="pilot-muted">Markdown an toàn: headings, lists, quotes, code. HTML/links/images không thực thi. Publish không đánh dấu DONE.</p>
                <SafeReport text={report().content}/>
              </section>
            </Show>

            {/* STICKY CHAT COMPOSER */}
            <div class="pilot-composer b31-chat-composer">
              <div class="b31-composer-toolbar">
                <Show when={team().mode==='peer'}>
                  <div class="b31-recipient-select" role="group" aria-label="Người nhận">
                    <span>Người nhận:</span>
                    <button type="button" aria-pressed={recipient()==='team'} onClick={()=>setRecipient('team')}>Toàn team</button>
                    <For each={team().members}>{(m:any)=><button type="button" aria-pressed={recipient()===(m.id??m.role)} onClick={()=>setRecipient(m.id??m.role)}>{memberLabel(m)}</button>}</For>
                  </div>
                </Show>
                 <span role="status">Đến: {recipient()==='team'?'Toàn team':memberLabel(team().members.find((m:any)=>(m.id??m.role)===recipient()))}</span>
              </div>
              <div class="b31-composer-input-row">
                <textarea
                  aria-label="Yêu cầu Owner"
                  maxLength={10000}
                  rows={2}
                  value={draft()}
                  onInput={e=>setDraft(e.currentTarget.value)}
                  onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!sending()&&draft().trim())void handleSendMessage()}}}
                   placeholder="Nhập tin nhắn cho người nhận đã chọn; Shift+Enter xuống dòng…"
                />
                <div class="pilot-composer-actions b31-send-actions">
                   <button type="button" class="b31-btn-primary b31-send-btn" disabled={!draft().trim()||!valid()||!!rpcError()||sending()} onClick={handleSendMessage}>
                    {sending()?'Đang gửi…':'Gửi yêu cầu Owner'}
                  </button>
                  <Show when={team().mode!=='peer'}>
                    <button type="button" disabled={!draft().trim()||!valid()} onClick={insert}>Chèn vào Admin composer</button>
                  </Show>
                </div>
              </div>
              <div class="pilot-section-head b31-composer-foot">
                <small>Draft · {draft().length}/10000 ký tự · Enter để gửi, Shift+Enter xuống dòng</small>
                 <small class="pilot-muted">Chọn người nhận rồi gửi và xác nhận hộp thoại Owner. {team().collaboration?.enabled?'Phối hợp bật: xem delivery; Sent chưa phải xử lý xong.':'Phối hợp tắt: chỉ lưu tin, không gọi AI.'} Tag trong nội dung có thể gửi thêm Peer.</small>
              </div>
            </div>
          </Show>

          {/* TAB 2: TASKS BOARD (20% Beads — Compact 4-Column Kanban + Dependencies & Progress) */}
          <Show when={team()?.deliveries?.length}>
            <details><summary>Trạng thái giao nhận session ({team().deliveries.length})</summary><For each={team().deliveries}>{(d:any)=><p>{peerDisplay(d.memberID,team().members)} · {d.status} · {d.messageID}{d.error?` · ${d.error}`:''}</p>}</For></details>
          </Show>
          <Show when={(activeTab()==='tasks'||activeTab()==='plan')&&latestPlan()}>
            <details class="b31-plan-editor">
              <summary>Tạo task / giao việc cho Peer</summary>
              <div class="b31-form-stack">
                <label>Nội dung task<textarea rows={3} maxLength={10000} value={task()} onInput={e=>setTask(e.currentTarget.value)}/></label>
                <label>Người làm · chọn hoặc gõ @peer<input list="pilot-task-peers" value={taskPeer()} placeholder="Để Peer tự nhận" onInput={e=>setTaskPeer(e.currentTarget.value)}/></label>
                <datalist id="pilot-task-peers"><For each={team().members}>{(m:any)=><option value={`@${m.id??m.role}`}>{memberLabel(m)}</option>}</For></datalist>
                <label>Người review<select value={taskReviewer()} onChange={e=>setTaskReviewer(e.currentTarget.value)}><option value="">Tự chọn reviewer độc lập</option><For each={team().members}>{(m:any)=><option value={m.id??m.role}>{memberLabel(m)}</option>}</For></select></label>
                <fieldset><legend>Task phụ thuộc</legend><For each={team().tasks.filter((t:any)=>t.planID===latestPlan().planID&&t.planVersion===latestPlan().version)}>{(t:any)=><label><input type="checkbox" checked={taskDeps().includes(t.id)} onChange={e=>setTaskDeps(ids=>e.currentTarget.checked?[...ids,t.id]:ids.filter(id=>id!==t.id))}/>{t.text}</label>}</For></fieldset>
                <label>Phạm vi file · mỗi dòng một path tương đối<textarea rows={2} value={taskFiles()} onInput={e=>setTaskFiles(e.currentTarget.value)}/></label>
                <label>Tiêu chí nghiệm thu · mỗi dòng một mục<textarea rows={2} value={taskCriteria()} onInput={e=>setTaskCriteria(e.currentTarget.value)}/></label>
                <label>Lệnh kiểm tra · mỗi dòng một lệnh<textarea rows={2} value={taskChecks()} onInput={e=>setTaskChecks(e.currentTarget.value)}/></label>
                <small>Task mới ở DRAFT. Phạm vi file trùng bị chặn khi nhận việc. Không chạy lệnh hoặc gọi model.</small>
                <button type="button" disabled={sending()||!!rpcError()||!task().trim()||!taskCriteria().trim()||!taskChecks().trim()} onClick={createTask}>Owner: Tạo và phân công task</button>
              </div>
            </details>
          </Show>
          <Show when={activeTab()==='tasks'}>
            <section class="b31-tab-panel" aria-label="Plan Board">
              <div class="pilot-section-head">
                <div>
                  <h3>Tasks & Dependencies ({done()}/{team().tasks.length} Done)</h3>
                  <small class="pilot-muted">Beads-style compact task graph · Milestone progress {done()}/{team().tasks.length}</small>
                </div>
                <Show when={latestPlan()?.needsOwner}>
                  <span role="alert" class="b31-pill is-blocked">PENDING OWNER APPROVAL · readiness bị chặn</span>
                </Show>
              </div>

              <Show when={!team().tasks.length}>
                <div class="b31-empty-state"><p>Chưa có task.</p></div>
              </Show>

              <Show when={team().tasks.length}>
                <div class="b31-kanban-grid">
                  <For each={[
                    {key:'todo',title:'Todo',items:tasksByColumn().todo},
                    {key:'doing',title:'In Progress / Blocked',items:tasksByColumn().doing},
                    {key:'review',title:'Review',items:tasksByColumn().review},
                    {key:'done',title:'Done',items:tasksByColumn().done}
                  ]}>{(col)=><div class="b31-kanban-col">
                    <div class="b31-kanban-col-head">
                      <strong>{col.title}</strong>
                      <span class="b31-tab-badge">{col.items.length}</span>
                    </div>
                    <div class="b31-kanban-col-body">
                      <Show when={!col.items.length}><small class="pilot-muted">Trống</small></Show>
                      <For each={col.items}>{(t:any)=>{
                        const st=()=>taskState(t)
                        const isFix=()=>String(t.text??'').includes('[TEST_FIXTURE]')
                        return <article class="b31-task-card" classList={{'pilot-blocked':st()==='BLOCKED'}}>
                          <div class="pilot-section-head">
                            <span class={`b31-task-pill is-${st().toLowerCase()}`}>{st()}</span>
                            <Show when={isFix()}><span class="b31-fixture-pill">TEST_FIXTURE</span></Show>
                            <code>{t.id.slice(0,12)}</code>
                          </div>
                          <strong class="b31-task-title">{t.text.replace(/^\[TEST_FIXTURE\]\s*/,'')}</strong>
                          <div class="b31-task-meta">
                            <span>Assignee: <b>{peerDisplay(t.assignedPeer??t.assignee,team().members)}</b>{t.assignmentSource==='owner'?' · Owner giao':''}</span>
                            <span>Reviewer: <b>{(t.reviewer??t.reviewPeer)?peerDisplay(t.reviewer??t.reviewPeer,team().members):'Chưa phân công'}</b></span>
                          </div>
                          <div class="b31-task-deps">
                            <small>Deps: {(t.dependencies??[]).length?(t.dependencies??[]).map((d:string)=>d.slice(0,10)).join(', '):'Không có'}</small>
                          </div>
                          <label class="b31-task-progress">
                            <small>Milestone {taskProgress(t)}/6</small>
                            <progress max={6} value={taskProgress(t)}/>
                          </label>
                          <Show when={t.reason}><p role="status" class="b31-task-reason">{t.reason}</p></Show>
                          <div class="b31-task-actions">
                            <button type="button" class="b31-peer-mini-btn" onClick={()=>{setFilter(t.id);setActiveTab('chat')}}>Lọc messages task</button>
                          </div>
                        </article>
                      }}</For>
                    </div>
                  </div>}</For>
                </div>
              </Show>
            </section>
          </Show>

          {/* TAB 3: PLAN VIEWER & OWNER APPROVAL (10% Noriq) */}
          <Show when={activeTab()==='plan'}>
            <section class="b31-tab-panel" aria-label="Shared Plan">
              <div class="pilot-section-head">
                <div>
                  <h3>PLAN.md — Version {latestPlan()?.version??0}</h3>
                  <Show when={latestPlan()?.ownerDecision==='approve'&&!latestPlan()?.discussionClosed}><button type="button" disabled={sending()||!!rpcError()} onClick={closeDiscussion}>Owner: Chốt thảo luận</button></Show>
                  <small class="pilot-muted">
                    Owner decision: {(latestPlan()?.ownerDecision??'PENDING').toUpperCase()} · Worktree grant: {!rpcError()&&team()?.executionAuthorization?.authorized===true?'AUTHORIZED':'BLOCKED / chưa xác minh'} · Task vẫn cần admission riêng
                  </small>
                </div>
                <Show when={team().plans?.length&&!latestPlan()?.ownerDecision}>
                  <div class="pilot-composer-actions">
                    <button type="button" class="b31-btn-primary" disabled={sending()||!!rpcError()} onClick={()=>reviewSharedPlan('approve')}>Owner: Approve Plan</button>
                    <button type="button" class="b31-btn-danger" disabled={sending()||!!rpcError()} onClick={()=>reviewSharedPlan('reject')}>Owner: Reject Plan</button>
                  </div>
                </Show>
              </div>

              <Show when={latestPlan()} fallback={<div class="b31-empty-state"><p>Chưa có PLAN.md nào được lưu.</p></div>}>
                {(p)=><div class="b31-plan-card">
                  <div class="b31-plan-meta-bar">
                    <span><strong>Plan ID:</strong> <code>{p().planID}</code></span>
                    <span><strong>Version:</strong> v{p().version} (Round {p().round})</span>
                    <span><strong>Scope:</strong> <code>{p().approvedScopeRef}</code></span>
                    <span><strong>Digest:</strong> <code>{String(p().digest??'').slice(0,16)}…</code></span>
                  </div>
                  <div class="b31-plan-body">
                    <SafeReport text={p().content}/>
                  </div>
                  <Show when={p().acceptanceCriteria?.length}>
                    <div class="b31-plan-criteria">
                      <strong>Acceptance Criteria:</strong>
                      <ul><For each={p().acceptanceCriteria}>{(c:string)=><li>{c}</li>}</For></ul>
                    </div>
                  </Show>
                </div>}
              </Show>

              <details class="b31-plan-editor">
                <summary>Cập nhật / Publish PLAN.md mới (không cấp quyền execution)</summary>
                <div class="b31-form-stack">
                  <label>Nguồn<select value={planSource()} onChange={e=>setPlanSource(e.currentTarget.value)}><option value="text">Text</option><option value="markdown">Managed Markdown</option><option value="fileID">Managed fileID</option></select></label>
                  <label>Nội dung / fileID<textarea maxLength={200000} rows={5} value={planBody()} onInput={e=>setPlanBody(e.currentTarget.value)}/></label>
                  <input type="file" accept=".md,text/markdown" aria-label="Đính kèm Markdown plan" onChange={async e=>{const f=e.currentTarget.files?.[0];if(!f)return;if(f.size>200000){setError('PLAN_TOO_LARGE');return}const key=currentKey(),content=await f.text();if(currentKey()===key){setPlanSource('markdown');setPlanBody(content)}}}/>
                  <label>Acceptance criteria · mỗi dòng một mục<textarea rows={3} value={planCriteria()} onInput={e=>setPlanCriteria(e.currentTarget.value)}/></label>
                  <label>Approved scope reference<input value={scopeRef()} onInput={e=>setScopeRef(e.currentTarget.value)} placeholder="todo-git/v1"/></label>
                  <button type="button" class="b31-btn-primary" disabled={sending()||!!rpcError()||!planBody().trim()||!planCriteria().trim()||!scopeRef().trim()} onClick={publishPlan}>Gửi shared plan</button>
                </div>
              </details>

              <Show when={(team().plans?.length??0)>1}>
                <details class="b31-plan-history">
                  <summary>Lịch sử các phiên bản PLAN ({team().plans.length})</summary>
                  <For each={team().plans??[]}>{(p:any)=><div class="b31-mini-row">
                    <strong>v{p.version}</strong>
                    <span class={`b31-pill ${p.ownerDecision==='approve'?'is-approved':p.ownerDecision==='reject'?'is-blocked':'is-pending'}`}>{p.ownerDecision??'pending'}</span>
                    <code>{p.approvedScopeRef}</code>
                    <small>{p.digest?.slice(0,16)}</small>
                  </div>}</For>
                </details>
              </Show>
            </section>
          </Show>

          {/* TAB 4: REPORTS VIEWER (Safe Markdown + Explicit Fixture Provenance) */}
          <Show when={activeTab()==='reports'}>
            <section class="b31-tab-panel" aria-label="Reports Viewer">
              <div class="pilot-section-head">
                <div>
                  <h3>Markdown Reports ({team().artifacts?.length??0})</h3>
                  <small class="pilot-muted">Báo cáo lưu trong managed storage · Không thực thi HTML/script · Kiểm tra rõ nguồn gốc</small>
                </div>
              </div>

              <Show when={!(team().artifacts?.length)}>
                <div class="b31-empty-state"><p>Chưa có báo cáo Markdown nào.</p></div>
              </Show>

              <div class="b31-reports-split">
                <div class="b31-reports-list">
                  <For each={team().artifacts??[]}>{(a:any)=><article class="b31-report-item" classList={{'is-active':report()?.id===a.id}}>
                    <div class="pilot-section-head">
                      <strong>{a.name}</strong>
                      <Show when={isFixtureArtifact(a,team().tasks)} fallback={<span class="b31-pill is-approved">MANAGED REPORT</span>}>
                        <span class="b31-fixture-pill" title="Controlled verification fixture — not generated by live model execution">TEST_FIXTURE</span>
                      </Show>
                    </div>
                    <small>Sender: <b>{peerDisplay(a.owner,team().members)}</b> · Task: <code>{a.taskID?.slice(0,14)??'—'}</code></small>
                    <div class="b31-task-actions">
                      <button type="button" class="b31-btn-primary" onClick={()=>void viewReport(a.id)}>Xem báo cáo</button>
                    </div>
                  </article>}</For>
                </div>

                <div class="b31-report-detail">
                  <Show when={reportLoading()}><p role="status">Đang tải báo cáo…</p></Show>
                  <Show when={report()} fallback={<div class="b31-empty-state"><p>Chọn một báo cáo bên trái để đọc nội dung chi tiết.</p></div>}>
                    <section aria-label="Markdown report" class="pilot-report">
                      <div class="pilot-section-head">
                        <div>
                          <h3>{report().name}</h3>
                          <small>{report().owner} · {report().taskID} · {report().at}</small>
                          <Show when={isFixtureArtifact(report(),team().tasks)}>
                            <p role="status" class="b31-fixture-banner">
                              ⚠ TEST_FIXTURE (Controlled Verification): Báo cáo này là dữ liệu kiểm thử có kiểm soát, không phải kết quả thực thi AI live.
                            </p>
                          </Show>
                        </div>
                        <div class="pilot-composer-actions">
                          <button type="button" onClick={()=>void exportReport(true)}>Copy Markdown</button>
                          <button type="button" onClick={()=>void exportReport()}>Export .md</button>
                          <button type="button" onClick={()=>setReport(undefined)}>Đóng</button>
                        </div>
                      </div>
                      <SafeReport text={report().content}/>
                    </section>
                  </Show>
                </div>
              </div>
            </section>
          </Show>

          {/* TAB 5: ACTIVITY, APPROVAL RECEIPTS & SECURITY */}
          <Show when={activeTab()==='activity'}>
            <section class="b31-tab-panel" aria-label="Activity and Security">
              <h3>Security, Approvals & Integration Receipts</h3>
              <div class="b31-security-card">
                <strong>Security Status · Live execution BLOCKED</strong>
                <p>Effective permissions: <code>{team().security?.effectivePermissions??'NOT_PROVEN'}</code> · Quota: <code>{team().security?.quota??'NOT_PROVEN'}</code> · Hard spending cap: <code>{team().security?.hardSpendingCap??'NOT_PROVEN'}</code></p>
                <p>Blockers: <code>{(team().security?.blockers??['SERVER_SECURITY_READBACK_NOT_PROVEN']).join(' · ')}</code></p>
              </div>

              <div class="b31-activity-columns">
                <div class="b31-activity-box">
                  <strong>Owner Approvals ({team().approvals?.length??0}) & Model Receipts ({team().modelReceipts?.length??0})</strong>
                  <For each={team().approvals??[]}>{(ap:any)=><div class="b31-mini-row">
                    <span class="b31-pill is-approved">{ap.decision??ap.operation??'approval'}</span>
                    <code>v{ap.version??'—'}</code>
                    <small>{ap.at}</small>
                  </div>}</For>
                  <For each={(team().modelReceipts??[]).slice(-6)}>{(mr:any)=><div class="b31-mini-row">
                    <span class="b31-pill">{mr.memberID}</span>
                    <code>{mr.after?.providerID}/{mr.after?.id} ({mr.after?.variant})</code>
                    <small>{mr.composerVerified?'SYNCHRONIZED':'APPLIED'}</small>
                  </div>}</For>
                </div>

                <div class="b31-activity-box">
                  <strong>Integrations ({team().integrations?.length??0}) & Executions ({team().executions?.length??0})</strong>
                  <For each={team().integrations??[]}>{(ig:any)=><div class="b31-mini-row">
                    <span class="b31-pill is-approved">{ig.status}</span>
                    <code>{ig.taskID?.slice(0,12)}</code>
                    <small>{ig.mergedCommit?.slice(0,10)??'—'}</small>
                  </div>}</For>
                  <For each={team().executions??[]}>{(record:any)=><div class="b31-mini-row">
                    <code>{record.id}</code>
                    <button type="button" disabled={sending()||!!rpcError()||!!record.cancellation} onClick={()=>cancelExecution(record)}>Owner: request cancellation · {record.id}</button>
                  </div>}</For>
                </div>
              </div>

              <div class="b31-activity-box">
                <strong>Mở file trong workspace</strong>
                <div class="pilot-composer-actions">
                  <input value={file()} placeholder="src/example.ts" onInput={e=>setFile(e.currentTarget.value)}/>
                  <button type="button" onClick={openFile}>Mở bằng native viewer</button>
                </div>
              </div>
            </section>
          </Show>
        </main>

        {/* COLLAPSIBLE RIGHT OVERVIEW PANEL */}
        <Show when={showOverview()}>
          <aside class="pilot-details b31-overview-panel" aria-label="Project Overview" tabindex="0">
            <div class="pilot-section-head">
              <h3>Project Overview</h3>
              <button type="button" class="b31-btn-ghost" title="Ẩn Overview panel" onClick={()=>setShowOverview(false)}>✕</button>
            </div>

            <div class="b31-overview-card">
              <div class="pilot-section-head">
                <span>Overall Progress</span>
                <strong>{team().tasks.length?Math.round((done()/team().tasks.length)*100):0}%</strong>
              </div>
              <progress max={team().tasks.length||1} value={done()}/>
              <small class="pilot-muted">Current Phase: Plan v{latestPlan()?.version??0} ({latestPlan()?.ownerDecision??'pending'})</small>
            </div>

            <div class="b31-overview-card">
              <strong>Tasks Breakdown ({done()}/{team().tasks.length})</strong>
              <div class="b31-stat-list">
                <div class="b31-stat-row"><span>Todo</span><b>{tasksByColumn().todo.length}</b></div>
                <div class="b31-stat-row"><span>In Progress / Blocked</span><b>{tasksByColumn().doing.length}</b></div>
                <div class="b31-stat-row"><span>Review</span><b>{tasksByColumn().review.length}</b></div>
                <div class="b31-stat-row"><span>Done</span><b>{tasksByColumn().done.length}</b></div>
              </div>
            </div>

            <div class="b31-overview-card">
              <strong>Next Actions & Review Queue</strong>
              <Show when={!tasksByColumn().doing.length&&!tasksByColumn().review.length&&!tasksByColumn().todo.length}>
                <p class="pilot-muted">Tất cả tasks hiện tại đã hoàn tất ({done()}/{team().tasks.length}).</p>
              </Show>
              <For each={[...tasksByColumn().review,...tasksByColumn().doing,...tasksByColumn().todo].slice(0,4)}>{(t:any)=><div class="b31-next-item">
                <span class={`b31-task-pill is-${taskState(t).toLowerCase()}`}>{taskState(t)}</span>
                <small class="pilot-truncate">{t.text.replace(/^\[TEST_FIXTURE\]\s*/,'')}</small>
              </div>}</For>
              <Show when={latestPlan()?.needsOwner}>
                <button type="button" class="b31-btn-primary" onClick={()=>setActiveTab('plan')}>Duyệt PLAN v{latestPlan()?.version}</button>
              </Show>
            </div>

            <div class="b31-overview-card">
              <strong>Worktrees & Security</strong>
               <small class="pilot-muted">Containment: {team().isolation??'worktree'} · Execution: {team()?.executionAuthorization?.authorized===true?'WORKTREE AUTHORIZED':'BLOCKED'}</small>
              <For each={team().members}>{(m:any)=><div class="b31-mini-row">
                <span>{memberLabel(m)}</span>
                <code class="pilot-truncate">{m.branch??'non-git'}</code>
              </div>}</For>
            </div>

            {/* Legacy support controls when mode !== 'peer' */}
            <Show when={team().mode!=='peer'}>
              <details>
                <summary>Tạo / assign task qua Admin</summary>
                <label>Nội dung<input maxLength={9000} value={task()} onInput={e=>setTask(e.currentTarget.value)}/></label>
                <label>Worker<select value={assignee()} onChange={e=>setAssignee(e.currentTarget.value)}><For each={team().members.filter((m:any)=>m.role.startsWith('worker-'))}>{(m:any)=><option value={m.role}>{m.role}</option>}</For></select></label>
                <button type="button" onClick={prepareTask}>Soạn yêu cầu</button>
              </details>
            </Show>
          </aside>
        </Show>
      </div>
    </Show>
  </section>
}
