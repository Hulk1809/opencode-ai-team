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
        const project=projects.find((p:any)=>p.id===session.projectID)
        if(session.id!==input.sessionID||!project||project.canonical!==input.directory||session.location.directory!==input.directory||realpathSync(input.directory)!==input.directory)throw Error('PILOT_OWNER_PROJECT_MISMATCH')
        const current=ctx.serverEndpoints.get('sidecar')
        if(caller.signal.aborted||window.isDestroyed()||ctx.windows.get(caller.window)!==window||ctx.client!==client||current?.sameMachine!==true||current.id!==endpoint.id||current.url!==endpoint.url)throw Error('PILOT_OWNER_BINDING_CHANGED')
        return {root:project.canonical,projectID:project.id,operation:cancellation?'cancelExecution':publication?'ownerPlan':sending?'ownerMessage':'createTeam',generation:PEER_GENERATION,requestID,planHash:planHash(cancellation?{executionID:cancellation.executionID,identity:cancellation.identity}:publication??(sending?{recipient:input.recipient,text:input.text}:plan)),endpoint:JSON.stringify([endpoint.id,endpoint.url])}
      }
      const binding=await inspect()
      const showConfirm=(ctx as any).ownerAuthority?.confirmOwnerDialog??((w:any,o:any)=>dialog.showMessageBox(w,o))
      const choice=await showConfirm(window,{
         type:'question',title:publication?.operation==='selectModel'?'Peer model':cancellation?'Cancel execution':publication?'Shared plan':sending?'Owner message':'Tạo Peer Team',message:publication?.operation==='selectModel'?'Lưu model native cho Peer đang idle? Không gửi prompt hoặc cấp execution.':cancellation?'Yêu cầu interrupt đúng execution identity này? Không bảo đảm process/provider đã dừng.':publication?.decision?`Owner ${publication.decision} shared plan revision này? Không cấp execution.`:publication?'Lưu plan version mới cho toàn team?':sending?'Lưu yêu cầu Owner vào coordinator?':`Cho phép tạo ${plan.members.length} AI ngang hàng?`,
        detail:publication?`Project: ${binding.root}\nPlan digest: ${binding.planHash}\n${JSON.stringify(publication).slice(0,12000)}\nKhông cấp execution. Approved scope reference chỉ là tham chiếu; không phải grant.`:sending?`Project: ${binding.root}\nTo: ${input.recipient}\n\n${input.text?.slice(0,10000)}\n\nKhông cấp quyền execution hoặc gửi model prompt.`:`Project: ${binding.root}\n\nTạo native sessions riêng. Git: worktree riêng mỗi peer. Không Git: chỉ collaboration, cấm edit/shell. Không gửi model prompt hoặc tự chạy.`,
        buttons:['Hủy',publication?'Lưu plan':sending?'Lưu message':'Cho phép tạo team'],defaultId:0,cancelId:0,noLink:true
      })
      if(choice.response!==1)throw Error('PILOT_OWNER_CANCELLED')
      if(caller.signal.aborted||window.isDestroyed()||ctx.windows.get(caller.window)!==window)throw Error('PILOT_OWNER_WINDOW_REQUIRED')
      const fresh=await inspect()
      if(JSON.stringify(fresh)!==JSON.stringify(binding))throw Error('PILOT_OWNER_PROJECT_MISMATCH')
      const authorization=issueGrant(binding,{signal:caller.signal})
      const rpc=client.rpc(PilotRPC),options={location:{directory:binding.root},signal:caller.signal}
      if(cancellation)await rpc.cancelExecution({directory:binding.root,authorization,generation:binding.generation,requestID,executionID:cancellation.executionID,identity:cancellation.identity},options)
      else if(publication)await rpc.ownerPlan({directory:binding.root,authorization,generation:binding.generation,requestID,plan:publication},options)
      else if(sending)await rpc.ownerMessage({directory:binding.root,authorization,generation:binding.generation,requestID,recipient:input.recipient,text:input.text},options)
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
