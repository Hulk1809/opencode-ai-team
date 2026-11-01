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

export default Plugin.define({
  id:"ai-team-chat",
  async setup(ctx) {
    await registerDiagnostics(ctx)
    const room = new TeamRoom(ctx)
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
        memberInbox:async(input:any,_options?:any)=>{await check(input);const caller=await nativeCaller(ctx,room,sessionID);const team=await room.sync(directory);return {messages:team.messages.filter((m:any)=>m.to===caller.role).slice(-24)}}
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
      editor.add({name:'assign_tasks',description:'Admin: atomically queue up to four role tasks in one batch. Existing registered workers only; dependencies use task keys or existing task IDs. No new permissions.',options:{namespace:'team'},input:{type:'object',properties:{requestID:{type:'string',minLength:1,maxLength:160},tasks:{type:'array',minItems:1,maxItems:4,items:{type:'object',properties:{key:{type:'string'},assignee:{type:'string',enum:['backend','frontend','devops','qa']},title:{type:'string'},description:{type:'string'},dependencies:{type:'array',items:{type:'string'}}},required:['key','assignee','title','description'],additionalProperties:false}}},required:['requestID','tasks'],additionalProperties:false},execute:async(input,context)=>{
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
        description:"Send execution or control request. Use kind=control for correction, unblock, review or cancellation; taskID must name explicit task, never infer from text. Control bypasses blocked execution FIFO, not permissions. Returns queued ID, not a reply.",
        input:{type:"object",properties:{recipient:{type:"string",enum:["admin","frontend","backend","devops","qa"]},text:{type:"string",minLength:1,maxLength:10000},kind:{type:"string",enum:["execution","control"]},taskID:{type:"string",minLength:1},idempotencyKey:{type:"string",minLength:1,maxLength:160}},required:["recipient","text"],additionalProperties:false},
        options:{namespace:"team"},
        execute: async (input, context) => {
           const x=input as {recipient:string,text:string,kind?:"execution"|"control",taskID?:string,idempotencyKey?:string}
          const route=await memberRPC(context.sessionID)
          const {id}=await route.rpc.memberSend({...x,directory:route.directory,sessionID:context.sessionID},route.options) as {id:string}
           return {content:`Request ${id} đã queued tới ${x.recipient}; chưa phải acknowledgement hoặc task accepted. Theo dõi team.list_tasks/team.get_inbox; không gửi trùng khi hỏi trạng thái.`}
        },
      })
      editor.add({
        name:"get_inbox",
        description:"Read actual AI Team replies addressed to the current role. Syncs real OpenCode assistant messages; never fabricates chat content.",
        input:{type:"object",properties:{},additionalProperties:false},
        options:{namespace:"team"},
        execute: async (_input, context) => {
          const route=await memberRPC(context.sessionID)
          const {messages:inbox}=await route.rpc.memberInbox({directory:route.directory,sessionID:context.sessionID},route.options) as {messages:Array<{at:string,from:string,text:string}>}
          return {content:inbox.length ? inbox.map((m: any)=>`[${m.at}] ${m.from}: ${m.text}`).join("\n\n") : "Chưa có tin trả lời thực tế."}
        },
      })
      editor.add({
        name:"ask_agent",
        description:"Send asynchronously by default. Set dependency:true only if answer is required to continue; never wait on an already busy recipient. Poll at most 60s, then return pending ID.",
        input:{type:"object",properties:{recipient:{type:"string",enum:["admin","frontend","backend","devops","qa"]},text:{type:"string",minLength:1,maxLength:10000},dependency:{type:"boolean"}},required:["recipient","text"],additionalProperties:false},
        options:{namespace:"team"},
        execute: async (input, context) => {
          const x=input as {recipient:string,text:string,dependency?:boolean}
          const route=await memberRPC(context.sessionID)
          const {id,canWait}=await route.rpc.memberSend({recipient:x.recipient,text:x.text,directory:route.directory,sessionID:context.sessionID},route.options) as {id:string,canWait?:boolean}
          if(!x.dependency||!canWait)return {content:`Đã xếp câu hỏi ${id} tới ${x.recipient}; không giữ lượt model chờ. Tiếp tục việc độc lập, kiểm tra team.get_inbox sau.`}
          for(let tries=0;tries<30;tries++) {
            if(context.signal.aborted) throw new Error("Request cancelled")
            await new Promise((resolve)=>setTimeout(resolve,2000))
            const {messages}=await route.rpc.memberInbox({directory:route.directory,sessionID:context.sessionID},route.options) as {messages:Array<{requestID:string,text:string}>}
            const reply=messages.find(m=>m.requestID===id)
            if(reply) return {content:`[Trả lời thật của ${x.recipient}] ${reply.text}`}
          }
          return {content:`Đã gửi câu hỏi ${id} tới ${x.recipient}, nhưng chưa có phản hồi trong 60 giây. Dùng team_get_inbox để kiểm tra sau.`}
        },
      })
    })
    return ()=>clearInterval(timer)
  },
})
