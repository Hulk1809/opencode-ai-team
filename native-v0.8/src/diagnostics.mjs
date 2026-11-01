import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';

// Diagnostic opt-in only. Never persist raw bodies, URLs, headers or argument values.
export function requestShape(value, depth=0) {
  if(depth>18)return {truncated:true};
  if(value===null)return null;
  if(typeof value==='string')return {stringLength:value.length};
  if(typeof value!=='object')return {type:typeof value};
  if(Array.isArray(value))return value.slice(0,1000).map(v=>requestShape(v,depth+1));
  const safeKeys=new Set(['messages','contents','parts','role','type','content','text','tools','function','functionCall','functionResponse','tool_calls','tool_call_id','id','name','arguments','args','response','result','input','output','parameters','properties','required','items','additionalProperties','system','systemInstruction','generationConfig','model','stream','thinkingConfig','thought','thoughtSignature','reasoning_content']);
  return Object.fromEntries(Object.entries(value).slice(0,1000).map(([key,v],i)=>{
    const label=safeKeys.has(key)?key:`field-${i}`;
    if(['id','tool_call_id'].includes(key)&&typeof v==='string')return [label,{reference:createHash('sha256').update(v).digest('hex').slice(0,16)}];
    if(['role','type'].includes(key)&&['user','assistant','system','tool','model','function','text','tool_use','tool_result','function_call','function_call_output'].includes(v))return [label,v];
    return [label,requestShape(v,depth+1)];
  }));
}

export async function registerDiagnostics(ctx) {
  const ids=new WeakMap();
  const enabled=async event=>{
    const session=await ctx.session.get({sessionID:event.sessionID});
    return session.metadata?.teamBoundaryDiagnostic===true&&session.location?.directory===ctx.location.directory;
  };
  const save=async record=>{
    const directory='/tmp/opencode/team-boundary';await mkdir(directory,{recursive:true,mode:0o700});
    await appendFile(`${directory}/requests.jsonl`,JSON.stringify(record)+'\n',{mode:0o600});
  };
  await ctx.session.hook('http.request',async event=>{
    if(!await enabled(event))return;
    const requestID=randomUUID();ids.set(event.request,requestID);
    const body=await event.request.clone().text();let structure;
    try{structure=requestShape(JSON.parse(body));}catch{structure={nonJSON:true,bytes:Buffer.byteLength(body)};}
    await save({at:new Date().toISOString(),phase:'request',requestID,sessionID:event.sessionID,kind:event.kind,providerID:event.model.providerID,modelID:event.model.id,method:event.request.method,structure});
  });
  await ctx.session.hook('http.response',async event=>{
    if(!await enabled(event))return;
    // Do not consume streaming responses. Error strings may contain secrets; retain shape only.
    let error;
    if(!event.response.ok){try{error=requestShape(await event.response.clone().json());}catch{error={nonJSON:true};}}
    await save({at:new Date().toISOString(),phase:'response',requestID:ids.get(event.request)??null,sessionID:event.sessionID,kind:event.kind,providerID:event.model.providerID,modelID:event.model.id,status:event.response.status,error});
  });
}
