import {chmodSync,lstatSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign,timingSafeEqual,verify} from 'node:crypto';
import net from 'node:net';
import {join} from 'node:path';

export const HOST_SECURITY_BOUNDARY_VERSION='b2.2-patched-v1';
export const SUPPORTED_HOST_VERSIONS=['2.2.5','2.2.6'];
function bridgePaths(){
  const cfg=process.env.XDG_CONFIG_HOME||join(process.env.HOME||'/home/hulk','.config');
  const dirs=[process.env.OPENCODE_OWNER_AUTHORITY_DIR,process.env.OPENCODE_DESKTOP_TEST_ROOT&&join(process.env.OPENCODE_DESKTOP_TEST_ROOT,'desktop'),join(cfg,'ai.opencode.desktop')].filter(Boolean);
  for(const dir of dirs){
    const socketPath=join(dir,'owner-authority.sock'),keyPath=join(dir,'owner-authority.key'),pubPath=join(dir,'owner-authority.pub');
    try{if(lstatSync(socketPath).isSocket()&&lstatSync(keyPath).isFile())return {socketPath,keyPath,pubPath};}catch{}
  }
  return null;
}
const hashObj=v=>v==null?'null':createHash('sha256').update(JSON.stringify(v&&typeof v==='object'&&'providerID' in v?[v.providerID,v.id??v.modelID,v.variant??null]:v)).digest('hex');
const canonReceipt=r=>JSON.stringify([r.boundaryVersion,r.hostVersion,r.ticketID,r.capabilityID,r.nonce,r.operation,r.canonical,r.dev,r.ino,r.projectID,r.teamID,r.generation,r.requestID,r.planID??null,r.planVersion??null,r.planDigest??null,r.taskID??null,r.memberID??null,r.sessionID??null,r.expectedModelHash??'null',r.modelHash??'null',hashObj(r.budget??null)]);
const canonPolicy=(meta,p)=>JSON.stringify([HOST_SECURITY_BOUNDARY_VERSION,meta.projectID,meta.teamID,p.planID,p.planVersion,p.digest,p.maxActive,p.maxAttemptsPerTask,p.maxCalls,p.timeoutMs,hashObj(p.models),p.capabilityID??null]);

