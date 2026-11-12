import {dialog} from 'electron'
import {realpathSync} from 'node:fs'
import {PilotOwner} from './pilot-owner-ipc'
import {PilotRPC} from './pilot-rpc'
import type {MainContext} from '@opencode/plugin/gui/main'
import {peerPlan,planHash,PEER_GENERATION} from './peer-team.mjs'
import {randomUUID} from 'node:crypto'
import {OWNER_MODEL_CONTEXT_BLOCKED} from './pilot-models.mjs'

// Main owns the native confirmation; a renderer-supplied identity alone never authorizes provisioning.
export function registerPilotOwner(ctx:MainContext,issueGrant:(binding:any,options:any)=>string){
  const pending=new Set<number>()
  const perform=async(input:{sessionID:string,directory:string,recipient?:string,text?:string,requestID?:string,planJSON?:string},caller:{window:number,signal:AbortSignal})=>{
    const window=ctx.windows.get(caller.window)
    if(!window||window.isDestroyed()||caller.signal.aborted||pending.has(caller.window))throw Error('PILOT_OWNER_WINDOW_REQUIRED')
    pending.add(caller.window)
    try{
      const client=ctx.client
      if(input.planJSON!==undefined&&Buffer.byteLength(input.planJSON)>250000)throw Error('PLAN_TOO_LARGE')
       const publication=input.planJSON===undefined?undefined:JSON.parse(input.planJSON)
       if(publication?.operation==='selectModel')throw Error(OWNER_MODEL_CONTEXT_BLOCKED)
      const cancellation=publication?.operation==='cancelExecution'?publication:undefined
      if(input.planJSON!==undefined&&(!publication||typeof publication!=='object'||Array.isArray(publication)||typeof publication.requestID!=='string'))throw Error('PLAN_INPUT_INVALID')
      const plan=peerPlan(),requestID=publication?.requestID??input.requestID??randomUUID(),sending=input.text!==undefined
      const inspect=async()=>{
        if(caller.signal.aborted||window.isDestroyed()||ctx.windows.get(caller.window)!==window||ctx.client!==client)throw Error('PILOT_OWNER_WINDOW_REQUIRED')
        const endpoint=ctx.serverEndpoints.get('sidecar')
        if(endpoint?.sameMachine!==true)throw Error('PILOT_OWNER_LOCAL_SERVER_REQUIRED')
        const session=await client.session.get({sessionID:input.sessionID})
        const projects=await client.project.list()
         let project=projects.find((p:any)=>p.id===session.projectID)
         if(session.id!==input.sessionID||!project||project.canonical!==input.directory||session.location.directory!==input.directory||realpathSync(input.directory)!==input.directory)throw Error('PILOT_OWNER_PROJECT_MISMATCH')
         if(!publication&&!sending){
           const snapshot=await client.rpc(PilotRPC).snapshot({directory:input.directory},{location:{directory:input.directory},signal:caller.signal}) as any
           if(snapshot.migrationRequired){
             project=projects.find((p:any)=>p.id===snapshot.migrationProjectID&&p.canonical===input.directory&&p.vcs==='git')
             if(!project)throw Error('PILOT_OWNER_PROJECT_MISMATCH')
           }
         }
        const current=ctx.serverEndpoints.get('sidecar')
        if(caller.signal.aborted||window.isDestroyed()||ctx.windows.get(caller.window)!==window||ctx.client!==client||current?.sameMachine!==true||current.id!==endpoint.id||current.url!==endpoint.url)throw Error('PILOT_OWNER_BINDING_CHANGED')
        return {root:project.canonical,projectID:project.id,operation:cancellation?'cancelExecution':publication?'ownerPlan':sending?'ownerMessage':'createTeam',generation:PEER_GENERATION,requestID,planHash:planHash(cancellation?{executionID:cancellation.executionID,identity:cancellation.identity}:publication??(sending?{recipient:input.recipient,text:input.text}:plan)),endpoint:JSON.stringify([endpoint.id,endpoint.url])}
      }
      const binding=await inspect()
      if(publication?.operation==='execution'&&publication.revoke!==true){
        const authority=(ctx as any).ownerAuthority
        if(!authority)throw Error('OWNER_AUTHORITY_UNAVAILABLE')
        const snapshot=await client.rpc(PilotRPC).snapshot({directory:binding.root},{location:{directory:binding.root},signal:caller.signal}) as any
        const current=snapshot.plans?.at(-1)
        if(!current||current.planID!==publication.planID||current.version!==publication.planVersion||current.digest!==publication.digest||current.ownerDecision!=='approve')throw Error('PLAN_REVIEW_STALE')
        const integrationApproval=await ((ctx as any).ownerAuthority?.confirmOwnerDialog??dialog.showMessageBox)(window,{type:'question',title:'Owner Integration Authority',message:'Cấp quyền tích hợp task đã review?',detail:`Project: ${binding.root}\nReviewer độc lập được merge đúng files task, test bwrap-v1, fast-forward canonical khi sạch và đồng bộ base task phụ thuộc. Không push/deploy, không shell toàn máy. Giữ nguyên budget đã dùng.`,buttons:['Hủy','Chấp thuận'],defaultId:0,cancelId:0,noLink:true})
        if(integrationApproval.response!==1)throw Error('PILOT_OWNER_CANCELLED')
        publication.policy=await authority.signExecutionPolicy(caller,{canonical:binding.root,projectID:binding.projectID,teamID:snapshot.teamID,policy:{...publication.policy,planID:current.planID,planVersion:current.version,digest:current.digest,capabilityID:`worktree-integration-v1:${randomUUID()}`}})
      }
      const signedBinding=await inspect()
      const showConfirm=(ctx as any).ownerAuthority?.confirmOwnerDialog??((w:any,o:any)=>dialog.showMessageBox(w,o))
       const choice=publication?.operation==='execution'&&publication.revoke!==true?{response:1}:await showConfirm(window,{
          type:'question',title:publication?.operation==='createTask'?'Phân công task':cancellation?'Cancel execution':publication?'Shared plan':sending?'Owner message':'Tạo Peer Team',message:publication?.operation==='createTask'?'Tạo task trong plan hiện tại và lưu phân công? Không gửi prompt hoặc cấp execution.':cancellation?'Yêu cầu interrupt đúng execution identity này? Không bảo đảm process/provider đã dừng.':publication?.decision?`Owner ${publication.decision} shared plan revision này? Không cấp execution.`:publication?'Lưu plan version mới cho toàn team?':sending?'Lưu yêu cầu Owner vào coordinator?':`Cho phép tạo ${plan.members.length} AI ngang hàng?`,
        detail:publication?.operation==='collaboration'?`Project: ${binding.root}\n${publication.enabled?'Bật gửi tin mới tới native session, gồm tag và broadcast; có thể gọi nhiều model, không đặt maxCalls chat. Không gửi lại lịch sử cũ.':'Dừng nhận thêm prompt qua coordinator. Prompt đã được native session nhận hoặc đang chạy không bị hủy.'}\nKhông cấp quyền edit/shell hoặc execution.`:publication?`Project: ${binding.root}\nPlan digest: ${binding.planHash}\n${JSON.stringify(publication).slice(0,12000)}\nKhông cấp execution. Approved scope reference chỉ là tham chiếu; không phải grant.`:sending?`Project: ${binding.root}\nTo: ${input.recipient}\n\n${input.text?.slice(0,10000)}\n\nNếu phối hợp tự động đã bật, tin sẽ gửi tới session và gọi model. Không cấp quyền execution.`:`Project: ${binding.root}\n\nNếu team đang read-only và Git đã có commit: tạo worktree và session mới cho từng Peer, giữ plan/chat/model; lưu liên kết session cũ, không xóa lịch sử. Chỉ chuyển khi tất cả Peer idle và chưa có task/execution. Lỗi giữa chừng sẽ chặn retry để tránh tạo trùng.\n\nTeam mới: tạo native sessions riêng; Git có worktree riêng mỗi Peer. Không Git: chỉ collaboration, cấm edit/shell. Không gửi model prompt hoặc cấp execution.`,
         buttons:['Hủy',publication?.operation==='collaboration'?'Xác nhận phối hợp':publication?.operation==='createTask'?'Tạo task':publication?'Lưu plan':sending?'Lưu message':'Cho phép tạo team'],defaultId:0,cancelId:0,noLink:true
      })
      if(choice.response!==1)throw Error('PILOT_OWNER_CANCELLED')
      if(caller.signal.aborted||window.isDestroyed()||ctx.windows.get(caller.window)!==window)throw Error('PILOT_OWNER_WINDOW_REQUIRED')
      const fresh=await inspect()
       if(JSON.stringify(fresh)!==JSON.stringify(signedBinding)||fresh.root!==binding.root||fresh.projectID!==binding.projectID||fresh.endpoint!==binding.endpoint)throw Error('PILOT_OWNER_PROJECT_MISMATCH')
       const authorization=issueGrant(fresh,{signal:caller.signal})
      const rpc=client.rpc(PilotRPC),options={location:{directory:binding.root},signal:caller.signal}
      if(cancellation)await rpc.cancelExecution({directory:binding.root,authorization,generation:binding.generation,requestID,executionID:cancellation.executionID,identity:cancellation.identity},options)
      else if(publication)await rpc.ownerPlan({directory:binding.root,authorization,generation:binding.generation,requestID,plan:publication},options)
       else if(sending){
         try{await rpc.ownerMessage({directory:binding.root,authorization,generation:binding.generation,requestID,recipient:input.recipient,text:input.text},options)}
         catch(error:any){
           const code=error?.data?.message??error?.message
           ctx.log.write('error','Owner message RPC failed',{requestID,root:binding.root,recipient:typeof input.recipient==='string'?input.recipient.slice(0,80):null,code:typeof code==='string'&&/^[A-Z][A-Z0-9_]+$/.test(code)?code:'PILOT_OWNER_MESSAGE_FAILED'})
           throw error
         }
       }
      else await rpc.createTeam({directory:binding.root,authorization,generation:binding.generation,requestID,plan},options)
      return true
    }finally{pending.delete(caller.window)}
  }
  const selectModel=async(input:{sessionID:string,directory:string,teamID:string,memberID?:string,targetSessionID:string,generation:string,requestID:string,expectedModelJSON:string,modelJSON:string},caller:{window:number,signal:AbortSignal})=>{
    const authority=(ctx as any).ownerAuthority
    if(!authority)throw Error(OWNER_MODEL_CONTEXT_BLOCKED)
    const window=ctx.windows.get(caller.window)
    if(!window||window.isDestroyed()||caller.signal.aborted||pending.has(caller.window))throw Error('PILOT_OWNER_WINDOW_REQUIRED')
    pending.add(caller.window)
    try{
      const client=ctx.client
      const endpoint=ctx.serverEndpoints.get('sidecar')
      if(endpoint?.sameMachine!==true)throw Error('PILOT_OWNER_LOCAL_SERVER_REQUIRED')
      if(realpathSync(input.directory)!==input.directory||input.generation!==PEER_GENERATION)throw Error('PILOT_OWNER_PROJECT_MISMATCH')
      const expectedModel=input.expectedModelJSON?JSON.parse(input.expectedModelJSON):null
      const model=JSON.parse(input.modelJSON)
      const issued=await authority.issueModelTicket(caller,{
        sessionID:input.sessionID,
        directory:input.directory,
        teamID:input.teamID,
        memberID:input.memberID,
        targetSessionID:input.targetSessionID,
        generation:input.generation,
        requestID:input.requestID,
        expectedModel,
        model
      })
      if(caller.signal.aborted||window.isDestroyed()||ctx.windows.get(caller.window)!==window)throw Error('PILOT_OWNER_WINDOW_REQUIRED')
      const rpc=client.rpc(PilotRPC),options={location:{directory:input.directory},signal:caller.signal}
      await rpc.selectModel({directory:input.directory,ticket:issued.ticket,generation:input.generation,requestID:input.requestID,teamID:input.teamID,memberID:input.memberID,sessionID:input.targetSessionID,expectedModel,model},options)
      return true
    }finally{pending.delete(caller.window)}
  }
  const acknowledgeComposer=async(input:{sessionID:string,directory:string,teamID:string,targetSessionID:string,generation:string,requestID:string,modelJSON:string},caller:{window:number,signal:AbortSignal})=>{
    const authority=(ctx as any).ownerAuthority
    if(!authority)throw Error(OWNER_MODEL_CONTEXT_BLOCKED)
    const window=ctx.windows.get(caller.window)
    if(!window||window.isDestroyed()||caller.signal.aborted||pending.has(caller.window))throw Error('PILOT_OWNER_WINDOW_REQUIRED')
    pending.add(caller.window)
    try{
      const client=ctx.client
      const endpoint=ctx.serverEndpoints.get('sidecar')
      if(endpoint?.sameMachine!==true)throw Error('PILOT_OWNER_LOCAL_SERVER_REQUIRED')
      if(realpathSync(input.directory)!==input.directory||input.generation!==PEER_GENERATION)throw Error('PILOT_OWNER_PROJECT_MISMATCH')
      const model=JSON.parse(input.modelJSON)
      const issued=await authority.issueModelTicket(caller,{
        sessionID:input.sessionID,
        directory:input.directory,
        teamID:input.teamID,
        targetSessionID:input.targetSessionID,
        generation:input.generation,
        requestID:input.requestID,
        expectedModel:model,
        model
      })
      if(caller.signal.aborted||window.isDestroyed()||ctx.windows.get(caller.window)!==window)throw Error('PILOT_OWNER_WINDOW_REQUIRED')
      const rpc=client.rpc(PilotRPC),options={location:{directory:input.directory},signal:caller.signal}
      await rpc.acknowledgeComposer({directory:input.directory,ticket:issued.ticket,generation:input.generation,requestID:input.requestID,teamID:input.teamID,sessionID:input.targetSessionID,model},options)
      return true
    }finally{pending.delete(caller.window)}
  }
  const revokeCapability=async(input:{directory?:string,teamID?:string},caller:{window:number,signal:AbortSignal})=>{
    if(!(ctx as any).ownerAuthority)return false
    return (ctx as any).ownerAuthority.revoke(caller,input)
  }
  ctx.provide(PilotOwner,{authorizeCreate:perform,send:perform,publishPlan:perform,selectModel,acknowledgeComposer,revokeCapability})
}
