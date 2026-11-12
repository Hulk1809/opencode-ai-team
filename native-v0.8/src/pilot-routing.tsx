import {usePlugin} from '@opencode/plugin/gui'
import {Schema} from 'effect'
import {createEffect,createMemo,createSignal,For,Show,on} from 'solid-js'
import {DEFAULT_MODELS,routeModel,routingKey,selectCurrentComposer,sameModel} from './model-routing.mjs'
import {checkedTeam,pilotError} from './pilot-ui.mjs'
import {routingOptions} from './routing-filters.mjs'
import {routingAdmissionBlocked} from './peer-presentation.mjs'
import {PilotRPC} from './pilot-rpc'
import {PilotOwner} from './pilot-owner-ipc'
import {OWNER_MODEL_CONTEXT_BLOCKED} from './pilot-models.mjs'
import {memberLabel} from './peer-team.mjs'

const Preferences=Schema.Struct({mode:Schema.Literals(['auto','smart','manual']),manual:Schema.String,lastDecision:Schema.String})
const modelText=(model:any)=>model?`${model.providerID}/${model.id??model.modelID} · ${model.variant??'mặc định'}`:'Chưa ghim model native'

export function PeerModelSelector(props:{team:any,member:any,serverID:string,onClose?:()=>void,onApplied?:()=>void}){
  const ctx=usePlugin()
  const catalog=()=>props.team?.modelCatalog??[]
  const currentSelection=()=>props.member?.model?.selection??props.member?.modelDefault??DEFAULT_MODELS.worker
  const providers=createMemo(()=>[...new Set<string>(catalog().map((m:any)=>m.providerID))])
  const [providerID,setProviderID]=createSignal(currentSelection()?.providerID??providers()[0]??'')
  const providerModels=createMemo(()=>catalog().filter((m:any)=>!providerID()||m.providerID===providerID()))
  const [modelID,setModelID]=createSignal(currentSelection()?.id??currentSelection()?.modelID??providerModels()[0]?.id??'')
  const activeModel=createMemo(()=>catalog().find((m:any)=>m.providerID===providerID()&&m.id===modelID())??providerModels()[0])
  const variants=createMemo(()=>activeModel()?.variants?.length?activeModel().variants:['default'])
  const [variant,setVariant]=createSignal(currentSelection()?.variant??variants()[0]??'default')
  const [applying,setApplying]=createSignal(false),[error,setError]=createSignal(''),[notice,setNotice]=createSignal('')

  createEffect(on(()=>JSON.stringify([props.member?.sessionID,currentSelection()]),()=>{
    const sel=currentSelection()
    if(sel?.providerID)setProviderID(sel.providerID)
    if(sel?.id||sel?.modelID)setModelID(sel.id??sel.modelID)
    if(sel?.variant)setVariant(sel.variant)
  }))

  function handleProviderChange(nextProvider:string){
    setProviderID(nextProvider)
    const first=catalog().find((m:any)=>m.providerID===nextProvider)
    if(first){
      setModelID(first.id)
      setVariant(first.variants?.[0]??'default')
    }
  }

  function handleModelChange(nextModelID:string){
    setModelID(nextModelID)
    const found=catalog().find((m:any)=>m.providerID===providerID()&&m.id===nextModelID)
    if(found){
      const nextVar=found.variants?.includes(variant())?variant():(found.variants?.[0]??'default')
      setVariant(nextVar)
    }
  }

  const proposed=createMemo(()=>({
    providerID:activeModel()?.providerID??providerID(),
    id:activeModel()?.id??modelID(),
    variant:variant()||'default'
  }))

  const statusBadge=createMemo(()=>{
    const m=props.member
    const nativeSel=m?.model?.selection
    if(!props.team?.modelSwitch?.allowed)return {label:'BLOCKED',tone:'blocked',detail:OWNER_MODEL_CONTEXT_BLOCKED}
    if(m?.activity==='running')return {label:'QUEUE',tone:'pending',detail:'Model đang trả lời. Lựa chọn chờ không thay lượt đang chạy.'}
    if(!nativeSel)return {label:'PENDING',tone:'pending',detail:'Chưa có session model readback'}
    if(!sameModel(proposed(),nativeSel))return {label:'PENDING',tone:'pending',detail:'Bản chọn mới chưa Apply xuống host CAS'}
    if(m?.model?.composerVerified||ctx.sessions.current()?.id===m?.sessionID&&sameModel(nativeSel,ctx.screen.current()?.composer?.model?.()&&{providerID:ctx.screen.current()!.composer.model()!.providerID,id:ctx.screen.current()!.composer.model()!.modelID,variant:ctx.screen.current()!.composer.model()!.variant??'default'})){
      return {label:'SYNCHRONIZED',tone:'synced',detail:'Session API & Native Composer đã đồng bộ'}
    }
    return {label:'APPLIED',tone:'applied',detail:'Đã lưu qua Host CAS (mở tab Peer để đồng bộ Composer)'}
  })

  async function applyModel(){
    setError('');setNotice('');setApplying(true)
    const team=props.team,member=props.member,serverID=props.serverID,selection=proposed()
    try{
      if(ctx.sessions.current()?.server.id!==serverID)throw Error('ROUTING_SERVER_MISMATCH')
      const current=ctx.sessions.current()
      if(!current)throw Error('ROUTING_OPEN_MEMBER_SESSION_FIRST')
      const fresh=checkedTeam(await current.server.client.rpc(PilotRPC).snapshot({directory:team.canonicalRoot??current.directory},{location:{directory:team.canonicalRoot??current.directory}}))
      if(fresh.projectID!==team.projectID||fresh.teamID!==team.teamID||ctx.sessions.current()!==current)throw Error('ROUTING_NATIVE_BINDING_MISMATCH')
      const native=fresh.members.find((m:any)=>m.sessionID===member.sessionID)
       if(!native)throw Error('MODEL_BINDING_MISMATCH')
      const requestID=crypto.randomUUID()
      await ctx.main(PilotOwner).selectModel({
        sessionID:current.id,
        directory:team.canonicalRoot??current.directory,
        teamID:fresh.teamID,
        memberID:member.id??member.role,
        targetSessionID:member.sessionID,
        generation:fresh.generation,
        requestID,
        expectedModelJSON:JSON.stringify(native.model?.selection??null),
        modelJSON:JSON.stringify(selection)
      })
      const readback=checkedTeam(await current.server.client.rpc(PilotRPC).snapshot({directory:team.canonicalRoot},{location:{directory:team.canonicalRoot}}))
       const updated=readback.members.find((m:any)=>m.sessionID===member.sessionID)
       if(updated?.queuedModel?.requestID===requestID&&sameModel(updated.queuedModel.desired,selection)){
         setNotice('Đã lưu model chờ; model hiện tại chưa đổi. Khi Peer dừng an toàn, chọn model chờ rồi bấm Apply. Không tự gửi prompt.')
         props.onApplied?.()
         return
       }
       const observed=updated?.model?.selection
      if(!sameModel(observed,{...selection,variant:selection.variant??'default'}))throw Error('MODEL_READBACK_MISMATCH')
      if(ctx.sessions.current()?.id===member.sessionID){
        await selectCurrentComposer(ctx,readback,member,observed,catalog())
        await ctx.main(PilotOwner).acknowledgeComposer({
          sessionID:current.id,
          directory:team.canonicalRoot??current.directory,
          teamID:fresh.teamID,
          targetSessionID:member.sessionID,
          generation:fresh.generation,
          requestID:crypto.randomUUID(),
          modelJSON:JSON.stringify(observed)
        })
        setNotice('APPLIED · session API và composer hiện tại cùng model/variant. Không gửi prompt; execution vẫn BLOCKED.')
      }else{
        setNotice('PENDING composer verification · session API đã lưu. Mở đúng Peer và xác minh composer trước execution; không báo đồng bộ thành công.')
      }
      props.onApplied?.()
    }catch(e){setError(pilotError(e))}finally{setApplying(false)}
  }

  return <div class="b31-model-selector" aria-label={`Model Selector ${memberLabel(props.member)}`}>
    <div class="b31-model-selector-head">
      <div>
        <strong>Model Selector — {memberLabel(props.member)}</strong>
         <small class="pilot-muted">Current: {modelText(props.member?.model?.selection??props.member?.modelDefault)}</small>
         <Show when={props.member?.queuedModel}><small role="status">Model chờ: {modelText(props.member.queuedModel.desired)} · chưa áp dụng</small><button type="button" onClick={()=>{const m=props.member.queuedModel.desired;setProviderID(m.providerID);setModelID(m.id);setVariant(m.variant??'default')}}>Chọn model chờ</button></Show>
      </div>
      <span class={`b31-status-pill is-${statusBadge().tone}`} role="status">{statusBadge().label}</span>
    </div>
    <div class="b31-model-grid">
      <label>
        <span>Select Provider</span>
        <select aria-label={`Provider ${props.member.role}`} value={providerID()} onChange={e=>handleProviderChange(e.currentTarget.value)}>
          <Show when={!providers().length}><option value={providerID()}>{providerID()||'taile'}</option></Show>
          <For each={providers()}>{p=><option value={p}>{p}</option>}</For>
        </select>
      </label>
      <label>
        <span>Select Model</span>
        <select aria-label={`Select Model ${props.member.role}`} value={activeModel()?.id??modelID()} onChange={e=>handleModelChange(e.currentTarget.value)}>
          <Show when={!providerModels().length}><option value={modelID()}>{modelID()||'Chưa có catalog'}</option></Show>
          <For each={providerModels()}>{(m:any)=><option value={m.id}>{m.name?`${m.name} (${m.id})`:m.id}</option>}</For>
        </select>
      </label>
      <label>
        <span>Variant</span>
        <select aria-label={`Select Variant ${props.member.role}`} value={variant()} onChange={e=>setVariant(e.currentTarget.value)}>
          <For each={variants()}>{(v:string)=><option value={v}>{v}</option>}</For>
        </select>
      </label>
    </div>
    <p class="b31-model-meta" role="status">{statusBadge().detail}</p>
    <Show when={error()}><p role="alert" class="pilot-error">{error()}</p></Show>
    <Show when={notice()}><p role="status" class="b31-model-notice">{notice()}</p></Show>
    <div class="b31-model-actions">
      <Show when={props.onClose}><button type="button" class="b31-btn-ghost" onClick={props.onClose}>Cancel</button></Show>
      <Show when={props.team?.modelSwitch?.allowed} fallback={<button type="button" disabled title={OWNER_MODEL_CONTEXT_BLOCKED}>Apply · BLOCKED</button>}>
         <button type="button" class="b31-btn-primary" aria-label={`Apply model ${props.member.role}`} disabled={applying()} onClick={()=>void applyModel()}>
           {applying()?'Đang lưu…':props.member?.activity==='running'?'Lưu model chờ':'Đổi model ngay'}
        </button>
      </Show>
    </div>
  </div>
}