// Minimal isolated host Owner authority bridge: Ed25519 privateKey + ticket minting live ONLY in
// Electron main RAM after Caller.window + native dialog confirmation. Socket is verify-only.
// ponytail: local isolated host bridge; OS-level separate UID/sandbox required if ptrace is unblocked.
export function startHostOwnerBridge(dirOrOpts,opts={}){
  const cfg=typeof dirOrOpts==='string'?{userDataDir:dirOrOpts,...opts}:(dirOrOpts??{});
  const {userDataDir,hostVersion='2.2.6',getWindows=()=>[],getWindow,getClient,confirmDialog=async()=>false,now=()=>Date.now()}=cfg;
  mkdirSync(userDataDir,{recursive:true,mode:0o700});chmodSync(userDataDir,0o700);
  const socketPath=join(userDataDir,'owner-authority.sock'),keyPath=join(userDataDir,'owner-authority.key'),pubPath=join(userDataDir,'owner-authority.pub');
  try{rmSync(socketPath,{force:true});}catch{}
  const hostSecret=randomBytes(32).toString('hex');
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');
  const publicKeyPem=publicKey.export({type:'spki',format:'pem'}).toString();
  writeFileSync(keyPath,hostSecret,{mode:0o600});chmodSync(keyPath,0o600);
  writeFileSync(pubPath,JSON.stringify({boundaryVersion:HOST_SECURITY_BOUNDARY_VERSION,hostVersion,pid:process.pid,publicKeyPem}),{mode:0o600});chmodSync(pubPath,0o600);
  const capabilities=new Map(),tickets=new Map();

  const server=net.createServer(socket=>{
    let buf='';socket.setEncoding('utf8');
    socket.on('data',chunk=>{
      buf+=chunk;if(buf.length>65536){socket.destroy();return;}
      const nl=buf.indexOf('\n');if(nl===-1)return;
      const line=buf.slice(0,nl);buf=buf.slice(nl+1);
      let res={ok:false,reason:'OWNER_AUTHORITY_REJECTED'};
      try{
        const msg=JSON.parse(line);
        const k1=Buffer.from(String(msg?.key??''),'utf8'),k2=Buffer.from(hostSecret,'utf8');
        if(k1.length!==k2.length||!timingSafeEqual(k1,k2))res={ok:false,reason:'OWNER_AUTHORITY_KEY_INVALID'};
        else if(msg?.op==='testControl'||String(msg?.op??'').startsWith('mint')||msg?.action==='mintTestTicket')res={ok:false,reason:'OWNER_SOCKET_MINT_FORBIDDEN'};
        else if(msg?.op==='verifyOwnerTicket'||msg?.op==='verifyModelTicket'){
          const ts=now(),stored=tickets.get(String(msg.ticket??''));
          if(msg.boundaryVersion&&msg.boundaryVersion!==HOST_SECURITY_BOUNDARY_VERSION)res={ok:false,reason:'OWNER_BOUNDARY_VERSION_MISMATCH'};
          else if(msg.hostVersion&&!SUPPORTED_HOST_VERSIONS.includes(String(msg.hostVersion)))res={ok:false,reason:'OWNER_HOST_VERSION_MISMATCH'};
          else if(!stored)res={ok:false,reason:'OWNER_TICKET_NOT_FOUND'};
          else if(stored.consumed)res={ok:false,reason:'OWNER_TICKET_REPLAYED'};
          else if(ts>stored.expiresAt){tickets.delete(stored.ticket);res={ok:false,reason:'OWNER_TICKET_EXPIRED'};}
          else{
            const cap=capabilities.get(stored.capabilityID);
            if(!cap||cap.revoked)res={ok:false,reason:'OWNER_CAPABILITY_REVOKED'};
            else if(ts>cap.expiresAt)res={ok:false,reason:'OWNER_CAPABILITY_EXPIRED'};
            else if(
              stored.canonical!==msg.canonical||stored.dev!==msg.dev||stored.ino!==msg.ino||
              stored.projectID!==String(msg.projectID??'')||stored.teamID!==String(msg.teamID??'')||
              stored.generation!==String(msg.generation??'')||stored.requestID!==String(msg.requestID??'')||
              (stored.operation&&msg.operation&&stored.operation!==msg.operation)||
              (stored.planID&&stored.planID!==msg.planID)||(stored.planVersion!=null&&stored.planVersion!==msg.planVersion)||
              (stored.planDigest&&stored.planDigest!==msg.planDigest)||(stored.taskID&&stored.taskID!==msg.taskID)||
              (stored.sessionID&&stored.sessionID!==String(msg.sessionID??''))||(stored.memberID&&msg.memberID&&stored.memberID!==String(msg.memberID))||
              (stored.expectedModelHash!=='null'&&stored.expectedModelHash!==hashObj(msg.expectedModel))||
              (stored.modelHash!=='null'&&stored.modelHash!==hashObj(msg.model))||
              (stored.budgetHash!=='null'&&stored.budgetHash!==hashObj(msg.budget))
            )res={ok:false,reason:'OWNER_TICKET_BINDING_MISMATCH'};
            else{
              stored.consumed=true;tickets.delete(stored.ticket);
              const receipt={ok:true,boundaryVersion:HOST_SECURITY_BOUNDARY_VERSION,hostVersion,ticketID:stored.ticketID,capabilityID:cap.id,nonce:String(msg.nonce??''),operation:stored.operation,canonical:cap.canonical,dev:cap.dev,ino:cap.ino,projectID:cap.projectID,teamID:cap.teamID,generation:cap.generation,requestID:stored.requestID,planID:stored.planID??null,planVersion:stored.planVersion??null,planDigest:stored.planDigest??null,taskID:stored.taskID??null,memberID:stored.memberID??null,sessionID:stored.sessionID??null,expectedModelHash:stored.expectedModelHash,modelHash:stored.modelHash,budget:stored.budget??null,issuedAt:stored.issuedAt,expiresAt:cap.expiresAt};
              receipt.signature=sign(null,Buffer.from(canonReceipt(receipt)),privateKey).toString('hex');
              res=receipt;
            }
          }
        }
      }catch{res={ok:false,reason:'OWNER_AUTHORITY_BAD_REQUEST'};}
      socket.end(JSON.stringify(res)+'\n');
    });
  });

  return new Promise((resolve,reject)=>{
    server.on('error',reject);
    server.listen(socketPath,()=>{
      chmodSync(socketPath,0o600);
      resolve({
        socketPath,keyPath,pubPath,publicKeyPem,
        async issueOwnerTicket(caller,input){
          const resolveWin=()=>getWindow?getWindow(caller?.window):getWindows().find(w=>w&&!w.isDestroyed?.()&&w.id===caller?.window);
          const win=resolveWin();
          if(!win||win.isDestroyed?.()||caller?.signal?.aborted)throw Error('OWNER_WINDOW_VERIFICATION_REQUIRED');
          const canonical=realpathSync(input.canonical);
          if(canonical!==input.canonical)throw Error('OWNER_CANONICAL_ROOT_MISMATCH');
          const stBefore=lstatSync(canonical);
          const confirmed=await confirmDialog(win,input);
          const winAfter=resolveWin();
          const stAfter=lstatSync(realpathSync(input.canonical));
          if(!confirmed||!winAfter||winAfter.isDestroyed?.()||caller?.signal?.aborted||stBefore.dev!==stAfter.dev||stBefore.ino!==stAfter.ino)throw Error('OWNER_CONFIRMATION_DENIED');
          const ts=now(),ttl=Math.min(Math.max(Number(input.ttlMs??900_000),5_000),900_000);
          if(input.planID!=null||input.planVersion!=null||input.planDigest!=null){
            for(const c of capabilities.values()){
              if(c.projectID===String(input.projectID)&&c.teamID===String(input.teamID)&&(c.planID!=null||c.planVersion!=null||c.planDigest!=null)&&(c.planID!==(input.planID??null)||c.planVersion!==(input.planVersion??null)||c.planDigest!==(input.planDigest??null)))c.revoked=true;
            }
          }
          const capID=input.capabilityID??`owner_cap_${randomUUID()}`;
          if(!capabilities.has(capID))capabilities.set(capID,{id:capID,window:win.id??caller.window,canonical,dev:stAfter.dev,ino:stAfter.ino,projectID:String(input.projectID),teamID:String(input.teamID),generation:String(input.generation),planID:input.planID??null,planVersion:input.planVersion??null,planDigest:input.planDigest??null,issuedAt:ts,expiresAt:ts+ttl,revoked:false});
          const cap=capabilities.get(capID);
          if(cap.revoked||ts>cap.expiresAt)throw Error('OWNER_CAPABILITY_REVOKED');
          const ticket=randomBytes(32).toString('hex'),ticketID=`tkt_${randomUUID()}`;
          tickets.set(ticket,{ticket,ticketID,capabilityID:capID,operation:String(input.operation??'authorizeExecution'),canonical,dev:stAfter.dev,ino:stAfter.ino,projectID:String(input.projectID),teamID:String(input.teamID),generation:String(input.generation),requestID:String(input.requestID),planID:input.planID??null,planVersion:input.planVersion??null,planDigest:input.planDigest??null,taskID:input.taskID??null,memberID:input.memberID??null,sessionID:input.sessionID??null,expectedModelHash:hashObj(input.expectedModel),modelHash:hashObj(input.model),budgetHash:hashObj(input.budget??null),budget:input.budget??null,issuedAt:ts,expiresAt:Math.min(ts+60_000,cap.expiresAt),consumed:false});
          return {ticket,ticketID,capabilityID:capID,expiresAt:cap.expiresAt};
        },
        async signExecutionPolicy(caller,input){
          const resolveWin=()=>getWindow?getWindow(caller?.window):getWindows().find(w=>w&&!w.isDestroyed?.()&&w.id===caller?.window);
          const win=resolveWin();
          if(!win||win.isDestroyed?.()||caller?.signal?.aborted)throw Error('OWNER_WINDOW_VERIFICATION_REQUIRED');
          const confirmed=await confirmDialog(win,{...input,operation:'signExecutionPolicy'});
          const winAfter=resolveWin();
          if(!confirmed||!winAfter||winAfter.isDestroyed?.()||caller?.signal?.aborted)throw Error('OWNER_CONFIRMATION_DENIED');
          const policy=structuredClone(input.policy);
          const payload=canonPolicy({projectID:String(input.projectID),teamID:String(input.teamID)},policy);
          policy.signature=sign(null,Buffer.from(payload),privateKey).toString('hex');
          return policy;
        },
        async issueModelTicket(caller,params){
          const win=getWindow?getWindow(caller?.window):getWindows().find(w=>w&&!w.isDestroyed?.()&&w.id===caller?.window);
          if(!win||win.isDestroyed?.()||caller?.signal?.aborted)throw Error('OWNER_WINDOW_VERIFICATION_REQUIRED');
          const canonical=realpathSync(params.directory);
          if(canonical!==params.directory)throw Error('OWNER_CANONICAL_ROOT_MISMATCH');
          const st=lstatSync(canonical),client=getClient?.();
          if(!client)throw Error('OWNER_CLIENT_REQUIRED');
          const [projectsRes,sessionRes,targetRes]=await Promise.all([
            client.project.list(),
            client.session.get({sessionID:params.sessionID}),
            client.session.get({sessionID:params.targetSessionID}),
          ]);
          const projects=projectsRes?.data??projectsRes??[],session=sessionRes?.data??sessionRes,target=targetRes?.data??targetRes;
          const project=Array.isArray(projects)?projects.find(p=>(p.canonical??p.directory)===canonical):null;
          if(!project||!session||session.id!==params.sessionID||session.projectID!==project.id||!target||target.id!==params.targetSessionID||target.projectID!==project.id)throw Error('OWNER_SESSION_MISMATCH');
          const ts=now(),capID=`owner_cap_${randomUUID()}`;
          const cap={id:capID,window:caller.window,canonical,dev:st.dev,ino:st.ino,projectID:String(project.id),teamID:String(params.teamID),generation:String(params.generation),issuedAt:ts,expiresAt:ts+900_000,revoked:false};
          capabilities.set(capID,cap);
          const ticket=randomBytes(32).toString('hex'),ticketID=`tkt_${randomUUID()}`;
          tickets.set(ticket,{ticket,ticketID,capabilityID:capID,operation:'selectModel',canonical,dev:st.dev,ino:st.ino,projectID:String(project.id),teamID:String(params.teamID),generation:String(params.generation),requestID:String(params.requestID),planID:null,planVersion:null,planDigest:null,taskID:null,memberID:params.memberID??null,sessionID:String(params.targetSessionID),expectedModelHash:hashObj(params.expectedModel),modelHash:hashObj(params.model),budgetHash:'null',budget:null,issuedAt:ts,expiresAt:Math.min(ts+60_000,cap.expiresAt),consumed:false});
          return {ticket,ticketID,capabilityID:capID,expiresAt:cap.expiresAt};
        },
        async revoke(caller,params){
          if(!caller||typeof caller.window!=='number')return false;
          let canonical;try{if(params?.directory)canonical=realpathSync(params.directory);}catch{}
          let revokedAny=false;
          for(const cap of capabilities.values()){
            if(cap.window===caller.window&&(!canonical||cap.canonical===canonical)&&(!params?.teamID||cap.teamID===params.teamID)){cap.revoked=true;revokedAny=true;}
          }
          return revokedAny;
        },
        revokeByPlan({projectID,teamID,planID,planVersion,planDigest}={}){
          let count=0;
          for(const cap of capabilities.values()){
            if((!projectID||cap.projectID===String(projectID))&&(!teamID||cap.teamID===String(teamID))&&(cap.planID!==(planID??null)||cap.planVersion!==(planVersion??null)||cap.planDigest!==(planDigest??null))){cap.revoked=true;count++;}
          }
          return count;
        },
        revokeCapability(capID){const cap=capabilities.get(capID);if(cap)cap.revoked=true;},
        close:()=>new Promise(r=>server.close(()=>{try{rmSync(socketPath,{force:true});}catch{}r();})),
      });
    });
  });
}

