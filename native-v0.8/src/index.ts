import { Plugin } from "@opencode/plugin"
import { TeamRoom, rateLimitDecision } from "./room.mjs"
import { TeamChatRPC } from "./rpc"
import { Workspace } from "./workspace.mjs"
import { errorText, redact, redactToolOutput } from "./safety.mjs"
import { TeamModels, ADMIN_INSTRUCTIONS, CONTROL_REVIEW_INSTRUCTIONS } from "./models.mjs"
import { registerDiagnostics } from "./diagnostics.mjs"
import { assertScopedPath } from "./permissions.mjs"
import { trustedDevelopment } from "./native-development.mjs"
import { nativeCaller } from "./native-caller.mjs"
import { registerCanonicalDiscussion } from "./canonical-discussion.mjs"
import { patchedCanonical, requirePatchedCanonical } from "./patched-host.mjs"
import { approvedProject, gitBinding, hasHostOwnerSocket, registerOfficialCoordinator, verifyHostOwnerTicket, verifyPatchedSidecarBoundary } from "./official-coordinator.mjs"
import { PilotRPC } from './pilot-rpc'
import { memberActivity } from './pilot-ui.mjs'
import {publicModels,memberModel,MODEL_SWITCH_BLOCKED} from './pilot-models.mjs'
import {readReport} from './pilot-reports.mjs'
import {consumeOwnerGrant} from './pilot-owner-authority.mjs'
import {PEER_GENERATION,peerPlan,planHash,teamView} from './peer-team.mjs'
import {PROTOCOL_VERSION,ownerSummary} from './peer-protocol.mjs'
import {readyTasks,taskReadiness} from './peer-readiness.mjs'
import {selectEngine} from './peer-engine-selection.mjs'
import {cancelExecutionRPC} from './peer-cancel-rpc.mjs'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {securityView} from './peer-security.mjs'
import {executionAuthorization} from './host-owner-bridge.mjs'

// Tool schemas accept both legacy specialists and the opt-in flexible worker IDs.
// Server-side TeamRoom still validates actual room membership and Admin authority.
const TEAM_ROLE_IDS = ["admin", "frontend", "backend", "devops", "qa", "worker-1", "worker-2", "worker-3"]
const TEAM_WORKER_IDS = TEAM_ROLE_IDS.filter(role => role !== "admin")