export function PilotRouting(props:{team:any,serverID:string,onApplied?:()=>void}){
  const ctx=usePlugin()
  const [type,setType]=createSignal('read'),[role,setRole]=createSignal('worker-1')
  const [provider,setProvider]=createSignal(''),[search,setSearch]=createSignal('')
  const [error,setError]=createSignal(''),[notice,setNotice]=createSignal(''),[applying,setApplying]=createSignal(false)
  const stores=createMemo(()=>{
    const t=props.team
    if(!t.teamID)return null
    return t.members.map((m:any)=>({member:m,store:ctx.storage.store(`routing.draft.${JSON.stringify([props.serverID,routingKey({projectID:t.projectID,teamID:t.teamID,sessionID:m.sessionID})])}`,{schema:Preferences,initial:{mode:'smart',manual:'',lastDecision:''}})}))
  })
  const ready=()=>stores()?.every((x:any)=>x.store.value!==undefined)
  const mode=()=>stores()?.[0]?.store.value?.mode??'smart'
  const catalog=()=>props.team.modelCatalog??[]
  const providers=createMemo(()=>[...new Set<string>(catalog().map((m:any)=>m.providerID))])
  const options=createMemo(()=>routingOptions(catalog(),provider(),search()))
  const policy=()=>{
    const manual=Object.fromEntries((stores()??[]).filter((x:any)=>x.store.value?.manual).map((x:any)=>[x.member.sessionID,JSON.parse(x.store.value.manual)]))
    return {projectID:props.team.projectID,teamID:props.team.teamID,mode:mode(),allowed:[DEFAULT_MODELS.admin,DEFAULT_MODELS.worker,...Object.values(manual)],manual,allowWorkerUpgrade:false}
  }
  const preview=createMemo(()=>{
    if(!ready())return null
    const member=props.team.members.find((m:any)=>m.role===role())??props.team.members[0]
    try{return routeModel({team:props.team,member,task:{id:`preview:${type()}`,type:type(),projectID:props.team.projectID,teamID:props.team.teamID,sessionID:member?.sessionID},catalog:catalog(),policy:policy()})}catch(e){return {error:pilotError(e)}}
  })
  const decision=()=>{const value=preview();return value&&'binding' in value?value:null}
  const previewError=()=>{const value=preview();return value&&'error' in value?value.error:''}
  function changeMode(value:string){
    if(!ready())return
    for(const x of stores()??[])x.store.update((d:any)=>{d.mode=value})
    setNotice('Đã lưu chế độ bản nháp; chưa cấp quyền routing hoặc đổi native model.')
  }
  async function apply(member:any,selection:any){
    setError('');setNotice('');setApplying(true)
    const team=props.team,serverID=props.serverID
    try{
      if(ctx.sessions.current()?.server.id!==serverID)throw Error('ROUTING_SERVER_MISMATCH')
      const current=ctx.sessions.current()
      if(!current)throw Error('ROUTING_OPEN_MEMBER_SESSION_FIRST')
      const fresh=checkedTeam(await current.server.client.rpc(PilotRPC).snapshot({directory:team.canonicalRoot??current.directory},{location:{directory:team.canonicalRoot??current.directory}}))
      if(fresh.projectID!==team.projectID||fresh.teamID!==team.teamID||ctx.sessions.current()!==current)throw Error('ROUTING_NATIVE_BINDING_MISMATCH')
       const native=fresh.members.find((m:any)=>m.sessionID===member.sessionID)
       if(!native)throw Error('MODEL_BINDING_MISMATCH')
       const requestID=crypto.randomUUID()
       await ctx.main(PilotOwner).selectModel({
         sessionID:current.id,
         directory:team.canonicalRoot??current.directory,
         teamID:fresh.teamID,
         memberID:member.id??member.role,
         targetSessionID:member.sessionID,
         generation:fresh.generation,
         requestID,
         expectedModelJSON:JSON.stringify(native.model?.selection??null),
         modelJSON:JSON.stringify(selection)
       })
       const readback=checkedTeam(await current.server.client.rpc(PilotRPC).snapshot({directory:team.canonicalRoot},{location:{directory:team.canonicalRoot}}))
       const updated=readback.members.find((m:any)=>m.sessionID===member.sessionID)
       if(updated?.queuedModel?.requestID===requestID&&sameModel(updated.queuedModel.desired,selection)){
         setNotice('Đã lưu model chờ; model hiện tại chưa đổi. Khi Peer dừng an toàn, chọn model chờ rồi bấm Apply. Không tự gửi prompt.')
         props.onApplied?.()
         return
       }
       const observed=updated?.model?.selection
       if(!sameModel(observed,{...selection,variant:selection.variant??'default'}))throw Error('MODEL_READBACK_MISMATCH')
       if(ctx.sessions.current()?.id===member.sessionID){
         await selectCurrentComposer(ctx,readback,member,observed,catalog())
         await ctx.main(PilotOwner).acknowledgeComposer({
           sessionID:current.id,
           directory:team.canonicalRoot??current.directory,
           teamID:fresh.teamID,
           targetSessionID:member.sessionID,
           generation:fresh.generation,
           requestID:crypto.randomUUID(),
           modelJSON:JSON.stringify(observed)
         })
         setNotice('APPLIED · session API và composer hiện tại cùng model/variant. Không gửi prompt; execution vẫn BLOCKED.')
       }else setNotice('PENDING composer verification · session API đã lưu. Mở đúng Peer và xác minh composer trước execution; không báo đồng bộ thành công.')
      if(props.team.projectID!==team.projectID||props.team.teamID!==team.teamID||props.serverID!==serverID)return
    }catch(e){setError(pilotError(e))}finally{setApplying(false)}
  }
  function saveDecision(){
    const d=preview()
    if(!d||'error' in d)return
    const row=stores()?.find((x:any)=>x.member.sessionID===d.binding.sessionID)
    row?.store.update((v:any)=>{v.lastDecision=JSON.stringify(d)})
    setNotice('Đã lưu quyết định preview; chưa bind task/prompt thật, không dispatch.')
  }
  return <section aria-label="Model routing"><h3>Model routing</h3>
    <p role="status">{props.team.modelSwitch?.allowed?props.team.modelSwitch.reason:OWNER_MODEL_CONTEXT_BLOCKED}</p>
    <p>Smart Routing ưu tiên · bản nháp cục bộ Desktop. Allowlist preview chỉ gồm defaults và đề xuất thủ công, không phải allowlist Owner được server xác thực. Không có hard spending cap; không cho phép chạy trả phí tự động.</p>
    <Show when={stores()} fallback={<p role="alert">Team cũ thiếu teamID; routing khóa. Không tự gán lại identity.</p>}>
      <Show when={ready()} fallback={<p role="status">Đang tải routing preferences…</p>}>
        <label>Model mode<select aria-label="Model mode" value={mode()} onChange={e=>changeMode(e.currentTarget.value)}><option value="smart">Smart Routing (ưu tiên)</option><option value="auto">Auto Default</option><option value="manual">Manual</option></select></label>
        <p>Chưa áp dụng tự động. Peers dùng default riêng; label không cấp authority. Composer selection không chứng minh model đã thực thi.</p>
        <label>Provider<select value={provider()} onChange={e=>setProvider(e.currentTarget.value)}><option value="">Tất cả provider</option><Show when={provider()&&!providers().includes(provider())}><option value={provider()}>{provider()} · không khả dụng</option></Show><For each={providers()}>{p=><option value={p}>{p}</option>}</For></select></label>
        <label>Tìm model<input type="search" value={search()} onInput={e=>setSearch(e.currentTarget.value)} placeholder="Tên hoặc ID model" /></label>
        <p role="status">{options().length} lựa chọn model/variant khớp bộ lọc. Lọc không đổi lựa chọn đã lưu.</p>
        <div class="pilot-routing-members"><For each={stores()??[]}>{(row:any)=>{
          const selection=()=>row.store.value?.manual?JSON.parse(row.store.value.manual):DEFAULT_MODELS[row.member.role==='admin'?'admin':'worker']
          const retained=()=>row.store.value?.manual&&!options().some((m:any)=>sameModel(m,selection()))
          return <fieldset><legend>{row.member.role} · lựa chọn thủ công</legend>
            <select aria-label={`Đề xuất model ${row.member.role}`} value={row.store.value?.manual??''} onChange={e=>{const value=e.currentTarget.value;row.store.update((d:any)=>{d.manual=value});setNotice('Đã lưu đề xuất; native model chưa đổi.')}}>
              <option value="">Dùng mặc định tạm theo role (có thể đổi)</option><Show when={retained()}><option value={row.store.value.manual}>{modelText(selection())} · đang chọn, ngoài bộ lọc hoặc không khả dụng</option></Show><For each={options()}>{(m:any)=><option value={JSON.stringify(m)}>{m.providerID}/{m.id} · {m.variant??'mặc định'}</option>}</For>
            </select>
            <button aria-label={`Dùng lựa chọn ${row.member.role} cho tất cả, chỉ bản nháp`} onClick={()=>{const value=JSON.stringify(selection());for(const x of stores()??[])x.store.update((d:any)=>{d.manual=value});setNotice('Đã sao chép model và variant vào bản nháp tất cả member. Không áp dụng native; API chỉ chọn composer đang mở.')}}>Apply to All — chỉ bản nháp, không áp dụng native</button>
            <p>Configured: {selection().providerID}/{selection().id} · {selection().variant??'mặc định'}</p>
            <p>Proposed: {decision()?.binding.sessionID===row.member.sessionID?modelText(decision()?.selected):'Chưa có task cho member này'}</p>
            <p>Native session: {modelText(row.member.model?.selection)} · {!row.member.model?.selection?'Chưa áp dụng / chưa có session readback':!row.member.model?.available?'Unavailable':sameModel(selection(),row.member.model.selection)?'Applied (session readback)': 'Mismatch / Not applied'}</p>
            <Show when={decision()?.binding.sessionID===row.member.sessionID&&decision()?.approvalRequired}><p role="status">Pending Owner approval</p></Show>
            <p>Chi phí native session: {row.member.usage?.cost??'Chưa có dữ liệu'} USD · Tokens input: {row.member.usage?.input??'—'} / output: {row.member.usage?.output??'—'}. Giá thiếu không chứng minh miễn phí.</p>
            <Show when={props.team.modelSwitch?.allowed} fallback={<button aria-label={`Áp model native ${row.member.role}`} disabled title={OWNER_MODEL_CONTEXT_BLOCKED}>Đổi model trực tiếp · BLOCKED host Owner context</button>}>
              <button aria-label={`Áp model native ${row.member.role}`} disabled={applying()||row.member.activity==='running'||routingAdmissionBlocked(props.team,row.member)} onClick={()=>{void apply(row.member,selection())}}>Áp model native · Host Owner capability</button>
            </Show>
            <Show when={ctx.sessions.current()?.id===row.member.sessionID}><p>Composer readback: {modelText(ctx.screen.current()?.composer.model())}</p></Show>
            <Show when={row.store.value?.lastDecision}><details><summary>Quyết định preview đã lưu</summary><pre>{row.store.value.lastDecision}</pre></details></Show>
          </fieldset>
        }}</For></div>
        <label>Member preview<select value={props.team.members.some((m:any)=>m.role===role())?role():props.team.members[0]?.role} onChange={e=>setRole(e.currentTarget.value)}><For each={props.team.members}>{(m:any)=><option value={m.role}>{m.role}</option>}</For></select></label>
        <label>Task metadata<select aria-label="Task metadata" value={type()} onChange={e=>setType(e.currentTarget.value)}><For each={['read','small-edit','format','documentation','basic-test-fix','architecture','multi-module-debug','security-review','complex-review','planning','integration','unknown']}>{v=><option value={v}>{v}</option>}</For></select></label>
        <Show when={decision()}><p>Độ phức tạp: {decision()?.complexity} · Lý do: {decision()?.reason}</p></Show>
        <Show when={previewError()}><p role="alert">{previewError()}</p></Show>
        <details><summary>Chi tiết routing preview</summary><pre aria-label="Routing preview">{JSON.stringify(preview(),null,2)}</pre></details><button onClick={saveDecision}>Lưu preview, không tạo task</button>
      </Show>
    </Show>
    <Show when={error()}><p role="alert">{error()}</p></Show><Show when={notice()}><p role="status">{notice()}</p></Show>
  </section>
}