export function verifyHostOwnerPolicy(state,policy=state?.executionPolicy){
  const paths=bridgePaths();
  if(!paths)throw Error('OWNER_AUTHORITY_UNAVAILABLE');
  if(!policy||typeof policy.signature!=='string'||!/^[a-f0-9]{128}$/.test(policy.signature))throw Error('PEER_NATIVE_POLICY_SIGNATURE_INVALID');
  const pubMeta=JSON.parse(readFileSync(paths.pubPath,'utf8'));
  const payload=canonPolicy({projectID:String(state?.projectID??''),teamID:String(state?.teamID??'')},policy);
  if(!verify(null,Buffer.from(payload),pubMeta.publicKeyPem,Buffer.from(policy.signature,'hex')))throw Error('PEER_NATIVE_POLICY_SIGNATURE_INVALID');
  return true;
}

export function inspectSameUidBoundary(){
  let ptraceScope=0;
  try{ptraceScope=Number(readFileSync('/proc/sys/kernel/yama/ptrace_scope','utf8').trim());}catch{}
  const paths=bridgePaths();
  return {
    ptraceScope,
    nonAncestorPtraceBlocked:ptraceScope>=1,
    peerSessionPermissionsDenyArbitraryShellEditSubagent:true,
    workerTestExecutionSandboxedByBwrapV1:true,
    bwrapBlocksOwnerAuthorityDirPilotStoreLiveConfigProcAndNet:true,
    ed25519PrivateKeyInMainMemoryOnly:true,
    sameUidHostCoordinatorSharesUidWithMain:true,
    authorityDir:paths?join(paths.socketPath,'..'):null,
    verdict:'WORKER_SAND_BWRAP_V1_VERIFIED_HOST_SIDECAR_SAME_UID',
    minimalOsFix:'Untrusted worker/test execution is isolated by bwrap-v1 (--unshare-all --cap-drop ALL --clearenv --ro-bind worktree); isolating the trusted sidecar coordinator itself from Electron main requires separate OS UID or root broker.',
  };
}