export default Plugin.define({
  id:"ai-team-chat",
  async setup(ctx) {
    const engine=selectEngine(ctx.options)
    if(engine==='legacy-read-only'){
      const legacyRead=()=>{
        const base=ctx.options?.pilotStore??join(homedir(),'.local/share/opencode/ai-team-pilot')
        const directory=join(base,createHash('sha256').update(ctx.location.project.canonical).digest('hex'))
        let state=null;try{state=JSON.parse(readFileSync(join(directory,'team.json'),'utf8'))}catch(error){if((error as any).code!=='ENOENT')throw error}
        if(state&&(state.projectID!==ctx.location.project.id||state.canonicalRoot!==ctx.location.project.canonical))throw Error('PILOT_RPC_PROJECT_MISMATCH')
        return {directory,state}
      }
      await ctx.rpc.register(PilotRPC,{runtime:async()=>({engine,execution:'BLOCKED'}),snapshot:async (input:{directory:string})=>{
        if((input as any).directory!==ctx.location.directory)throw Error('PILOT_RPC_LOCATION_MISMATCH')
        const {state}=legacyRead()
        return {...state,engine,readOnly:true,execution:'BLOCKED'}
      },report:async (input:{directory:string,id:string})=>{
        if(input.directory!==ctx.location.directory)throw Error('PILOT_RPC_LOCATION_MISMATCH')
        const {directory,state}=legacyRead()
        return readReport(directory,state,ctx.location.project.id,input.id)
      }} as any)
      return
    }
    if(engine==='canonical'){
       const coordinator=await registerOfficialCoordinator(ctx)
       const runtime={generation:PEER_GENERATION,protocolVersion:PROTOCOL_VERSION,pluginID:'ai-team-chat',serverVersion:ctx.app.version,loadedAt:new Date().toISOString(),directory:ctx.location.directory}
       await ctx.rpc.register(PilotRPC,{
          runtime:async()=>runtime,
          cancelExecution:async input=>cancelExecutionRPC(coordinator,input),
         ownerPlan:async input=>{
           const i=input as any
           if(i.directory!==ctx.location.directory||i.generation!==PEER_GENERATION||i.plan?.requestID!==i.requestID)throw Error('PILOT_OWNER_AUTHORIZATION_REQUIRED')
           consumeOwnerGrant(i.authorization,{root:ctx.location.project.canonical,projectID:ctx.location.project.id,operation:'ownerPlan',generation:i.generation,requestID:i.requestID,planHash:planHash(i.plan)})
           if(!('ownerPlan' in coordinator))throw Error('PILOT_PROJECT_NOT_APPROVED')
           return {plan:await coordinator.ownerPlan(i.plan)}
         },
        snapshot:async input=>{
           if((input as {directory:string}).directory!==ctx.location.directory)throw Error('PILOT_RPC_LOCATION_MISMATCH')
            if(!approvedProject(ctx))throw Error('PILOT_PROJECT_ROOT_REQUIRED')
           const stored=coordinator.read()
           const state=stored?{...stored,executionAuthorization:executionAuthorization(stored)}:stored
          if(!state)return {status:'unprovisioned',reason:'PILOT_PROJECT_NOT_PROVISIONED',members:[],messages:[],tasks:[]}
            if(state.projectID!==ctx.location.project.id){
              if(state.mode!=='peer'||state.isolation!=='read-only'||state.status!=='ready'||state.canonicalRoot!==ctx.location.project.canonical||state.tasks.length||(state.executions??[]).length)throw Error('PILOT_RPC_PROJECT_MISMATCH')
              return {...teamView(state),migrationRequired:true,migrationProjectID:ctx.location.project.id,reason:'Git đã đổi project ID. Cần Owner xác nhận chuyển team; dữ liệu cũ chưa thay đổi.'}
            }
            const modelCatalog=publicModels(await ctx.model.list())
          const members=await Promise.all(state.members.map(async(member:any)=>{
            const session=await ctx.session.get({sessionID:member.sessionID})
            if(session.projectID!==state.projectID||session.location.directory!==member.directory||session.agent!==member.agent)throw Error('PILOT_RPC_MEMBER_BINDING_MISMATCH')
             if(member.branch&&gitBinding(member.directory)!==member.branch)throw Error('PILOT_BRANCH_MISMATCH')
             return {...member,activity:memberActivity(session,null),outcome:session.outcome??null,model:memberModel(session,modelCatalog),usage:{cost:session.cost,input:session.tokens?.input,output:session.tokens?.output}}
          }))
            const sidecarBoundary=verifyPatchedSidecarBoundary(ctx)
            const hostOwnerReady=hasHostOwnerSocket()&&sidecarBoundary.ok
            return {...teamView(state),members,modelCatalog,runtime:{...runtime,sidecarBoundary},...(state.mode==='peer'?{security:securityView(state),ownerSummary:ownerSummary(state),readyTaskIDs:readyTasks(state).map((t:any)=>t.id),readiness:state.tasks.filter((t:any)=>t.protocolVersion).map((t:any)=>({taskID:t.id,...taskReadiness(state,t)})),approvals:state.approvals??[],receipts:state.receipts??[],modelReceipts:state.modelReceipts??[],integrations:state.integrations??[],executions:state.executions??[]}:{}),modelSwitch:{allowed:hostOwnerReady,reason:hostOwnerReady?'HOST_OWNER_CAPABILITY_READY · B2.2 isolated host Owner authority active; không cấp execution.':!sidecarBoundary.ok?`BOUNDARY_MISMATCH_BLOCKED · ${sidecarBoundary.reason}`:MODEL_SWITCH_BLOCKED}}
        },
         createTeam:async (input,context)=>{
           if((input as {directory:string}).directory!==ctx.location.directory)throw Error('PILOT_RPC_LOCATION_MISMATCH')
            if(!approvedProject(ctx))return context.error('project_not_ready','Canonical project không hợp lệ.',{})
          // RPC has no Owner principal. Existing teams may be reopened; provisioning needs trusted host setup.
            const upgrading=coordinator.read()?.isolation==='read-only'
            if(!coordinator.read()||upgrading){
              try{const i=input as any;const plan=peerPlan(i.plan);if(i.generation!==PEER_GENERATION)throw Error('STALE_GENERATION');consumeOwnerGrant(i.authorization,{root:ctx.location.project.canonical,projectID:ctx.location.project.id,operation:'createTeam',generation:i.generation,requestID:i.requestID,planHash:planHash(plan)})}
             catch{return context.error('owner_authorization_required','Cần xác nhận Owner qua hộp thoại Desktop để tạo team. Không tạo session hoặc worktree.',{})}
           }
            if(upgrading&&'upgradeWorktrees' in coordinator)await coordinator.upgradeWorktrees()
            else await coordinator.bootstrap((input as any).plan)
          const state=coordinator.read()
          if(!state)throw Error('PILOT_PROVISION_FAILED')
           const members=await Promise.all(state.members.map(async(member:any)=>{
            const session=await ctx.session.get({sessionID:member.sessionID})
             return {...member,activity:memberActivity(session,null),outcome:session.outcome??null}
          }))
          return {...state,members}
        },
        report:async input=>{
          const inp=input as {directory:string,id:string}
          if(inp.directory!==ctx.location.directory)throw Error('PILOT_RPC_LOCATION_MISMATCH')
          if(!('directory' in coordinator))throw Error('PILOT_PROJECT_NOT_APPROVED')
          return readReport(coordinator.directory,coordinator.read(),ctx.location.project.id,inp.id)
        },
        ownerMessage:async (input,context)=>{
          try{
          const inp=input as {directory:string,recipient:string,text:string,requestID?:string}
           if(inp.directory!==ctx.location.directory)throw Error('PILOT_RPC_LOCATION_MISMATCH')
           const i=input as any
           if(i.generation!==PEER_GENERATION)throw Error('PILOT_OWNER_AUTHORIZATION_REQUIRED')
           consumeOwnerGrant(i.authorization,{root:ctx.location.project.canonical,projectID:ctx.location.project.id,operation:'ownerMessage',generation:i.generation,requestID:i.requestID,planHash:planHash({recipient:i.recipient,text:i.text})})
           const result=await coordinator.ownerSend({recipient:inp.recipient,text:inp.text,requestID:inp.requestID})
           if('dispatchMessages' in coordinator)await coordinator.dispatchMessages()
           return {ok:true,message:result}
          }catch(error){
            const message=error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'PILOT_OWNER_MESSAGE_FAILED'
            return context.error('owner_message_failed',message,{message})
          }
        },
        selectModel:async input=>{
          const i=input as any
          if(i.directory!==ctx.location.directory||i.generation!==PEER_GENERATION)throw Error('PILOT_OWNER_AUTHORIZATION_REQUIRED')
          if(!('selectModel' in coordinator))throw Error('PILOT_PROJECT_NOT_APPROVED')
          const verified:any=await verifyHostOwnerTicket(i.ticket,{
            serverBoundary:verifyPatchedSidecarBoundary(ctx),
            root:ctx.location.project.canonical,
            projectID:ctx.location.project.id,
            teamID:i.teamID,
            memberID:i.memberID,
            sessionID:i.sessionID,
            generation:i.generation,
            requestID:i.requestID,
            expectedModel:i.expectedModel??null,
            model:i.model,
          })
          const preference=await (coordinator as any).selectModel({
            operation:'selectModel',
            requestID:i.requestID,
            generation:i.generation,
            teamID:i.teamID,
            memberID:i.memberID,
            sessionID:i.sessionID,
            expectedModel:i.expectedModel??null,
            model:i.model,
            capabilityID:verified.capabilityID,
          })
          return {ok:true,preference}
        },
        acknowledgeComposer:async input=>{
          const i=input as any
          if(i.directory!==ctx.location.directory||i.generation!==PEER_GENERATION)throw Error('PILOT_OWNER_AUTHORIZATION_REQUIRED')
          if(!('acknowledgeComposer' in coordinator))throw Error('PILOT_PROJECT_NOT_APPROVED')
          await verifyHostOwnerTicket(i.ticket,{
            serverBoundary:verifyPatchedSidecarBoundary(ctx),
            root:ctx.location.project.canonical,
            projectID:ctx.location.project.id,
            teamID:i.teamID,
            sessionID:i.sessionID,
            generation:i.generation,
            requestID:i.requestID,
            expectedModel:i.model,
            model:i.model,
          })
          const preference=await (coordinator as any).acknowledgeComposer({
            requestID:i.requestID,
            generation:i.generation,
            teamID:i.teamID,
            sessionID:i.sessionID,
            model:i.model,
          })
          return {ok:true,preference}
        }
      })
      return
    }
    throw Error('PEER_ENGINE_SELECTION_INVALID')
    await registerDiagnostics(ctx)
    const room = new TeamRoom(ctx)
    const canonicalRegistration=patchedCanonical(ctx)&&ctx.location.directory===ctx.location.project.canonical
      ?await registerCanonicalDiscussion(ctx,room,null):null
    // SDK 2.2.0 Context has no message.list: do not discover another service for history.
    // No authenticated RPC principal or revision-freeze provider in this host yet.
    // Protected DONE must fail closed; never derive these capabilities from payload.
    const workspace = new Workspace(ctx,room)
    const models = new TeamModels(ctx,room)
    const timer=setInterval(()=>{void room.read(ctx.location.directory).then(team=>team?.messages.some((m:any)=>['waiting','queued','admitted','uncertain'].includes(m.status))?room.sync(ctx.location.directory):undefined).catch(()=>{})},2000)
    timer.unref()
    await ctx.session.hook("retry",async event=>{
      if(event.error.status!==429)return
      const session=await ctx.session.get({sessionID:event.sessionID})
      const directory=session.metadata?.teamDirectory
      if(typeof directory!=="string"||directory!==ctx.location.directory)return
       const decision=rateLimitDecision(event.error,event.attempt)!
       event.decision=decision.retry?{retry:true,delay:decision.delay}:{retry:false}
       const delay=decision.delay
      await room.exclusive(directory,async()=>{
        const team=await room.read(directory);if(!team)return
        team.providerCooldowns??={};team.providerCooldowns[event.model.providerID]={until:new Date(Date.now()+delay).toISOString(),last429At:new Date().toISOString(),attempt:event.attempt}
        await room.write(directory,team)
      })
    })
    await ctx.session.hook("context",async(event)=>{
      if(event.agent!=="admin")return
      const session=await ctx.session.get({sessionID:event.sessionID})
      for(const name of Object.keys(event.tools))if(/^(?:subagent|agent)$/i.test(name))delete event.tools[name]
      if(typeof session.metadata?.teamDirectory==="string")event.system.push({type:"text",text:`${ADMIN_INSTRUCTIONS} ${CONTROL_REVIEW_INSTRUCTIONS} Chỉ điều phối qua team tools tới registered sessions. Không dùng Agent/subagent hoặc fallback khi team tool lỗi.`})
      else event.system.push({type:'text',text:'Session Admin này chưa liên kết AI Team room. Không gọi Agent/subagent thay thế. team tools sẽ báo lỗi; yêu cầu Owner mở AI Team Admin session hiện có trong Team Chat, không tạo team/session mới hoặc tự khai metadata để nâng quyền.'})
    })
    async function memberRPC(sessionID:string) {
      const {directory}=await nativeCaller(ctx,room,sessionID)
      // Local facade closes over native caller; payload can neither select nor elevate identity.
      const check=async(input:any)=>{
        await nativeCaller(ctx,room,sessionID)
        if(input.directory!==directory||input.sessionID!==undefined&&input.sessionID!==sessionID)throw Error('NATIVE_CALLER_INPUT_MISMATCH')
      }
      const rpc={
        snapshot:async(input:any,_options?:any)=>{await check(input);return room.snapshot(directory)},
        workspace:async(input:any,_options?:any)=>{await check(input);return workspace.execute(directory,sessionID,input.action,input.payload)},
        memberSend:async(input:any,_options?:any)=>{
          await check(input)
          const team=await room.read(directory)
          const canWait=!team?.messages.some((m:any)=>m.to===input.recipient&&['waiting','queued','admitted','uncertain'].includes(m.status))
          const id=await room.sendAsSession(directory,sessionID,input.recipient,input.text,{...(input.kind?{kind:input.kind}:{}),...(input.taskID?{taskID:input.taskID}:{}),...(input.idempotencyKey?{idempotencyKey:input.idempotencyKey}:{})})
          return {id,canWait}
        },
        memberInbox:async(input:any,_options?:any)=>{await check(input);const caller=await nativeCaller(ctx,room,sessionID);const current=await room.read(directory);const team=current.messages.some((m:any)=>m.submission)?current:await room.sync(directory);return room.discussionInbox(team,caller.role,input.query)}
      }
      const options={}
      return {directory,rpc,options}
    }
    const registration=await ctx.rpc.register(TeamChatRPC, {
      execution:async(input,context)=>{
        const x=input as {directory:string,maxWorkers:number,providerLimits:Record<string,number>}
        try {throw Error('RPC_MUTATION_REQUIRES_TRUSTED_CALLER')}
        catch(e){const reason=errorText(e);return context.error("operation_failed",reason,{reason})}
      },
      models:async(input,context)=>{
        const x=input as {directory:string,action:string,role?:string,providerID?:string,modelID?:string,variant?:string,saveDefault?:boolean}
        try {if(x.directory!==ctx.location.directory)throw new Error("Sai room gốc")
          if(x.action!=='list')throw Error('RPC_MUTATION_REQUIRES_TRUSTED_CALLER')
          return x.action==="list"?await models.catalog():await models.change(x.directory,{role:x.role,providerID:x.providerID,modelID:x.modelID,variant:x.variant,saveDefault:x.saveDefault})
        }catch(e){const reason=errorText(e);return context.error("operation_failed",reason,{reason})}
      },
       workspace:async(input,context)=>{
        const x=input as {directory:string,sessionID?:string,action:string,payload:Record<string,unknown>}
        try {
            if(x.directory!==ctx.location.directory) throw new Error("Sai room gốc")
           if(x.sessionID!==undefined)throw Error('RPC_CALLER_UNAUTHENTICATED: use native team tools')
           if(!['list','read','download','tasks','monitor','owner_requests'].includes(x.action))throw Error('RPC_MUTATION_REQUIRES_TRUSTED_CALLER')
           if(['approve_coding','approve_build'].includes(x.action))throw new Error('Approval denied: OpenCode 2.2 RPC exposes no authenticated Owner principal; omitted sessionID is not Owner authentication')
           return await workspace.execute(x.directory,x.sessionID,x.action,x.payload)
        } catch(e){const reason=errorText(e);return context.error("operation_failed",reason,{reason})}
      },
       memberSend:async(input,context)=>{
         const reason='RPC_CALLER_UNAUTHENTICATED: use native team tools'
         return context.error('operation_failed',reason,{reason})
      },
       memberInbox:async(input)=>{
         throw Error('RPC_CALLER_UNAUTHENTICATED: use native team tools')
      },
      createTeam: async (input, context) => {
        const reason='RPC_MUTATION_REQUIRES_TRUSTED_CALLER'
        return context.error('setup_failed',reason,{reason})
      },
      snapshot: async (input) => {
        const x=input as {directory:string}
        if(x.directory !== ctx.location.directory) throw new Error("Sai thư mục dự án")
        return (await room.snapshot(x.directory)) ?? {exists:false}
      },
      sync: async (input) => {
        const x=input as {directory:string}
        if(x.directory !== ctx.location.directory) throw new Error("Sai thư mục dự án")
        // Public reconnect may read state, never dispatch queued model work without a caller.
        return (await room.snapshot(x.directory)) ?? {exists:false}
      },
      send: async (input,context) => {
        const reason='RPC_MUTATION_REQUIRES_TRUSTED_CALLER'
        return context.error('operation_failed',reason,{reason})
      },
    })
    room.onChange=(directory:string)=>registration.events.emit('changed',{directory})
    await ctx.tool.transform((editor) => {
      // Team sessions must not read credentials through ordinary file tools.
      for(const tool of editor.list()) {
        const execute=tool.execute
        editor.update(tool.id,t=>{t.execute=async(input,context)=>{
          const session=await ctx.session.get({sessionID:context.sessionID})
          if((session.agent==='admin'||typeof session.metadata?.teamDirectory==='string')&&/^(?:subagent|agent)$/i.test(tool.name))throw new Error('AI_TEAM_SUBAGENT_DISABLED: dùng team tools với registered AI Team sessions; session thiếu liên kết phải mở đúng Admin từ Team Chat, không fallback.')
           const teamDirectory=session.metadata?.teamDirectory
           const native=typeof teamDirectory==='string'&&trustedDevelopment(ctx.options,ctx.location.directory,session,await room.read(teamDirectory))
            if(!native&&typeof teamDirectory==='string'&&['write','edit','patch','shell'].includes(tool.name)){
             const route=await memberRPC(context.sessionID)
             const state:any=await route.rpc.snapshot({directory:route.directory},route.options)
             const member:any=Object.values(state.members??{}).find((m:any)=>m.sessionID===context.sessionID)
             const scope=member?.codingScope
             if(!scope||session.location.directory!==scope.directory)throw new Error('Coding scope chưa được Owner phê duyệt hoặc session sai worktree')
             const x=input as {path?:string,command?:string}
             if(tool.name==='shell'){
               if(!scope.commands.includes(x.command))throw new Error('Lệnh ngoài coding scope; Owner cần duyệt scope riêng. Không tự mở rộng Maven allowlist')
             }else{
               if(!x.path)throw new Error('Tool edit cần path cụ thể; patch đa file chưa được cấp scope')
               const target=await assertScopedPath(scope.directory,x.path)
               const {resolve}=await import('node:path')
               if(!scope.files.some((f:string)=>resolve(scope.directory,f)===target))throw new Error('File ngoài coding scope đã duyệt')
             }
           }
          if(!native&&typeof teamDirectory==="string" && ["read","glob","grep"].includes(tool.name)) {
            const {resolve,sep}=await import("node:path")
            const {realpath}=await import("node:fs/promises")
            const x=input as {path?:string};const base=await realpath(ctx.location.directory)
            const target=await realpath(resolve(base,x.path??"."))
            const relative=target.slice(base.length).split(sep)
            if((target!==base&&!target.startsWith(base+sep))||relative.some(part=>part===".git"||part===".env"||part.startsWith(".env.")||/\.(pem|key|p12|pfx)$/.test(part))) throw new Error("Team không được đọc ngoài worktree hoặc file credentials")
          }
           const result=await execute(input,context)
           return typeof teamDirectory==="string" ? redactToolOutput(result) : result
        }})
      }
      editor.namespace({name:"team",description:"Send and receive team collaboration messages between actual OpenCode sessions"})
      editor.add({name:'request_owner_review',description:'Persist metadata-only Owner review request. No execution approval. Never include secrets, tokens, login URLs or device codes.',options:{namespace:'team'},input:{type:'object',properties:{taskID:{type:'string'},content:{type:'string',minLength:1,maxLength:4000},scope:{type:'string',minLength:1,maxLength:4000},risk:{type:'string',enum:['low','medium','high']},expiresAt:{type:'string'},idempotencyKey:{type:'string',minLength:1,maxLength:160}},required:['content','scope','risk','expiresAt','idempotencyKey'],additionalProperties:false},execute:async(input,context)=>{
        const route=await memberRPC(context.sessionID)
        return {content:JSON.stringify(await route.rpc.workspace({directory:route.directory,sessionID:context.sessionID,action:'owner_request',payload:input as Record<string,unknown>},route.options))}
      }})
      editor.add({name:'assign_tasks',description:'Admin: atomically queue up to four role tasks in one batch. Existing registered workers only; dependencies use task keys or existing task IDs. No new permissions.',options:{namespace:'team'},input:{type:'object',properties:{requestID:{type:'string',minLength:1,maxLength:160},tasks:{type:'array',minItems:1,maxItems:4,items:{type:'object',properties:{key:{type:'string'},assignee:{type:'string',enum:TEAM_WORKER_IDS},title:{type:'string'},description:{type:'string'},dependencies:{type:'array',items:{type:'string'}}},required:['key','assignee','title','description'],additionalProperties:false}}},required:['requestID','tasks'],additionalProperties:false},execute:async(input,context)=>{
        const route=await memberRPC(context.sessionID);return {content:redact(JSON.stringify(await route.rpc.workspace({directory:route.directory,sessionID:context.sessionID,action:'assign_batch',payload:input as Record<string,unknown>},route.options)))}
      }})
      for(const [name,action] of Object.entries({batch_status:'batch_status',propose_aws_auth:'aws_propose',request_aws_auth:'aws_request'}))editor.add({name,description:action==='batch_status'?'Admin: sync batch status and per-task timestamps/errors/evidence.':'AWS project workflow only; DevOps proposes metadata account (12 digits), environment, purpose, scope, profile, method (sso-device-code or login-remote). Admin requests Owner review by requestID. Broker unavailable: BLOCKED; never include URL, code or credentials.',options:{namespace:'team'},input:{type:'object',properties:{payload:{type:'object',properties:{batchID:{type:'string'},requestID:{type:'string'},account:{type:'string'},environment:{type:'string'},purpose:{type:'string'},scope:{type:'string'},profile:{type:'string'},method:{type:'string',enum:['sso-device-code','login-remote']}},additionalProperties:false}},required:['payload'],additionalProperties:false},execute:async(input,context)=>{
        const route=await memberRPC(context.sessionID);return {content:redact(JSON.stringify(await route.rpc.workspace({directory:route.directory,sessionID:context.sessionID,action,payload:(input as {payload:Record<string,unknown>}).payload},route.options)))}
      }})
      editor.add({name:'discover_environment',description:'Read-only project manifest inventory; no scripts, provisioning, network or Docker.',options:{namespace:'team'},input:{type:'object',properties:{},additionalProperties:false},execute:async(_input,context)=>{
        const route=await memberRPC(context.sessionID)
        const result=await route.rpc.workspace({directory:route.directory,sessionID:context.sessionID,action:'environment',payload:{}},route.options)
        return {content:redact(JSON.stringify(result))}
      }})
       editor.add({name:'build',description:'Run offline Maven test/verify for own active task in Owner-approved pinned container; no arbitrary shell or mounts.',options:{namespace:'team'},input:{type:'object',properties:{taskID:{type:'string',minLength:1},goal:{type:'string',enum:['test','verify']}},required:['taskID','goal'],additionalProperties:false},execute:async(input,context)=>{
         const route=await memberRPC(context.sessionID)
         const result=await route.rpc.workspace({directory:route.directory,sessionID:context.sessionID,action:'build',payload:input as Record<string,unknown>},route.options)
         return {content:redact(JSON.stringify(result))}
       }})
        const actions:Record<string,string>={task_discussion:'task_discussion',upload_file:"upload",list_files:"list",read_file:"read",share_file:"share",create_task:"task",list_tasks:"tasks",attach_to_task:"artifact",submit_artifact:"artifact",request_review:"review",report_blocker:"blocker",update_task:"update"}
      for(const [name,action] of Object.entries(actions)) editor.add({
         name,description:`Team workspace ${action}. File access uses fileID. Upload visibility defaults private; explicit team shares project-wide, restricted requires share_file recipient. share_file recipient=team explicitly broadens ACL. revision is descriptive, not trusted QA proof. Send summary + fileID + revision, read chunks only when needed; never paste full history/secrets. task_discussion: Admin-only taskID, last 24 messages.`,
         input:{type:"object",properties:{payload:{type:"object",properties:{visibility:{type:"string",enum:['private','restricted','team']},revision:{type:"string",maxLength:160},fileID:{type:"string"},taskID:{type:"string"},name:{type:"string"},base64:{type:"string"},mime:{type:"string"},recipient:{type:"string"},offset:{type:"integer",minimum:0},limit:{type:"integer",minimum:1,maximum:24000},title:{type:"string"},description:{type:"string"},assignee:{type:"string"},priority:{type:"string"},status:{type:"string"},note:{type:"string"},finalReport:{type:"string"},inputAttachments:{type:"array",items:{type:"string"}},acceptanceCriteria:{type:"array",items:{type:"string"}},dependencies:{type:"array",items:{type:"string"}}},additionalProperties:false}},required:["payload"],additionalProperties:false},options:{namespace:"team"},
        execute:async(input,context)=>{
          try {const route=await memberRPC(context.sessionID);const result=await route.rpc.workspace({directory:route.directory,sessionID:context.sessionID,action,payload:(input as {payload:Record<string,unknown>}).payload},route.options);return {content:redact(JSON.stringify(result))}}
          catch(e){return {content:`Workspace bị chặn: ${errorText(e)}. Báo blocker, không lặp retry.`,metadata:{blocked:true}}}
        },
      })
      editor.add({
        name:"send_message",
        description:"Queue ordinary discussion to a registered team member. No execution, approval or dispatch. Returns durable queued ID, not a reply.",
        input:{type:"object",properties:{recipient:{type:"string",enum:TEAM_ROLE_IDS},text:{type:"string",minLength:1,maxLength:10000}},required:["recipient","text"],additionalProperties:false},
        options:{namespace:"team",codemode:false},
         execute: async (input) => {
            const x=input as {recipient:string,text:string}
           const {id}=await requirePatchedCanonical(ctx).invoke(input) as {id:string}
           return {content:`Request ${id} đã queued tới ${x.recipient}; chưa phải acknowledgement hoặc task accepted. Theo dõi team.list_tasks/team.get_inbox; không gửi trùng khi hỏi trạng thái.`}
        },
      })
      editor.add({
         name:"get_inbox",
        description:"Read actual AI Team replies addressed to the current role. Syncs real OpenCode assistant messages; never fabricates chat content.",
         input:{type:"object",properties:{requestID:{type:"string",minLength:1,maxLength:160},before:{type:"string",minLength:1,maxLength:160},limit:{type:"integer",minimum:1,maximum:100}},additionalProperties:false},
         options:{namespace:"team",codemode:false},
        execute: async (_input, context) => {
          const route=await memberRPC(context.sessionID)
           const {messages:inbox,before}=await route.rpc.memberInbox({directory:route.directory,sessionID:context.sessionID,query:_input},route.options) as {messages:Array<{at:string,from:string,text:string}>,before?:string}
           return {content:(inbox.length ? inbox.map((m: any)=>`[${m.at}] id=${m.id} requestID=${m.requestID??m.id} ${m.from}: ${m.text}`).join("\n\n") : "Chưa có tin trả lời thực tế.")+(before?`\n\nOlder messages: before=${before}`:"")}
        },
      })
      editor.add({
        name:"ask_agent",
        description:"Queue ordinary discussion through trusted canonical host invocation. No model dispatch or synchronous wait.",
        input:{type:"object",properties:{recipient:{type:"string",enum:TEAM_ROLE_IDS},text:{type:"string",minLength:1,maxLength:10000},dependency:{type:"boolean"}},required:["recipient","text"],additionalProperties:false},
        options:{namespace:"team"},
        execute: async (input) => {
           const x=input as {recipient:string,text:string,dependency?:boolean}
           const {id}=await requirePatchedCanonical(ctx).invoke({recipient:x.recipient,text:x.text}) as {id:string}
           return {content:`Đã xếp câu hỏi ${id} tới ${x.recipient}; chưa dispatch hoặc nhận phản hồi.`}
        },
      })
    })
    return async()=>{clearInterval(timer);await canonicalRegistration?.dispose()}
  },
})
