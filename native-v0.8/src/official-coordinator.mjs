import {mkdirSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync,realpathSync,lstatSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import net from 'node:net';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {DEFAULT_MODELS,sameModel} from './model-routing.mjs';
import {publicModels} from './pilot-models.mjs';
import {reportBody,writeReport,readReport} from './pilot-reports.mjs';
import {peerPlan,planHash,memberID} from './peer-team.mjs';
import {ingestPlan,protocolAction,protocolFields} from './peer-protocol.mjs';
import {queueMessages} from './peer-delivery.mjs';
import {denyLiveAdmission} from './peer-security.mjs';
import {inbox,acknowledge} from './peer-delivery.mjs';
import {reviewPlan} from './peer-approvals.mjs';
import {verifyNativeBinding,hasVerifiedStop} from './peer-native.mjs';
import {integrateReviewedTask} from './peer-integration.mjs';
import {assertScopedPath} from './permissions.mjs';
import {verifyHostOwnerPolicy} from './host-owner-bridge.mjs';
import {admission} from './native-peer-adapter.mjs';

export const APPROVED_PROJECT='/home/hulk/projects/v08-desktop-acceptance';
export const APPROVED_PROJECT_ROOT_COMMIT='7af15c690957779faf78055670eafcd356a1c201';
export const HOST_SECURITY_BOUNDARY_VERSION='b2.2-patched-v1';
export const EXPECTED_SERVER_VERSION='2.2.5';
export const PEER_SESSION_PERMISSIONS=[{action:'edit',resource:'*',effect:'deny'},{action:'shell',resource:'*',effect:'deny'},{action:'subagent',resource:'*',effect:'deny'}];

export function hostAuthorityPaths(){
  const cfg=process.env.XDG_CONFIG_HOME||join(homedir(),'.config');
  const dirs=[process.env.OPENCODE_OWNER_AUTHORITY_DIR,process.env.OPENCODE_DESKTOP_TEST_ROOT&&join(process.env.OPENCODE_DESKTOP_TEST_ROOT,'desktop'),join(cfg,'ai.opencode.desktop'),join(cfg,'ai.opencode.desktop.dev'),join(cfg,'OpenCode')].filter(Boolean);
  for(const dir of dirs){
    const socketPath=join(dir,'owner-authority.sock'),keyPath=join(dir,'owner-authority.key');
    try{
      const s=lstatSync(socketPath),k=lstatSync(keyPath);
      if(s.isSocket()&&k.isFile()&&s.uid===process.getuid?.()&&k.uid===process.getuid?.()&&(k.mode&0o077)===0)return {socketPath,keyPath};
    }catch{}
  }
  return null;
}
function hasIsolatedHostBridge(version,ctx){
  if(!process.env.OPENCODE_OWNER_AUTHORITY_DIR&&!ctx?.location?.project?.canonical)return false;
  const paths=hostAuthorityPaths();
  if(!paths||!version)return false;
  try{
    const pub=JSON.parse(readFileSync(join(paths.socketPath,'..','owner-authority.pub'),'utf8'));
    return pub?.boundaryVersion===HOST_SECURITY_BOUNDARY_VERSION&&pub?.hostVersion===version&&typeof pub?.publicKeyPem==='string';
  }catch{return false;}
}
export function verifyPatchedSidecarBoundary(ctx){
  const version=String(ctx?.app?.version??'');
  const bridgeReady=hasIsolatedHostBridge(version,ctx);
  const hasActive=typeof ctx?.session?.active==='function'||bridgeReady;
  if(version&&version!==EXPECTED_SERVER_VERSION&&!bridgeReady)return {ok:false,reason:`SIDECAR_VERSION_MISMATCH:${version}!=${EXPECTED_SERVER_VERSION}`};
  if(!hasActive)return {ok:false,reason:'SIDECAR_UNPATCHED_SESSION_ACTIVE_MISSING'};
  return {ok:true,boundaryVersion:HOST_SECURITY_BOUNDARY_VERSION,serverVersion:version||EXPECTED_SERVER_VERSION};
}
export const hasHostOwnerSocket=()=>hostAuthorityPaths()!==null;
export async function verifyHostOwnerTicket(ticket,binding){
  if(typeof ticket!=='string'||!/^[a-f0-9]{64}$/.test(ticket))throw Error('OWNER_TICKET_INVALID');
  if(binding.serverBoundary&&!binding.serverBoundary.ok)throw Error(binding.serverBoundary.reason||'SIDECAR_BOUNDARY_INVALID');
  const paths=hostAuthorityPaths();
  if(!paths)throw Error('OWNER_AUTHORITY_UNAVAILABLE');
  const key=readFileSync(paths.keyPath,'utf8').trim(),canonical=realpathSync(binding.root);
  if(canonical!==binding.root)throw Error('OWNER_TICKET_ROOT_INVALID');
  const stat=lstatSync(canonical);
  if(!stat.isDirectory())throw Error('OWNER_TICKET_ROOT_INVALID');
  const payload={op:'verifyModelTicket',boundaryVersion:HOST_SECURITY_BOUNDARY_VERSION,hostVersion:EXPECTED_SERVER_VERSION,key,ticket,canonical,dev:stat.dev,ino:stat.ino,projectID:binding.projectID,teamID:binding.teamID,memberID:binding.memberID,sessionID:binding.sessionID,generation:binding.generation,requestID:binding.requestID,expectedModel:binding.expectedModel??null,model:binding.model};
  const response=await new Promise((resolve,reject)=>{
    const client=net.createConnection(paths.socketPath);
    let data='';
    const timer=setTimeout(()=>{client.destroy();reject(Error('OWNER_AUTHORITY_TIMEOUT'));},3000);
    client.setEncoding('utf8');
    client.on('connect',()=>client.write(JSON.stringify(payload)+'\n'));
    client.on('data',chunk=>{data+=chunk;});
    client.on('end',()=>{clearTimeout(timer);try{resolve(JSON.parse(data.trim()));}catch{reject(Error('OWNER_AUTHORITY_BAD_RESPONSE'));}});
    client.on('error',err=>{clearTimeout(timer);reject(err);});
  });
  if(!response?.ok)throw Error(response?.reason||'OWNER_AUTHORITY_REJECTED');
  if(response.boundaryVersion&&response.boundaryVersion!==HOST_SECURITY_BOUNDARY_VERSION)throw Error('OWNER_BOUNDARY_VERSION_MISMATCH');
  return response;
}
const gitEnv=()=>({...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'});

function browserCheckMounts(){
  // ponytail: reuse installed host runtime; configure portable discovery when packaging beyond this host.
  const dependencies=join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
  const browsers=join(homedir(),'.cache/ms-playwright');
  for(const path of [dependencies,browsers])if(realpathSync(path)!==path)throw Error('PEER_BROWSER_RUNTIME_INVALID');
  return ['--ro-bind',join(dependencies,'playwright'),'/opt/peer-runtime/playwright','--ro-bind',join(dependencies,'playwright-core'),'/opt/peer-runtime/playwright-core','--ro-bind',browsers,'/opt/peer-browsers','--ro-bind',fileURLToPath(new URL('./peer-browser-check.mjs',import.meta.url)),'/opt/peer-browser-check.mjs'];
}

export async function runRequiredChecks(cwd,checks,forbiddenPaths=[]){
  const commands=[];
  for(const check of checks){
    const browserCheck=['browser smoke: CRUD/filter/comment/reload/import/export','browser smoke','browser e2e','keyboard-only check','viewport 375px check','README commands verified','mobile 375px','keyboard-only'].includes(check);
    if(!browserCheck&&!/^node --test(?:\s+[A-Za-z0-9_./-]+)*$/.test(check))throw Error('PEER_WORKTREE_CHECK_FORBIDDEN');
    if(!browserCheck)for(const path of check.split(/\s+/).slice(2))await assertScopedPath(cwd,path);
    const output=runInBwrapSandbox(cwd,browserCheck?['/opt/peer-browser-check.mjs',check]:check.split(/\s+/).slice(1),{timeout:browserCheck?60000:15000,forbiddenPaths,browserCheck});
    commands.push({command:check,exitCode:0,output:output.slice(0,4000)});
  }
  return commands;
}

export function runInBwrapSandbox(cwd,argv,{timeout=15000,forbiddenPaths=[],browserCheck}={}){
  const realCwd=realpathSync(cwd);
  if(realCwd!==cwd)throw Error('PEER_WORKTREE_SANDBOX_PATH_INVALID');
  const blocked=['/opt/OpenCode',join(homedir(),'.config/opencode'),join(homedir(),'.config/ai.opencode.desktop'),process.env.OPENCODE_OWNER_AUTHORITY_DIR,...forbiddenPaths].filter(Boolean);
  if(blocked.some(b=>realCwd===b||realCwd.startsWith(b+'/')||b.startsWith(realCwd+'/')))throw Error('PEER_WORKTREE_SANDBOX_FORBIDDEN_MOUNT');
  const nodeBin=[process.execPath,join(homedir(),'.local/nodejs/bin/node'),'/home/hulk/.local/nodejs/bin/node','/usr/local/bin/node','/usr/bin/node'].find(p=>{try{return /(?:^|\/)node$/.test(p)&&lstatSync(p);}catch{return false;}})||'node';
  const nodeReal=realpathSync(nodeBin),nodeRoot=dirname(dirname(nodeReal)),gitPath=join(realCwd,'.git');
  let gitMask=[];
  const browserMounts=browserCheck?browserCheckMounts():[];
  try{gitMask=lstatSync(gitPath).isDirectory()?['--tmpfs',gitPath]:['--ro-bind-try','/dev/null',gitPath];}catch{}
  const bwrapArgs=[
    '--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv',
    '--ro-bind','/usr','/usr',
    '--ro-bind-try','/lib','/lib',
    '--ro-bind-try','/lib64','/lib64',
    '--ro-bind-try','/bin','/bin',
    '--ro-bind-try','/sbin','/sbin',
    '--ro-bind-try','/etc/alternatives','/etc/alternatives',
    '--ro-bind-try','/etc/ld.so.cache','/etc/ld.so.cache',
    '--dev','/dev','--proc','/proc',
    '--tmpfs','/tmp','--tmpfs','/run','--tmpfs','/var','--tmpfs','/home',
    ...(nodeRoot.startsWith('/usr')?[]:['--ro-bind',nodeRoot,nodeRoot]),
    '--ro-bind',realCwd,realCwd,
    ...browserMounts,
    ...gitMask,
    '--chdir',realCwd,
    '--setenv','PATH',`${dirname(nodeReal)}:/usr/local/bin:/usr/bin:/bin`,
    '--setenv','HOME','/tmp',
    '--setenv','TMPDIR','/tmp',
    '--setenv','OPENCODE_WORKER_SANDBOX','bwrap-v1',
    '--setenv','OPENCODE_WORKSPACE_DIR',realCwd,
    ...(browserCheck?['--setenv','PLAYWRIGHT_BROWSERS_PATH','/opt/peer-browsers']:[]),
    '--','/bin/sh','-c','for fd in /proc/self/fd/*; do n=${fd##*/}; [ "$n" -gt 2 ] 2>/dev/null && eval "exec ${n}<&- ${n}>&-" || true; done; exec "$@"','--',
    nodeReal,...argv,
  ];
  try{return execFileSync('bwrap',bwrapArgs,{cwd:realCwd,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',OPENCODE_WORKER_SANDBOX:'bwrap-v1'},encoding:'utf8',timeout,stdio:['ignore','pipe','pipe']});}
  catch(error){throw Error(`PEER_WORKTREE_CHECK_FAILED: ${String(error.stderr||error.code||error.message).slice(-3000)}`);}
}

export function validGitProject(root){
  if(typeof root!=='string'||!root.startsWith('/')||root.includes('\0'))return false;
  try{
    if(realpathSync(root)!==root)return false;
    const gitDir=join(root,'.git');
    const stat=lstatSync(gitDir);
    if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile()))return false;
    const toplevel=execFileSync('git',['-C',root,'rev-parse','--show-toplevel'],{encoding:'utf8',env:gitEnv()}).trim();
    if(toplevel!==root)return false;
    const rootCommit=execFileSync('git',['-C',root,'rev-list','--max-parents=0','HEAD'],{encoding:'utf8',env:gitEnv()}).trim();
    return !!rootCommit;
  }catch{return false;}
}

export function projectIdentity(canonicalRoot){
  if(!validGitProject(canonicalRoot))throw Error('PILOT_GIT_PROJECT_REQUIRED');
  const rootCommit=execFileSync('git',['-C',canonicalRoot,'rev-list','--max-parents=0','HEAD'],{encoding:'utf8',env:gitEnv()}).trim().split('\n')[0];
  return {
    canonicalRoot,
    rootCommit,
    key:createHash('sha256').update(canonicalRoot).digest('hex')
  };
}

export function approvedProject(ctx){
  const root=ctx?.location?.project?.canonical;
  try{return typeof root==='string'&&root.startsWith('/')&&realpathSync(root)===root&&lstatSync(root).isDirectory();}catch{return false;}
}

export function gitBinding(directory){
  const git=(...args)=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',env:gitEnv()}).trim();
  if(git('rev-parse','--show-toplevel')!==directory)throw Error('PILOT_GIT_ROOT_MISMATCH');
  return git('symbolic-ref','--short','HEAD');
}

// ponytail: one local filesystem coordinator; abandoned lock requires manual inspection, never timed takeover.
export class OfficialCoordinator {
  constructor(ctx){
    this.ctx=ctx;
    this.root=ctx.location.project.canonical;
    if(typeof this.root!=='string'||!this.root.startsWith('/'))throw Error('PILOT_PROJECT_ROOT_REQUIRED');
    const base=ctx.options?.pilotStore??join(homedir(),'.local/share/opencode/ai-team-pilot');
    if(typeof base!=='string'||!base.startsWith('/'))throw Error('PILOT_STORE_ABSOLUTE_REQUIRED');
    this.directory=join(base,createHash('sha256').update(this.root).digest('hex'));
    mkdirSync(this.directory,{recursive:true,mode:0o700});this.file=join(this.directory,'team.json');
  }
  read(){try{return JSON.parse(readFileSync(this.file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
  mutate(reducer){
    const lock=join(this.directory,'writer.lock');let fd;
    try{fd=openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw Error('PILOT_STORE_BUSY_OR_RECOVERY_REQUIRED');throw e;}
    const temp=join(this.directory,`${randomUUID()}.pending`);
    try{
      const state=this.read();const result=reducer(state);
      if(result?.then)throw Error('ASYNC_PILOT_REDUCER_FORBIDDEN');
      const next=result.state??state;
      const out=openSync(temp,'wx',0o600);
      try{writeFileSync(out,JSON.stringify(next));fsyncSync(out);}finally{closeSync(out);}
      renameSync(temp,this.file);const dir=openSync(this.directory,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
      return result.value;
    }finally{closeSync(fd);unlinkSync(lock);}
  }
  async caller(context){
    const state=this.read(),member=state?.members.find(m=>m.sessionID===context?.sessionID);
    if(!member||state.status!=='ready'||state.projectID!==this.ctx.location.project.id)throw Error('PILOT_MEMBER_REQUIRED');
    const session=await this.ctx.session.get({sessionID:context.sessionID});
    for(const [field,actual,expected] of [['session',session.id,member.sessionID],['project',session.projectID,state.projectID],['agent',session.agent,member.agent],['caller-agent',context.agent,member.agent],['directory',session.location.directory,member.directory],['workspace',session.location.workspaceID,member.workspaceID]])if(actual!==expected)throw Error(`PILOT_BINDING_MISMATCH:${field}`);
    if(this.ctx.location.directory!==member.directory)throw Error('PILOT_TOOL_LOCATION_MISMATCH');
    if(member.branch&&gitBinding(member.directory)!==member.branch)throw Error('PILOT_BRANCH_MISMATCH');
    return member;
  }
  async upgradeWorktrees(){
    const before=this.read();
    if(before?.mode!=='peer'||before.isolation!=='read-only'||before.status!=='ready'||this.ctx.location.directory!==this.root)throw Error('PILOT_UPGRADE_STATE_INVALID');
    if(!validGitProject(this.root))throw Error('PILOT_GIT_PROJECT_REQUIRED');
    if(before.canonicalRoot!==this.root||before.executionPolicy||before.approvals?.length)throw Error('PILOT_UPGRADE_PROJECT_CHANGED');
    if(before.tasks.length||(before.executions??[]).length)throw Error('PILOT_UPGRADE_TASKS_EXIST');
    if(typeof this.ctx.session.active!=='function'&&typeof this.ctx.session.wait!=='function')throw Error('PILOT_UPGRADE_ACTIVITY_UNKNOWN');
    const active=typeof this.ctx.session.active==='function'?await this.ctx.session.active():null,models=new Map();
    if(active!==null&&(!active||typeof active!=='object'||Array.isArray(active)))throw Error('PILOT_UPGRADE_ACTIVITY_UNKNOWN');
    for(const member of before.members){
      if(active===null){
        let timer;
        try{await Promise.race([this.ctx.session.wait({sessionID:member.sessionID}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PILOT_UPGRADE_SESSION_ACTIVE')),2000);})]);}
        finally{clearTimeout(timer);}
      }
      const session=await this.ctx.session.get({sessionID:member.sessionID});
      if((active?.data??active)?.[member.sessionID])throw Error('PILOT_UPGRADE_SESSION_ACTIVE');
      if(session.id!==member.sessionID||![before.projectID,this.ctx.location.project.id].includes(session.projectID)||session.location.directory!==this.root||session.location.workspaceID!==member.workspaceID||session.agent!==member.agent)throw Error('PILOT_UPGRADE_BINDING_MISMATCH');
      models.set(memberID(member),session.model??member.modelDefault);
    }
    const revision=JSON.stringify(before);
    this.mutate(state=>{
      if(JSON.stringify(state)!==revision)throw Error('PILOT_UPGRADE_STALE');
      state.status='upgrading';state.previousMembers=structuredClone(state.members);
      state.provisioning=state.members.map(m=>({id:memberID(m),status:'pending'}));return {};
    });
    // ponytail: interrupted migration stays blocked; add explicit recovery before retrying uncertain native effects.
    for(const member of before.members){
      const id=memberID(member),name=`pilot-${id}-${randomUUID()}`;
      this.mutate(state=>{state.provisioning.find(m=>m.id===id).status='creating';return {};});
      const wt=await this.ctx.worktree.create({projectID:this.ctx.location.project.id,name}),directory=wt.directory;
      const common=p=>realpathSync(execFileSync('git',['-C',p,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8',env:gitEnv()}).trim());
      if(typeof directory!=='string'||realpathSync(directory)!==directory||directory===this.root||common(directory)!==common(this.root)||this.read().members.some(m=>m.directory===directory))throw Error('PILOT_WORKSPACE_ISOLATION_REQUIRED');
      execFileSync('git',['-C',directory,'switch','--create',name],{stdio:'pipe',env:gitEnv()});
      const session=await this.ctx.session.create({title:`AI Team V0.8 | ${member.label}`,agent:member.agent,model:models.get(id),permissions:PEER_SESSION_PERMISSIONS,location:{directory}});
      if(session.projectID!==this.ctx.location.project.id||session.location.directory!==directory||session.agent!==member.agent||!sameModel(session.model,models.get(id)))throw Error('PILOT_PROVISIONING_BINDING_MISMATCH');
      const actual=await this.ctx.session.get({sessionID:session.id});
      verifyNativeBinding({...before,projectID:this.ctx.location.project.id},{...member,sessionID:session.id,directory,workspaceID:session.location.workspaceID,branch:gitBinding(directory),modelDefault:models.get(id)},actual);
      this.mutate(state=>{const m=state.members.find(m=>memberID(m)===id);Object.assign(m,{sessionID:session.id,directory,workspaceID:session.location.workspaceID,branch:gitBinding(directory),worktreeID:wt.id??name,modelDefault:models.get(id),editingEnabled:false});delete m.modelPreference;state.provisioning.find(m=>m.id===id).status='created';return {};});
    }
    this.mutate(state=>{state.previousProjectID=state.projectID;state.projectID=this.ctx.location.project.id;state.isolation='git-worktree';state.rootCommit=projectIdentity(this.root).rootCommit;state.status='ready';return {};});
    return this.read();
  }
  async bootstrap(input){
    if(this.read())return this.read();
    if(this.ctx.location.directory!==this.root)throw Error('PILOT_BOOTSTRAP_ROOT_REQUIRED');
    const plan=peerPlan(input),git=validGitProject(this.root);
    const catalog=publicModels(await this.ctx.model.list());
    if(this.read())return this.read();
    const model=DEFAULT_MODELS.worker;
    if(!catalog.some(m=>m.providerID===model.providerID&&m.id===model.id&&m.variants.includes(model.variant)))throw Error('PILOT_DEFAULT_MODEL_UNAVAILABLE: Owner cần chọn model khác; không fallback');
    const teamID=`team_${randomUUID()}`;
    // Persist provisioning intent before native side effects; interrupted setup never blindly recreates sessions.
    const claimed=this.mutate(state=>state?{value:false}:{state:{schemaVersion:2,mode:'peer',generation:plan.generation,planHash:planHash(plan),teamID,projectID:this.ctx.location.project.id,canonicalRoot:this.root,rootCommit:git?projectIdentity(this.root).rootCommit:null,isolation:git?'git-worktree':'read-only',status:'provisioning',members:[],messages:[],tasks:[],provisioning:plan.members.map(m=>({...m,status:'pending'}))},value:true});
    if(!claimed)return this.read();
    for(const peer of plan.members){
      const role=peer.id;
      let directory=this.root,worktreeID=null;
      // Persist intent BEFORE native effects. Unknown outcome is never automatically retried.
      this.mutate(state=>{state.provisioning.find(m=>m.id===role).status='creating';return {};});
      if(git){
        const name=`pilot-${role}-${randomUUID()}`;
        const wt=await this.ctx.worktree.create({projectID:this.ctx.location.project.id,name});
         directory=wt.directory;worktreeID=wt.id??name;
         if(typeof directory!=='string'||realpathSync(directory)!==directory||directory===this.root||this.read().members.some(m=>m.directory===directory))throw Error('PILOT_WORKSPACE_ISOLATION_REQUIRED');
         const common=path=>realpathSync(execFileSync('git',['-C',path,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8',env:gitEnv()}).trim());
         if(common(directory)!==common(this.root))throw Error('PILOT_WORKSPACE_REPOSITORY_MISMATCH');
        // Official 2.2.5 creates detached worktrees; bind new worker branch before session creation.
        execFileSync('git',['-C',directory,'switch','--create',name],{stdio:'pipe',env:gitEnv()});
      }
      const branch=git?gitBinding(directory):null;
      if(git&&['main','master'].includes(branch))throw Error('PILOT_WORKER_MAIN_FORBIDDEN');
      const permissions=PEER_SESSION_PERMISSIONS;
      const session=await this.ctx.session.create({title:`AI Team V0.8 | ${peer.label}`,agent:'build',model,permissions,location:{directory}});
      if(session.projectID!==this.ctx.location.project.id||session.location.directory!==directory)throw Error('PILOT_PROVISIONING_BINDING_MISMATCH');
      this.mutate(state=>{state.members.push({id:peer.id,label:peer.label,role,branch,sessionID:session.id,agent:session.agent,directory:session.location.directory,workspaceID:session.location.workspaceID,worktreeID,editingEnabled:false});return {};});
      const actual=await this.ctx.session.get({sessionID:session.id});
      if(actual.id!==session.id||actual.projectID!==this.ctx.location.project.id||actual.location.directory!==directory||!sameModel(actual.model,model))throw Error('PILOT_DEFAULT_MODEL_READBACK_MISMATCH');
      verifyNativeBinding(this.read(),{...this.read().members.find(m=>m.sessionID===session.id),modelDefault:model},actual);
      this.mutate(state=>{const member=state.members.find(m=>m.sessionID===session.id);member.modelDefault={...model};state.provisioning.find(m=>m.id===role).status='created';return {};});
    }
    this.mutate(state=>{state.status='ready';return {};});
    return this.read();
  }
  async wake(message){
    if(this.read()?.mode==='peer')throw Error('PEER_NATIVE_DISPATCH_DISABLED');
    if(message.action!=='assign')return message;
    const state=this.read(),target=state.members.find(m=>m.role===message.to);
    const session=await this.ctx.session.get({sessionID:target.sessionID});
    if(session.id!==target.sessionID||session.projectID!==state.projectID||session.agent!==target.agent||session.location.directory!==target.directory||session.location.workspaceID!==target.workspaceID||gitBinding(target.directory)!==target.branch)throw Error('PILOT_WAKE_BINDING_MISMATCH');
    const prepared=this.mutate(current=>{
      const row=current.messages.find(m=>m.id===message.id);
      if(row.wake)return {value:false};
      row.wake={status:'submitting',sessionID:target.sessionID,promptID:`msg_${row.id.replaceAll('-','')}`};return {value:row};
    });
    if(!prepared)return this.read().messages.find(m=>m.id===message.id);
    try{
      const receipt=await this.ctx.session.prompt({sessionID:target.sessionID,id:prepared.wake.promptID,delivery:'queue',text:`Assigned task ${message.taskID}: ${message.text}\nUse team_ack and team_send to report. Assigned worktree: ${target.directory}; branch: ${target.branch}. Do not edit other worktrees or change permissions.`});
      if(receipt.id!==prepared.wake.promptID)throw Error('PILOT_WAKE_RECEIPT_MISMATCH');
      this.mutate(current=>{current.messages.find(m=>m.id===message.id).wake.status='admitted';return {};});
    }catch(error){
      this.mutate(current=>{const row=current.messages.find(m=>m.id===message.id);row.wake.status='uncertain';row.wake.error=String(error);return {};});
    }
    return this.read().messages.find(m=>m.id===message.id);
  }
  async ownerExecution(input){
    return this.mutate(state=>{
      const plan=state?.plans?.at(-1);
      if(Object.keys(input).some(k=>!['operation','requestID','policy','revoke','planID','planVersion','digest'].includes(k))||typeof input.requestID!=='string'||!input.requestID.trim()||input.requestID.length>160||!plan||plan.planID!==input.planID||plan.version!==input.planVersion||plan.digest!==input.digest)throw Error('EXECUTION_INPUT_INVALID');
      state.executionAuthorizations??=[];
      const hash=planHash(input),old=state.executionAuthorizations.find(r=>r.requestID===input.requestID);
      if(old){if(old.hash!==hash)throw Error('PILOT_IDEMPOTENCY_CONFLICT');return {value:old};}
      if(input.revoke===true){if(state.executionPolicy)state.executionPolicy.revokedAt=Date.now();}
      else{
        const p=input.policy;
        if(state.mode!=='peer'||state.status!=='ready'||state.isolation!=='git-worktree'||state.canonicalRoot!==this.root||plan.ownerDecision!=='approve'||plan.needsOwner||!plan.discussionClosed||!p||Object.keys(p).some(k=>!['planID','planVersion','digest','maxActive','maxAttemptsPerTask','maxCalls','timeoutMs','models','capabilityID','signature'].includes(k))||p.planID!==plan.planID||p.planVersion!==plan.version||p.digest!==plan.digest||![p.maxActive,p.maxAttemptsPerTask,p.maxCalls,p.timeoutMs].every(n=>Number.isSafeInteger(n)&&n>0)||p.maxActive>4||p.maxAttemptsPerTask>10||p.maxCalls>1000||p.timeoutMs>3600000||!Array.isArray(p.models)||!p.models.length||p.models.some(model=>!state.members.some(m=>sameModel(m.modelDefault,model))))throw Error('EXECUTION_POLICY_INVALID');
        verifyHostOwnerPolicy(state,p);
        const prior=state.executionPolicy;
        const refresh=prior&&['planID','planVersion','digest','maxActive','maxAttemptsPerTask','maxCalls','timeoutMs','models'].every(k=>JSON.stringify(prior[k])===JSON.stringify(p[k]));
        if(state.tasks.some(t=>t.executionState==='outstanding')&&!refresh)throw Error('EXECUTION_OUTSTANDING');
        if(state.executionAuthorizations.some(r=>r.signature===p.signature))throw Error('EXECUTION_POLICY_REPLAY');
        state.executionPolicy={...structuredClone(p),usedCalls:refresh?prior.usedCalls:0};
        if(refresh)for(const row of state.executions??[]){
          const task=state.tasks.find(t=>t.id===row.taskID);
          if(row.scope==='worktree'&&row.state==='admitted-by-adapter'&&row.deadline>Date.now()&&task?.lease&&task.ownershipGeneration===row.identity.ownershipGeneration&&task.workRevision===row.identity.workRevision)task.lease.expiresAt=Math.max(task.lease.expiresAt,row.deadline);
        }
      }
      const receipt={requestID:input.requestID,hash,signature:input.policy?.signature,revoked:input.revoke===true,planID:plan.planID,planVersion:plan.version,digest:plan.digest,at:Date.now(),scope:this.root,authority:'owner-bridge',supersedesPlanningOnly:input.revoke!==true};
      state.executionAuthorizations.push(receipt);return {value:receipt};
    });
  }
  async ownerSend(input){
    if(!input||typeof input!=='object')throw Error('INVALID_PILOT_INPUT');
    if(typeof input.text!=='string'||!input.text.trim())throw Error('PILOT_TEXT_REQUIRED');
    if(input.text.length>10000)throw Error('PILOT_TEXT_TOO_LONG');
    const state=this.read();
    if(state?.mode==='peer'?!['team',...state.members.map(memberID)].includes(input.recipient):input.recipient!=='admin')throw Error('PILOT_RECIPIENT_INVALID');
    const requestID=(typeof input.requestID==='string'&&input.requestID.trim())?input.requestID.trim():randomUUID();
    if(requestID.length>160)throw Error('PILOT_REQUEST_ID_TOO_LONG');
    return this.mutate(state=>{
      if(state.status!=='ready')throw Error('PILOT_NOT_READY');
      const old=state.messages.find(m=>m.from==='owner'&&m.requestID===requestID);
      if(old){
        if(old.to!==input.recipient||old.text!==input.text)throw Error('PILOT_IDEMPOTENCY_CONFLICT');
        return {value:old};
      }
      const message={id:randomUUID(),requestID,from:'owner',to:input.recipient,text:input.text,action:'send',at:new Date().toISOString()};
      state.messages.push(message);
      return {value:message};
    });
  }
  async ownerPlan(input){
    if(input?.operation==='execution')return this.ownerExecution(input);
    if(input?.operation==='selectModel')return this.selectModel(input);
    if(input?.operation==='testFixtureAction')return this.testFixtureAction(input);
    return this.mutate(state=>{
      if(input?.operation==='closeDiscussion'){
        if(Object.keys(input).some(k=>!['operation','requestID','planID','planVersion','digest'].includes(k))||typeof input.requestID!=='string')throw Error('PLAN_REVIEW_INVALID');
        const plan=state?.plans?.at(-1);
        if(!plan||plan.planID!==input.planID||plan.version!==input.planVersion||plan.digest!==input.digest||plan.ownerDecision!=='approve')throw Error('PLAN_REVIEW_STALE');
        plan.discussionClosed=true;state.discussionClosures??=[];
        if(!state.discussionClosures.some(r=>r.requestID===input.requestID))state.discussionClosures.push({...input,at:Date.now(),authority:'owner-bridge'});
        return {value:{discussionClosed:true,executionAuthorized:false}};
      }
      if(input?.operation==='collaboration'){
        if(Object.keys(input).some(k=>!['operation','requestID','enabled'].includes(k))||typeof input.enabled!=='boolean'||typeof input.requestID!=='string'||state?.mode!=='peer'||state.status!=='ready'||state.projectID!==this.ctx.location.project.id)throw Error('COLLABORATION_INPUT_INVALID');
        state.collaborationRequests??=[];
        const old=state.collaborationRequests.find(r=>r.requestID===input.requestID);
        if(old){if(old.enabled!==input.enabled)throw Error('PILOT_IDEMPOTENCY_CONFLICT');return {value:state.collaboration};}
        state.collaboration={enabled:input.enabled,enabledAt:Date.now(),requestID:input.requestID};
        if(!input.enabled)for(const d of state.deliveries??[])if(d.status==='queued')d.status='paused';
        state.collaborationRequests.push({requestID:input.requestID,enabled:input.enabled});
        return {value:state.collaboration};
      }
      if(input?.operation==='createTask'){
        const {operation,...task}=input;
        return {value:protocolAction(state,'owner','propose',task,{root:this.root,projectID:this.ctx.location.project.id,teamID:state?.teamID},{owner:true})};
      }
      if(input?.decision!==undefined)return {value:reviewPlan(state,input)};
      const ctx={root:this.root,projectID:this.ctx.location.project.id,teamID:state?.teamID};
      if(!input||typeof input!=='object'||Array.isArray(input))throw Error('PROTOCOL_INPUT_INVALID');
      const {markdown,...plan}=input;
      let attachment;
      if(markdown!==undefined){
        if(typeof markdown!=='string'||!markdown.trim()||Buffer.byteLength(markdown)>200000||plan.text!==undefined||plan.fileID!==undefined)throw Error('PLAN_ATTACHMENT_INVALID');
        const digest=createHash('sha256').update(markdown).digest('hex');
        attachment={fileID:`planfile_${digest}`,digest,content:markdown,mediaType:'text/markdown',projectID:state?.projectID,teamID:state?.teamID,canonicalRoot:this.root};
        plan.fileID=attachment.fileID;
      }else attachment=state?.planFiles?.find(f=>f.fileID===plan.fileID);
      const result=ingestPlan(state,plan,ctx,attachment);
      if(markdown!==undefined){state.planFiles??=[];if(!state.planFiles.some(f=>f.fileID===attachment.fileID))state.planFiles.push(attachment);}
      return {value:result};
    });
  }
  async selectModel(input){
    if(!input||Object.keys(input).some(k=>!['operation','requestID','generation','teamID','memberID','sessionID','expectedModel','model','capabilityID'].includes(k))||input.generation!==this.read()?.generation||typeof input.requestID!=='string')throw Error('MODEL_SELECTION_INVALID');
    const state=this.read(),member=state.members.find(m=>m.sessionID===input.sessionID);
    if(state.teamID!==input.teamID||!member||(input.memberID&&memberID(member)!==input.memberID)||state.status!=='ready')throw Error('MODEL_BINDING_MISMATCH');
    const catalog=publicModels(await this.ctx.model.list()),model=input.model;
    if(!model||Object.keys(model).some(k=>!['providerID','id','variant'].includes(k))||!catalog.some(m=>m.providerID===model.providerID&&m.id===model.id&&(model.variant===undefined||m.variants.includes(model.variant))))throw Error('MODEL_UNAVAILABLE');
    const inspect=async()=>{
      const s=await this.ctx.session.get({sessionID:member.sessionID}),active=await (this.ctx.session.active?.()??{});
      if(s.id!==member.sessionID||s.projectID!==state.projectID||s.agent!==member.agent||s.location.directory!==member.directory||s.location.workspaceID!==member.workspaceID)throw Error('MODEL_BINDING_MISMATCH');
      if((active?.data??active)?.[member.sessionID]||this.read().tasks.some(t=>t.assignee===memberID(member)&&t.executionState==='outstanding'))throw Error('MODEL_SESSION_ACTIVE');
      return s;
    };
    const before=await inspect();
    if(!sameModel(before.model,input.expectedModel))throw Error('MODEL_SELECTION_STALE');
    this.mutate(s=>{
      if(s.generation!==input.generation||s.teamID!==input.teamID)throw Error('MODEL_SELECTION_STALE');
      const m=s.members.find(m=>m.sessionID===input.sessionID);
      if(m.modelPreference?.status==='PENDING')throw Error('MODEL_SELECTION_RECONCILIATION_REQUIRED');
      const version=(m.modelVersion??0)+1;
      m.modelPreference={requestID:input.requestID,version,previous:before.model,desired:model,status:'PENDING',composerStatus:'PENDING',executionAuthorized:false,capabilityID:input.capabilityID??null,at:new Date().toISOString()};return {};
    });
    try{
      const fresh=await inspect();
      if(!sameModel(fresh.model,input.expectedModel)||this.read().generation!==input.generation)throw Error('MODEL_SELECTION_STALE');
      // ponytail: native 2.2.5 switchModel serialized with SessionInbox lock; live execution remains BLOCKED.
      await this.ctx.session.switchModel({sessionID:member.sessionID,model});
      const actual=await inspect();
      if(!sameModel(actual.model,{...model,variant:model.variant??'default'}))throw Error('MODEL_READBACK_MISMATCH');
      return this.mutate(s=>{
        const m=s.members.find(m=>m.sessionID===input.sessionID);
        if(s.generation!==input.generation||s.teamID!==input.teamID||m?.modelPreference?.requestID!==input.requestID)throw Error('MODEL_SELECTION_STALE');
        m.modelVersion=m.modelPreference.version;
        m.modelDefault={...actual.model};
        const receipt={id:`model_receipt_${randomUUID()}`,requestID:input.requestID,projectID:s.projectID,teamID:s.teamID,memberID:memberID(m),sessionID:m.sessionID,generation:s.generation,version:m.modelVersion,previous:before.model,selected:actual.model,status:'APPLIED',composerStatus:'PENDING',executionAuthorized:false,capabilityID:input.capabilityID??null,at:new Date().toISOString()};
        m.modelPreference={...m.modelPreference,status:'APPLIED',observed:actual.model,receiptID:receipt.id,at:receipt.at};
        s.modelReceipts??=[];s.modelReceipts.push(receipt);
        return {value:m.modelPreference};
      });
    }catch(error){
      this.mutate(s=>{const m=s.members.find(m=>m.sessionID===input.sessionID);if(m?.modelPreference?.requestID===input.requestID)m.modelPreference={...m.modelPreference,status:'BLOCKED',reason:String(error)};return {};});
      throw error;
    }
  }
  async acknowledgeComposer(input){
    if(!input||typeof input.requestID!=='string'||input.generation!==this.read()?.generation)throw Error('MODEL_COMPOSER_ACK_INVALID');
    const state=this.read(),member=state?.members.find(m=>m.sessionID===input.sessionID);
    if(!state||state.teamID!==input.teamID||!member)throw Error('MODEL_BINDING_MISMATCH');
    const s=await this.ctx.session.get({sessionID:member.sessionID});
    if(!sameModel(s.model,{...input.model,variant:input.model?.variant??'default'}))throw Error('MODEL_COMPOSER_MISMATCH');
    return this.mutate(curr=>{
      const m=curr.members.find(m=>m.sessionID===input.sessionID);
      if(!m?.modelPreference||m.modelPreference.status!=='APPLIED'||!sameModel(m.modelPreference.observed,s.model))throw Error('MODEL_COMPOSER_STALE');
      const at=new Date().toISOString();
      m.modelPreference={...m.modelPreference,composerStatus:'SYNCHRONIZED',composerVerifiedAt:at};
      const receipt=curr.modelReceipts?.find(r=>r.id===m.modelPreference.receiptID);
      if(receipt){receipt.composerStatus='SYNCHRONIZED';receipt.composerVerifiedAt=at;}
      return {value:m.modelPreference};
    });
  }
  async verifyAdmissionPolicy(input){
    const state=this.read(),member=state?.members.find(m=>m.sessionID===input?.sessionID);
    if(!state||state.teamID!==input?.teamID||state.generation!==input?.generation||!member)throw Error('ADMISSION_BINDING_MISMATCH');
    const s=await this.ctx.session.get({sessionID:member.sessionID}),active=await (this.ctx.session.active?.()??{});
    if(s.id!==member.sessionID||s.projectID!==state.projectID||s.location.directory!==member.directory||s.location.workspaceID!==member.workspaceID)throw Error('ADMISSION_SESSION_MISMATCH');
    if((active?.data??active)?.[member.sessionID])throw Error('ADMISSION_SESSION_BUSY');
    if(member.modelPreference?.status==='PENDING'||member.modelPreference?.status==='BLOCKED')throw Error('ADMISSION_MODEL_NOT_APPLIED');
    if(input.expectedVersion!==undefined&&(member.modelVersion??0)!==input.expectedVersion)throw Error('ADMISSION_MODEL_VERSION_MISMATCH');
    if(input.expectedModel&&!sameModel(s.model,input.expectedModel))throw Error('ADMISSION_MODEL_STALE');
    const catalog=publicModels(await this.ctx.model.list());
    if(!catalog.some(m=>m.providerID===s.model?.providerID&&m.id===s.model?.id&&(s.model?.variant==null||m.variants.includes(s.model.variant))))throw Error('ADMISSION_PROVIDER_MODEL_UNAVAILABLE');
    return {admissible:true,executionAuthorized:false,sessionID:member.sessionID,memberID:memberID(member),model:s.model,modelVersion:member.modelVersion??0};
  }
  async testFixtureAction(input){
    const state=this.read(),member=state?.members.find(m=>memberID(m)===input.actor);
    if(!state||!member)throw Error('FIXTURE_MEMBER_REQUIRED');
    const context={sessionID:member.sessionID,agent:member.agent};
    const origDir=this.ctx.location.directory;
    this.ctx.location.directory=member.directory;
    try{
      if(input.kind==='protocol'){
        const res=await this.protocol(input.action,input.payload,context,{
          now:input.now,
          admit:input.allowFixtureStart?({task})=>{task.fixtureProvenance='TEST_FIXTURE';return true;}:undefined,
          stopped:input.allowFixtureStop?()=>true:undefined,
        });
        if(input.allowFixtureStart&&input.action==='start'&&res?.id){
          this.mutate(s=>{
            for(const ex of s.executions??[])if(ex.taskID===res.id)ex.fixtureProvenance='TEST_FIXTURE';
            return {};
          });
        }
        if(input.allowFixtureStop&&input.action==='submit'&&res?.id){
          this.mutate(s=>{
            for(const ex of s.executions??[])if(ex.taskID===res.id){
              ex.observation='verified-stopped';
              ex.state='stop-verified';
              ex.fixtureProvenance='TEST_FIXTURE';
              ex.stopReceipt={executionID:ex.id,receiptID:`fixture_stop_${ex.id}`,identity:ex.identity,fixtureProvenance:'TEST_FIXTURE'};
            }
            return {};
          });
        }
        return res;
      }
      if(input.kind==='execute'){
        const res=await this.execute(input.action,input.payload,context);
        if(input.action==='report'&&res?.id){
          this.mutate(s=>{
            const art=s.artifacts?.find(a=>a.id===res.id);
            if(art)art.fixtureProvenance='TEST_FIXTURE';
            return {};
          });
        }
        return res;
      }
      if(input.kind==='integrate'){
        const res=await integrateReviewedTask(this,input.payload,{
          authorize:async()=>true,
          verifyReview:async req=>{
            const curr=this.read();
            const sub=readReport(this.directory,curr,req.projectID,req.submission);
            const rev=readReport(this.directory,curr,req.projectID,req.reviewReportID);
            return sub.owner!==rev.owner&&sub.sessionID!==rev.sessionID&&rev.content.includes(req.sourceCommit)&&sub.content.includes(req.sourceCommit);
          }
        });
        if(res?.id){
          this.mutate(s=>{
            const row=s.integrations?.find(r=>r.id===res.id);
            if(row)row.fixtureProvenance='TEST_FIXTURE';
            return {};
          });
        }
        return res;
      }
      throw Error('FIXTURE_KIND_INVALID');
    }finally{
      this.ctx.location.directory=origDir;
    }
  }
  async integrateTask(input,member){
    const state=this.read(),task=state.tasks.find(t=>t.id===input.taskID),plan=state.plans?.at(-1);
    // Validate exact protocol binding/CAS before any filesystem effect.
    try{protocolAction(structuredClone(state),memberID(member),'integrate',input,{root:this.root,projectID:state.projectID,teamID:state.teamID},{verifyReport:id=>{readReport(this.directory,state,state.projectID,id);return true;}});}catch(error){if(error.message!=='PROTOCOL_MERGE_NOT_PROVEN')throw error;}
    const authorize=()=>{
      const current=this.read(),p=current.executionPolicy,latest=current.plans?.at(-1);
      verifyHostOwnerPolicy(current,p);
      if(p.revokedAt||!p.capabilityID?.startsWith('worktree-integration-v1:')||p.digest!==plan.digest||p.planID!==plan.planID||p.planVersion!==plan.version||latest?.digest!==plan.digest||latest.version!==plan.version||latest.ownerDecision!=='approve'||latest.needsOwner)throw Error('PEER_INTEGRATION_POLICY_REQUIRED');
      return true;
    };
    authorize();
    const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false','-C',cwd,...args],{env:gitEnv(),encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    const parent=join(dirname(this.root),`.${this.root.split('/').at(-1)}-integrations`);mkdirSync(parent,{recursive:true});
    const prior=state.integrations?.find(r=>r.requestID===input.requestID);
    const source=state.executions?.findLast(e=>e.taskID===task.id&&e.identity.ownershipGeneration===task.ownershipGeneration&&e.identity.workRevision===task.workRevision&&e.stopReceipt?.sourceCommit)?.stopReceipt.sourceCommit;
    const request=prior?.input??{requestID:input.requestID,taskID:task.id,taskVersion:task.taskVersion,ownershipGeneration:task.ownershipGeneration,workRevision:task.workRevision,baseCommit:git(this.root,'rev-parse','HEAD'),sourceCommit:source,directory:join(parent,randomUUID())};
    const receipt=await integrateReviewedTask(this,request,{authorize,verifyReview:async req=>[req.submission,req.reviewReportID].every(id=>readReport(this.directory,this.read(),state.projectID,id).content.includes(req.sourceCommit))});
    if(receipt.state!=='merged')throw Error(`PEER_INTEGRATION_${receipt.state.toUpperCase()}`);
    const commands=await runRequiredChecks(request.directory,task.requiredChecks,[this.directory,this.root]);
    this.mutate(current=>{
      authorize();
      const t=current.tasks.find(t=>t.id===task.id),row=current.integrations.find(r=>r.id===receipt.id);
      if(t.taskVersion!==input.taskVersion||t.reviewer!==memberID(member)||t.status!=='REVIEW')throw Error('PEER_INTEGRATION_STALE_REVIEW');
      if(git(this.root,'status','--porcelain'))throw Error('PEER_INTEGRATION_CANONICAL_DIRTY');
      const head=git(this.root,'rev-parse','HEAD');
      if(head!==receipt.resultCommit){
        if(head!==receipt.baseCommit)throw Error('PEER_INTEGRATION_COMMIT_INVALID');
        git(this.root,'merge','--ff-only',receipt.resultCommit);
      }
      row.canonicalCommit=git(this.root,'rev-parse','HEAD');row.commands=commands;return {};
    });
  }
  async protocol(action,input,context,adapters={}){
    const m=await this.caller(context);
    if(action==='read'&&input&&Object.keys(input).length===0){
      const state=this.read(),plan=state.plans?.at(-1);
      if(!plan)throw Error('PROTOCOL_PLAN_REQUIRED');
      input={requestID:randomUUID(),planID:plan.planID,planVersion:plan.version,projectID:state.projectID,teamID:state.teamID,canonicalRoot:this.root};
    }
    if(action==='integrate'&&!adapters.admit&&this.read().executionPolicy&&!this.read().protocolRequests?.some(r=>r.actor===memberID(m)&&r.requestID===input?.requestID))await this.integrateTask(input,m);
    const result=this.mutate(state=>{
      if(action==='submit'&&state.executions?.some(e=>e.taskID===input.taskID&&e.identity.ownershipGeneration===input.ownershipGeneration&&e.stopReceipt?.outcome==='failed'))throw Error('PEER_WORKTREE_FAILED_ATTEMPT_REQUIRES_RECONCILE');
      if(['integrate','done'].includes(action)&&state.executionPolicy){
        const t=state.tasks.find(t=>t.id===input.taskID);
        if(!state.integrations?.some(r=>r.taskID===t?.id&&r.state==='merged'&&r.canonicalCommit===r.resultCommit&&r.commands?.length&&r.input.ownershipGeneration===t.ownershipGeneration&&r.input.workRevision===t.workRevision&&r.reviewReportID===t.review?.reportID))throw Error('PROTOCOL_CANONICAL_MERGE_NOT_PROVEN');
      }
      const result=protocolAction(state,memberID(m),action,input,{root:this.root,projectID:this.ctx.location.project.id,teamID:state?.teamID},{now:adapters.now,admit:adapters.admit??(({state,task,plan})=>{
        if(!state.executionPolicy)denyLiveAdmission();
        verifyHostOwnerPolicy(state);
        if(state.isolation!=='git-worktree'||!m.branch||m.directory===this.root)throw Error('PEER_WORKTREE_ISOLATION_REQUIRED');
        const p=admission(state,task,m,plan);
        if((state.executions??[]).filter(e=>e.scope==='worktree'&&e.state!=='stop-verified').length>=p.maxActive)throw Error('PEER_NATIVE_CONCURRENCY_LIMIT');
        if((state.executions??[]).filter(e=>e.taskID===task.id&&e.scope==='worktree').length>=p.maxAttemptsPerTask)throw Error('PEER_NATIVE_RETRY_CEILING');
        p.usedCalls++;return true;
      }),stopped:adapters.stopped??(t=>hasVerifiedStop(state,t)),verifyReport:id=>{readReport(this.directory,state,state.projectID,id);return true;}});
      if(action==='start'&&!adapters.admit){const row=state.executions.findLast(e=>e.taskID===result.id&&e.identity.ownershipGeneration===result.ownershipGeneration&&e.identity.workRevision===result.workRevision);if(!row.scope){row.scope='worktree';row.deadline=Date.now()+state.executionPolicy.timeoutMs;}}
      if(['start','renew'].includes(action)&&!adapters.admit){
        const row=state.executions?.findLast(e=>e.taskID===result.id&&e.scope==='worktree'&&e.state==='admitted-by-adapter');
        if(row){const task=state.tasks.find(t=>t.id===result.id);task.lease.expiresAt=Math.max(task.lease.expiresAt,row.deadline);result.lease.expiresAt=task.lease.expiresAt;}
      }
      if(['submit','review','done','reassign_review'].includes(action)){
        const key=`handoff:${result.id}:${result.taskVersion}`;
        if(!state.messages.some(message=>message.requestID===key))state.messages.push({id:randomUUID(),requestID:key,from:memberID(m),to:action==='submit'||action==='reassign_review'?result.reviewer:action==='review'&&result.status==='REWORK'?result.assignee:'team',action:'handoff',text:`Task event ${action}: ${result.id}, status ${result.status}. Read team_protocol before acting; preserve independent review and execution authorization.`,taskID:result.id,at:new Date().toISOString()});
      }
      return {value:result};
    });
    if(action==='read'){
      const state=this.read(),p=state.executionPolicy,plan=state.plans.at(-1);
      let authorized=false;try{verifyHostOwnerPolicy(state,p);authorized=!p.revokedAt&&p.digest===plan.digest&&p.planID===plan.planID&&p.planVersion===plan.version;}catch{}
      result.policy={...result.policy,executionEnabled:authorized,scope:'worktree',executionPolicy:authorized?p:null};
      result.allowedFields=protocolFields;
      result.reportInstructions='team_report commands must preserve exact command, exitCode and output rows returned by team_worktree. A wrapper name such as team_worktree verify does not satisfy requiredChecks. Never invent passing checks; rerun missing checks before reporting.';
      result.executionInstructions='Execution grant permits team_worktree apply only, not native edit/shell. start reserves one bounded attempt. Renew lease before writing; use team_worktree apply with all task files and tests. Required check names browser smoke, browser e2e, mobile 375px, keyboard-only, keyboard-only check, viewport 375px check, README commands verified and browser smoke: CRUD/filter/comment/reload/import/export are supported trusted bwrap-v1 runners, not shell commands. Preserve requiredChecks; do not replace browser checks with node --test. Component contract: renderKanban(container,tasks,onMove), callback (id,status). Successful sandbox tests + local commit verify scoped worker stop; then team_report and submit. Reviewer uses team_worktree verify, separate report, review/integrate/done. Expired CLAIMED task: reconcile then read/claim with fresh versions. Do not create duplicate tasks. maxCalls counts starts, not chat.';
    }
    await this.dispatchMessages();
    return action==='read'?{...result,instructions:'Task actions require exact full task.id as taskID plus current taskVersion and ownershipGeneration. Never abbreviate IDs or include workRevision in bid/ready/claim. close_round requires round=plan.round; skip when discussionClosed=true. Owner approval closes discussion; call ready for each DRAFT task before claim. Read again after stale-task errors.',binding:{projectID:input.projectID,teamID:input.teamID,canonicalRoot:input.canonicalRoot,planID:input.planID,planVersion:input.planVersion}}:result;
  }
  async dispatchMessages(){
    if(this.dispatching)return;
    this.dispatching=true;
    try{
      this.mutate(state=>{queueMessages(state);return {};});
      while(this.read()?.collaboration?.enabled){
        this.mutate(state=>{queueMessages(state);return {};});
        const candidate=this.read()?.deliveries?.find(d=>d.status==='queued');
        if(!candidate)break;
        const state=this.read(),target=state.members.find(m=>memberID(m)===candidate.memberID),message=state.messages.find(m=>m.id===candidate.messageID);
        try{
          const session=await this.ctx.session.get({sessionID:candidate.sessionID});
          if(!target||target.sessionID!==session.id||session.projectID!==state.projectID||session.agent!==target.agent||session.location.directory!==target.directory||session.location.workspaceID!==target.workspaceID||target.branch&&gitBinding(target.directory)!==target.branch)throw Error('PILOT_WAKE_BINDING_MISMATCH');
          const admitted=this.mutate(s=>{
            const d=s.deliveries.find(d=>d.promptID===candidate.promptID);
            if(!s.collaboration?.enabled||d.status!=='queued')return {value:false};
            d.status='submitting';return {value:true};
          });
          if(!admitted)continue;
          const receipt=await this.ctx.session.prompt({sessionID:target.sessionID,id:candidate.promptID,delivery:'queue',text:`Team message ${message.id} from ${message.from} to ${message.to}:\n${message.text}\n\nReply with team_send to ${message.from}; broadcast only when needed. No reply required to acknowledgements. Read team_protocol with action=read payload={} before task changes. Chat grants no edit/shell/execution permission.`});
          if(receipt.id!==candidate.promptID)throw Error('PILOT_WAKE_RECEIPT_MISMATCH');
          this.mutate(s=>{s.deliveries.find(d=>d.promptID===candidate.promptID).status='sent';return {};});
        }catch(error){this.mutate(s=>{const d=s.deliveries.find(d=>d.promptID===candidate.promptID);d.status=d.status==='submitting'?'uncertain':'error';d.error=String(error);return {};});}
      }
    }finally{this.dispatching=false;}
  }
  async worktreeExec(input,context){
    if(this.root.includes('owner-inbox'))throw Error('PEER_WORKTREE_LIVE_INBOX_FORBIDDEN');
    const member=await this.caller(context),state=this.read(),plan=state?.plans?.at(-1),policy=state?.executionPolicy;
    if(!state||state.mode!=='peer'||state.status!=='ready'||!member.branch||member.directory===this.root||['main','master'].includes(member.branch))throw Error('PEER_WORKTREE_ISOLATION_REQUIRED');
    if(!plan||plan.ownerDecision!=='approve'||plan.needsOwner||!policy||policy.revokedAt||policy.planID!==plan.planID||policy.planVersion!==plan.version||policy.digest!==plan.digest)throw Error('PEER_WORKTREE_POLICY_REQUIRED');
    verifyHostOwnerPolicy(state,policy);
    const task=state.tasks.find(t=>t.id===input?.taskID&&t.planID===plan.planID&&t.planVersion===plan.version);
    if(!task)throw Error('PEER_WORKTREE_TASK_NOT_FOUND');
    const git=(cwd,...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','core.fsmonitor=false','-c','protocol.file.allow=never','-c',`user.name=${memberID(member)}`,'-c',`user.email=${memberID(member)}@localhost`,'-C',cwd,...args],{env:gitEnv(),encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    const runChecks=cwd=>runRequiredChecks(cwd,task.requiredChecks,[this.directory,this.root]);
    if(input?.mode==='apply'){
      if(task.assignee!==memberID(member)||task.status!=='RUNNING'||task.executionState!=='outstanding'||!task.lease||task.lease.expiresAt<=Date.now())throw Error('PEER_WORKTREE_TASK_NOT_RUNNING');
      const execution=state.executions?.findLast(e=>e.taskID===task.id&&e.scope==='worktree'&&e.state==='admitted-by-adapter');
      if(!execution||execution.deadline<=Date.now()||execution.identity.ownershipGeneration!==task.ownershipGeneration||execution.identity.workRevision!==task.workRevision)throw Error('PEER_WORKTREE_EXECUTION_REQUIRED');
      if(!Array.isArray(input.files)||!input.files.length)throw Error('PEER_WORKTREE_FILES_REQUIRED');
      const written=[],validated=[];
      for(const f of input.files){
        if(!f||typeof f.path!=='string'||typeof f.content!=='string'||!task.files.some(tf=>f.path===tf||f.path.startsWith(tf+'/')))throw Error('PEER_WORKTREE_FILE_OUT_OF_SCOPE');
        const abs=await assertScopedPath(member.directory,f.path);
        validated.push({f,abs});
      }
      try{
      // ponytail: clean fast-forward base only; divergent worktree needs explicit rework, never reset.
      if(task.dependencies.length&&git(member.directory,'rev-parse','HEAD')!==git(this.root,'rev-parse','HEAD')){
        if(git(member.directory,'status','--porcelain'))throw Error('PEER_WORKTREE_DIRTY');
        git(member.directory,'merge','--ff-only',git(this.root,'rev-parse','HEAD'));
        for(const {f,abs} of validated)if(await assertScopedPath(member.directory,f.path)!==abs)throw Error('PEER_WORKTREE_FILE_OUT_OF_SCOPE');
      }
      for(const {f,abs} of validated){
        mkdirSync(dirname(abs),{recursive:true});writeFileSync(abs,f.content,'utf8');written.push(f.path);
      }
      const commands=await runChecks(member.directory);
      git(member.directory,'add','--',...written);
      if(git(member.directory,'status','--porcelain'))git(member.directory,'commit','-m',`Task ${task.id} (${memberID(member)})`);
      const baseCommit=git(this.root,'rev-parse','HEAD'),sourceCommit=git(member.directory,'rev-parse','HEAD');
      const diff=git(member.directory,'show','--stat','--patch',sourceCommit);
      this.mutate(s=>{
        const row=s.executions.find(e=>e.id===execution.id),current=s.tasks.find(t=>t.id===task.id);
        if(!row||row.state!=='admitted-by-adapter'||current.taskVersion!==task.taskVersion||s.executionPolicy?.revokedAt||row.deadline<=Date.now())throw Error('PEER_EXECUTION_STALE');
        // Scoped worker stopped: node test child exited and local commit completed. Native session is NOT claimed stopped.
        row.state='stop-verified';row.stopReceipt={executionID:row.id,identity:structuredClone(row.identity),receiptID:`worktree:${row.id}:${sourceCommit}`,scope:'worktree',sourceCommit,sandbox:'bwrap-v1',at:Date.now()};
        current.executionState='stopped';return {};
      });
      return {ok:true,mode:'apply',sandbox:'bwrap-v1',branch:member.branch,baseCommit,sourceCommit,files:written,commands,diff};
      }catch(error){
        // All scoped children are synchronous and exited before this catch. Failure proves scoped stop, not success.
        this.mutate(s=>{
          const row=s.executions?.find(e=>e.id===execution.id),current=s.tasks.find(t=>t.id===task.id);
          if(row?.state==='admitted-by-adapter'&&current?.ownershipGeneration===execution.identity.ownershipGeneration&&current.workRevision===execution.identity.workRevision){
            row.state='stop-verified';row.stopReceipt={executionID:row.id,identity:structuredClone(row.identity),receiptID:`worktree-failed:${row.id}`,scope:'worktree',outcome:'failed',sandbox:'bwrap-v1',at:Date.now()};
            current.executionState='stopped';
          }
          return {};
        });
        throw error;
      }
    }
    if(input?.mode==='verify'){
      if(task.reviewer!==memberID(member)||task.assignee===memberID(member)||!['SUBMITTED','REVIEW'].includes(task.status))throw Error('PEER_WORKTREE_REVIEWER_REQUIRED');
      const primary=state.members.find(m=>memberID(m)===task.assignee);
      if(!primary?.branch||git(primary.directory,'status','--porcelain')||git(primary.directory,'rev-parse','HEAD')!==input.sourceCommit)throw Error('PEER_WORKTREE_COMMIT_MISMATCH');
      const commands=await runChecks(primary.directory);
      const baseCommit=git(this.root,'rev-parse','HEAD'),diff=git(primary.directory,'show','--stat','--patch',input.sourceCommit);
      return {ok:true,mode:'verify',sandbox:'bwrap-v1',sourceCommit:input.sourceCommit,baseCommit,commands,diff};
    }
    throw Error('PEER_WORKTREE_MODE_INVALID');
  }
  async execute(action,input,context){
    const member=await this.caller(context),peer=this.read()?.mode==='peer';
    if(peer&&action==='receipt')return this.mutate(state=>{
      if(state.status!=='ready'||!state.members.some(m=>m.sessionID===member.sessionID&&memberID(m)===memberID(member)))throw Error('PILOT_NOT_READY');
      return {value:acknowledge(state,member,input)};
    });
    if(!['send','inbox','status','ack','assign','report',...(peer?['claim','review']:[])].includes(action))throw Error('PILOT_ACTION_INVALID');
    if(peer&&['ack','claim','review'].includes(action)&&this.read().tasks.some(t=>t.id===input?.taskID&&t.protocolVersion))throw Error('PROTOCOL_VERSIONED_ACTION_REQUIRED');
    if(peer&&action==='assign'&&this.read().plans?.length)throw Error('PROTOCOL_VERSIONED_ACTION_REQUIRED');
    if(action==='report'){
      if(!input||Object.keys(input).some(k=>!['taskID','text','files','commands','diff','remaining','status'].includes(k)))throw Error('INVALID_PILOT_INPUT');
      return this.mutate(state=>{
        if(state.status!=='ready'||state.projectID!==this.ctx.location.project.id||!state.members.some(m=>m.sessionID===member.sessionID&&m.role===member.role&&m.directory===member.directory))throw Error('PILOT_NOT_READY');
        const report=reportBody(input,state,member);
        state.artifacts??=[];
        if(state.artifacts.some(a=>a.id===report.id))return {value:state.artifacts.find(a=>a.id===report.id)};
        writeReport(this.directory,report);
        const {content,...metadata}=report;metadata.at=new Date().toISOString();
        state.artifacts.push(metadata);
         state.messages.push({id:report.id,from:memberID(member),to:peer?'team':member.role==='admin'?'owner':'admin',text:`Báo cáo: ${report.name}`,taskID:report.taskID,artifactID:report.id,action:'report',at:metadata.at});
        return {value:metadata};
      });
    }
    if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['recipient','text','requestID','taskID','status'].includes(k)))throw Error('INVALID_PILOT_INPUT');
    if(action==='inbox'||action==='status'){
      const state=this.read();return action==='status'?state:{messages:peer?inbox(state,member):state.messages.filter(m=>m.to===memberID(member)),tasks:state.tasks.filter(t=>t.assignee===memberID(member)||peer&&t.assignee==='unclaimed')};
    }
    return this.mutate(state=>{
      if(state.status!=='ready'||!state.members.some(m=>m.sessionID===member.sessionID&&m.directory===member.directory))throw Error('PILOT_NOT_READY');
      if(peer&&action==='claim'){
        const task=state.tasks.find(t=>t.id===input.taskID);
        if(!task||!['unclaimed',memberID(member)].includes(task.assignee))throw Error('PEER_TASK_ALREADY_CLAIMED');
        task.assignee=memberID(member);task.status='accepted';return {value:task};
      }
      if(action==='ack'){
        const task=state.tasks.find(t=>t.id===input.taskID&&t.assignee===member.role);
        if(!task||!['accepted','working','blocked','done'].includes(input.status))throw Error('PILOT_TASK_INVALID');
        if(input.status==='done'&&!state.artifacts?.some(a=>a.taskID===task.id&&a.sessionID===member.sessionID&&a.status==='completed'))throw Error('PILOT_REPORT_REQUIRED');
        if(input.status==='done')readReport(this.directory,state,state.projectID,state.artifacts.find(a=>a.taskID===task.id&&a.sessionID===member.sessionID&&a.status==='completed').id);
        task.status=input.status;return {value:task};
      }
      if(typeof input.text!=='string'||!input.text.trim())throw Error('PILOT_TEXT_REQUIRED');
      if(input.text.length>10000)throw Error('PILOT_TEXT_TOO_LONG');
      const requestID=(typeof input.requestID==='string'&&input.requestID.trim())?input.requestID.trim():randomUUID();
      if(requestID.length>160)throw Error('PILOT_REQUEST_ID_TOO_LONG');

      if(action==='assign'){
        if(!peer&&(member.role!=='admin'||input.recipient==='admin'||input.recipient==='owner'))throw Error('PILOT_ADMIN_REQUIRED');
      }
      const allowedRecipients=peer?['team','owner',...state.members.map(memberID)]:member.role==='admin'
        ?[...state.members.filter(m=>m.role!=='admin').map(m=>m.role),'owner']
        :['admin'];
      if(!allowedRecipients.includes(input.recipient))throw Error('PILOT_RECIPIENT_INVALID');
      if(input.taskID&&!state.tasks.some(t=>t.id===input.taskID&&(peer||t.assignee===member.role||member.role==='admin')))throw Error('PILOT_TASK_INVALID');
      const old=state.messages.find(m=>m.from===member.role&&m.requestID===requestID);
      if(old){if(old.to!==input.recipient||old.text!==input.text||old.action!==action||(action!=='assign'&&old.taskID!==input.taskID))throw Error('PILOT_IDEMPOTENCY_CONFLICT');return {value:old};}
      const message={id:randomUUID(),requestID,from:member.role,to:input.recipient,text:input.text,action,at:new Date().toISOString()};
      if(input.taskID)message.taskID=input.taskID;
      state.messages.push(message);
       if(action==='assign'){if(input.recipient==='owner')throw Error('PILOT_RECIPIENT_INVALID');message.taskID=message.id;state.tasks.push({id:message.id,assignee:input.recipient==='team'?'unclaimed':input.recipient,text:input.text,status:'todo',...(peer?{revision:1,proposedBy:memberID(member)}:{})});}
       if(peer&&action==='review'){
         const task=state.tasks.find(t=>t.id===input.taskID);
         if(!task||task.assignee===memberID(member))throw Error('PEER_INDEPENDENT_REVIEW_REQUIRED');
         task.reviews??=[];task.reviews.push({id:message.id,sessionID:member.sessionID,memberID:memberID(member),revision:task.revision??1,text:input.text});
       }
      return {value:message};
    });
  }
}

export async function registerOfficialCoordinator(ctx){
  // Check before constructor: constructor creates store directories.
  if(!approvedProject(ctx))return {read:()=>null,bootstrap:async()=>null,ownerSend:async()=>{throw Error('PILOT_PROJECT_NOT_APPROVED');}};
  const coordinator=new OfficialCoordinator(ctx);
  const payloadProperties=Object.fromEntries([...new Set(Object.values(protocolFields).flat())].map(key=>[key,
    ['planVersion','taskVersion','ownershipGeneration','round'].includes(key)?{type:'integer'}:
    key==='approved'?{type:'boolean'}:
    ['dependencies','files','requiredCapabilities','acceptanceCriteria','requiredChecks'].includes(key)?{type:'array',items:{type:'string'}}:{type:'string'}]));
  const retryBusy=async fn=>{for(let i=0;;i++)try{return await fn();}catch(e){if(e?.message!=='PILOT_STORE_BUSY_OR_RECOVERY_REQUIRED'||i>=30)throw e;await new Promise(r=>setTimeout(r,5));}};
  // Provisioning only through trusted Owner RPC; registration never creates native resources.
  await ctx.tool.transform(editor=>{
    editor.add({name:'protocol',description:'First call action="read", payload={} for current plan, policy and task graph. Never use read_policy/get_plan/policy. Mutations require unique requestID plus planID, planVersion, projectID, teamID, canonicalRoot from read.binding. propose requires text, dependencies (task IDs), files, requiredCapabilities, acceptanceCriteria, requiredChecks. Create DAG tasks with propose, NOT team_assign. Never grants native execution. Uses native caller identity.',options:{namespace:'team',codemode:false},
      input:{type:'object',properties:{action:{type:'string',enum:['read','discuss','close_round','propose','bid','ready','claim','renew','release','start','submit','review','integrate','done','reassign_review','cancel','block','fail','reconcile']},payload:{type:'object',properties:payloadProperties,additionalProperties:false}},required:['action','payload'],additionalProperties:false},
      execute:async(input,context)=>({content:JSON.stringify(await retryBusy(()=>coordinator.protocol(input.action,input.payload,context)))})});
    editor.add({name:'worktree',description:'Scoped worktree file apply/test/commit for RUNNING assignee or verify for SUBMITTED independent reviewer.',options:{namespace:'team',codemode:false},
      input:{type:'object',properties:{mode:{type:'string',enum:['apply','verify']},taskID:{type:'string'},files:{type:'array',items:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content'],additionalProperties:false}},sourceCommit:{type:'string'}},required:['mode','taskID'],additionalProperties:false},
      execute:async(input,context)=>({content:JSON.stringify(await retryBusy(()=>coordinator.worktreeExec(input,context)))})});
    // Peer sessions start collaboration-only, even when inherited native tools are available.
    for(const tool of editor.list?.()??[]){
      const tname=String(tool.name??tool.id??'');
      if(tname==='protocol'||tname==='worktree'||tname.startsWith('team_'))continue;
      const execute=tool.execute;
      editor.update(tool.id,t=>{t.execute=async(input,context)=>{
        const state=coordinator.read(),member=state?.mode==='peer'?state.members.find(m=>m.sessionID===context.sessionID):null;
        if(member){
          if(/^(read|glob|grep|list)$/i.test(tname)){
            const raw=input?.path??input?.directory;
            if(typeof raw==='string'&&raw){
              const rel=raw.startsWith(member.directory+'/')?raw.slice(member.directory.length+1):raw===member.directory?'':raw;
              if(rel)await assertScopedPath(member.directory,rel).catch(()=>{throw Error('PEER_SCOPE_PATH_DENIED');});
            }
          }else throw Error('PEER_CODE_EXECUTION_DISABLED');
        }
        return execute(input,context);
      }});
    }
    editor.add({name:'report',description:'Create real Markdown task report in managed storage and share attachment. Agent-provided evidence only; does not complete task or wake models.',options:{namespace:'team',codemode:false},
      input:{type:'object',properties:{taskID:{type:'string'},text:{type:'string',maxLength:200000},files:{type:'array',items:{type:'string'}},commands:{type:'array',items:{type:'object',properties:{command:{type:'string'},exitCode:{type:'integer'},output:{type:'string'}},required:['command','exitCode','output'],additionalProperties:false}},diff:{type:'string'},remaining:{type:'string'},status:{type:'string',enum:['completed','blocked']}},required:['taskID','text','files','commands','diff','remaining','status'],additionalProperties:false},
      execute:async(input,context)=>({content:JSON.stringify(await retryBusy(()=>coordinator.execute('report',input,context)))})});
    editor.add({name:'read_report',description:'Read team Markdown report by artifact ID. Does not read arbitrary paths.',options:{namespace:'team',codemode:false},input:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},execute:async(input,context)=>{await coordinator.caller(context);return {content:JSON.stringify(readReport(coordinator.directory,coordinator.read(),ctx.location.project.id,input.id))};}});
    editor.add({name:'receipt',description:'Acknowledge a durable inbox message as this native peer. Not provider admission or execution.',options:{namespace:'team',codemode:false},input:{type:'object',properties:{messageID:{type:'string'},requestID:{type:'string'}},required:['messageID','requestID'],additionalProperties:false},execute:async(input,context)=>({content:JSON.stringify(await retryBusy(()=>coordinator.execute('receipt',input,context)))})});
    for(const action of ['send','inbox','ack','status','assign','claim','review'])editor.add({
      name:action,description:`Pilot team ${action}. send delivers to recipient and @peer mentions when Owner enabled collaboration; team broadcasts to other members. Reply to sender by default; avoid acknowledgement loops. Chat never grants code execution.`,options:{namespace:'team',codemode:false},
      input:{type:'object',properties:{recipient:{type:'string'},text:{type:'string',maxLength:10000},requestID:{type:'string',maxLength:160},taskID:{type:'string'},status:{type:'string'}},additionalProperties:false},
       execute:async(input,context)=>{const result=await retryBusy(()=>coordinator.execute(action,input,context));if(action==='send')await coordinator.dispatchMessages();return {content:JSON.stringify(ctx.options?.pilotWake===true&&action==='assign'?await coordinator.wake(result):result)};},
    });
  });
  // Resume only persisted queued rows; submitting/uncertain rows never replay automatically.
  if(coordinator.read()?.collaboration?.enabled)await coordinator.dispatchMessages();
  return coordinator;
}