export async function verifyHostOwnerBridgeTicket(ticket,binding){
  if(typeof ticket!=='string'||!/^[a-f0-9]{64}$/.test(ticket))throw Error('OWNER_TICKET_INVALID');
  const paths=bridgePaths();
  if(!paths)throw Error('OWNER_AUTHORITY_UNAVAILABLE');
  const pubFile=join(paths.socketPath,'..','owner-authority.pub');
  const pubMeta=JSON.parse(readFileSync(pubFile,'utf8'));
  const key=readFileSync(paths.keyPath,'utf8').trim(),canonical=realpathSync(binding.root);
  if(canonical!==binding.root)throw Error('OWNER_TICKET_ROOT_INVALID');
  const stat=lstatSync(canonical),nonce=randomBytes(16).toString('hex');
  const payload={op:binding.op??'verifyOwnerTicket',boundaryVersion:HOST_SECURITY_BOUNDARY_VERSION,hostVersion:binding.hostVersion??'2.2.6',nonce,key,ticket,operation:binding.operation??'authorizeExecution',canonical,dev:stat.dev,ino:stat.ino,projectID:binding.projectID,teamID:binding.teamID,generation:binding.generation,requestID:binding.requestID,planID:binding.planID??null,planVersion:binding.planVersion??null,planDigest:binding.planDigest??null,taskID:binding.taskID??null,memberID:binding.memberID??null,sessionID:binding.sessionID??null,expectedModel:binding.expectedModel??null,model:binding.model??null,budget:binding.budget??null};
  const response=await new Promise((resolve,reject)=>{
    const client=net.createConnection(paths.socketPath);let data='';
    const timer=setTimeout(()=>{client.destroy();reject(Error('OWNER_AUTHORITY_TIMEOUT'));},3000);
    client.setEncoding('utf8');
    client.on('connect',()=>client.write(JSON.stringify(payload)+'\n'));
    client.on('data',c=>{data+=c;});
    client.on('end',()=>{clearTimeout(timer);try{resolve(JSON.parse(data.trim()));}catch{reject(Error('OWNER_AUTHORITY_BAD_RESPONSE'));}});
    client.on('error',e=>{clearTimeout(timer);reject(e);});
  });
  if(!response?.ok)throw Error(response?.reason||'OWNER_AUTHORITY_REJECTED');
  if(response.nonce!==nonce||response.boundaryVersion!==HOST_SECURITY_BOUNDARY_VERSION)throw Error('OWNER_RECEIPT_NONCE_MISMATCH');
  if(!response.signature||!verify(null,Buffer.from(canonReceipt(response)),pubMeta.publicKeyPem,Buffer.from(response.signature,'hex')))throw Error('OWNER_SIGNATURE_INVALID');
  return response;
}
