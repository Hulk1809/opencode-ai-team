// Host-only callback. Never expose this handler through public RPC.
import {dispatchDiscussion,reconcileDiscussion} from './native-dispatch.mjs';
export async function registerCanonicalDiscussion(ctx,room,owner,expectedGeneration) {
  const directory=ctx.location.project.canonical;
  let ownership;
  const own=async team=>{
    if(!owner){
      ownership??=room.takeOwnership(directory,crypto.randomUUID(),team.owner?.generation??0).catch(error=>{ownership=undefined;throw error;});
      owner=await ownership;
    }
    return owner;
  };
  const registration=await ctx.canonical.register(async(caller,input,signal)=>{
    if(signal.aborted)throw Error('CANONICAL_INVOCATION_REVOKED');
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['recipient','text'].includes(key)))throw Error('INVALID_CANONICAL_DISCUSSION');
    if(caller.projectID!==ctx.location.project.id||caller.workspaceID!==ctx.location.workspaceID||caller.canonical!==directory)throw Error('CANONICAL_PROJECT_MISMATCH');
    const team=await room.read(directory);
    const member=team?.members?.[caller.agent],recipient=team?.members?.[input.recipient];
    if(team?.status!=='ready'||team.directory!==directory||team.projectID!==caller.projectID||team.workspaceID!==caller.workspaceID||member?.sessionID!==caller.sessionID||member?.directory!==caller.directory||member?.role!==caller.agent||!recipient)throw Error('CANONICAL_MEMBER_BINDING_MISMATCH');
    const target=await ctx.session.get({sessionID:recipient.sessionID});
    if(target.id!==recipient.sessionID||target.projectID!==caller.projectID||target.agent!==recipient.role||recipient.role!==input.recipient||target.location?.directory!==recipient.directory||target.location?.workspaceID!==caller.workspaceID)throw Error('CANONICAL_RECIPIENT_BINDING_MISMATCH');
    await own(team);
    if(ctx.options.nativeDispatch===true){
      const request=team.messages.findLast(message=>message.to===caller.agent&&message.from===input.recipient&&message.submission?.sessionID===caller.sessionID&&['submitting','admitted','processing','uncertain','completed'].includes(message.status));
      if(request){
        const rows=await ctx.session.context({sessionID:caller.sessionID});
        const anchor=rows.findIndex(row=>row.type==='user'&&row.id===request.submission.requestID);
        const assistant=rows.findIndex(row=>row.type==='assistant'&&row.id===caller.messageID);
        const previousTerminal=rows.slice(0,Math.max(0,anchor)).findLastIndex(row=>row.type==='idle');
        if(anchor>=0&&assistant>anchor&&!rows.slice(previousTerminal+1,anchor).some(row=>row.type==='user')&&!rows.slice(anchor+1,assistant).some(row=>row.type==='user'||row.type==='idle')){
          const id=await room.replyDiscussion(directory,owner,request.id,caller,input.text);
          return {id,status:'answered',requestID:request.id};
        }
        if(['submitting','admitted','processing','uncertain'].includes(request.status))throw Error('REPLY_CORRELATION_REQUIRED');
      }
    }
    const idempotencyKey=JSON.stringify([caller.sessionID,caller.messageID,caller.id]);
    const id=await room.enqueueDiscussion(directory,owner,caller.agent,input.recipient,input.text,idempotencyKey,caller,recipient);
    // Commit is durable even if generation revocation prevents notification.
    if(ctx.options.nativeDispatch===true)try{await registration.wake();}catch{}
    // Explicit development opt-in only. Default P1 enqueue path remains unchanged.
    if(ctx.options.nativeDispatch===true){
      const pending=await room.read(directory);
      for(const message of pending.messages.filter(message=>message.to===input.recipient&&message.submission&&['submitting','admitted','processing','uncertain'].includes(message.status))){
        if(signal.aborted)throw Error('DISPATCH_REVOKED');
        await reconcileDiscussion(ctx,room,directory,owner,message.id);
      }
      const dispatch=await dispatchDiscussion(ctx,room,directory,owner,input.recipient,signal);
      // Pilot remains operation-scoped; no detached worker or unowned timer may mutate queue.
      if(dispatch.status==='admitted'){
        await ctx.session.wait({sessionID:recipient.sessionID});
        if(signal.aborted)throw Error('DISPATCH_REVOKED');
        const completion=await reconcileDiscussion(ctx,room,directory,owner,dispatch.id);
        if(['completed','failed'].includes(completion.status))try{await registration.wake();}catch{}
        return {id,status:'queued',dispatch,completion};
      }
      return {id,status:'queued',dispatch};
    }
    return {id,status:'queued'};
  },expectedGeneration);
  try{
    if(ctx.options.nativeDispatch===true){
      await registration.start(async signal=>{
        const check=()=>{if(signal.aborted)throw Error('DISPATCH_REVOKED');};
        check();
        const team=await room.read(directory);
        if(team?.status!=='ready'||team.projectID!==ctx.location.project.id||team.workspaceID!==ctx.location.workspaceID||team.directory!==directory)return;
        for(const member of Object.values(team.members)){
          check();
          const session=await ctx.session.get({sessionID:member.sessionID});
          if(session.projectID!==team.projectID||session.agent!==member.role||session.location?.directory!==member.directory||session.location?.workspaceID!==team.workspaceID)throw Error('DISPATCH_SESSION_MISMATCH');
        }
        check();await own(team);
        // Finite activation snapshot; each continuation yields, no timer or polling.
        const pending=(await room.read(directory)).messages.filter(m=>m.submission&&['submitting','admitted','processing','uncertain'].includes(m.status));
        for(let offset=0;offset<pending.length;offset+=20){
          for(const message of pending.slice(offset,offset+20)){
            check();await reconcileDiscussion(ctx,room,directory,owner,message.id);
          }
          await Promise.resolve();
        }
        const queued=(await room.read(directory)).messages.filter(m=>m.status==='queued');
        for(let offset=0;offset<queued.length;offset+=20){
          for(const message of queued.slice(offset,offset+20)){
            check();
            const dispatch=await dispatchDiscussion(ctx,room,directory,owner,message.to,signal);
            if(dispatch.status==='idle'||dispatch.status==='uncertain')continue;
            if(dispatch.status==='admitted'){
              await waitRecipient(ctx,message.recipientSessionID,signal);
              check();
              const completion=await reconcileDiscussion(ctx,room,directory,owner,dispatch.id);
              if(['completed','failed'].includes(completion.status))try{await registration.wake();}catch{}
              if(!['completed','failed'].includes(completion.status))continue;
            }
          }
          await Promise.resolve();
        }
      });
    }
    return registration;
  }catch(error){await registration.dispose();throw error;}
}

function waitRecipient(ctx,sessionID,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(Error('DISPATCH_REVOKED'));
    if(signal.aborted)return abort();
    signal.addEventListener('abort',abort,{once:true});
    ctx.session.wait({sessionID}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
