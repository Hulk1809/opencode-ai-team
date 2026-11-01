import {digest} from './broker.mjs';
import {verifySnapshot} from './build-snapshot.mjs';
import {BUILD_IMAGE} from './build.mjs';
import {mkdtemp,mkdir,writeFile,readFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
// No public Docker argv or input host paths. Transport must authenticate caller separately.
export async function executeFixed({ledger,jobs,manifestBytes,projectID,scopeID,epoch,sessionID,taskID,goal,snapshot,cache,uid,gid,buildID,runRoot,artifacts:artifactStore}){
  const approval=()=>ledger.authorize(projectID,scopeID,digest(manifestBytes),epoch);
  approval();const manifest=JSON.parse(manifestBytes.toString());
  const member=manifest.members?.find(m=>m.sessionID===sessionID);
  const task=manifest.tasks?.find(t=>t.taskID===taskID);
  if(manifest.tasks&&(!task||task.snapshotHash!==snapshot.hash||typeof task.revision!=='string'||!Number.isSafeInteger(task.acceptanceEpoch)||task.acceptanceEpoch<0))throw Error('Authoritative task snapshot mismatch');
  if(manifest.projectID!==projectID||manifest.scopeID!==scopeID||manifest.image!==BUILD_IMAGE||!member||!['test','verify'].includes(goal)||!member.goals?.includes(goal)||typeof taskID!=='string'||!taskID)throw Error('Fixed operation denied');
  if(buildID&&member.role!=='qa')throw Error('Independent rerun requires QA');
  const state=await jobs.load();
  if(buildID){const build=state.jobs.find(j=>j.id===buildID);if(!build||build.state!=='succeeded'||!build.cleanedAt||build.taskID!==taskID||build.snapshotHash!==snapshot.hash||build.projectID!==projectID||build.scopeID!==digest(JSON.stringify([projectID,scopeID]))||build.manifestHash!==digest(manifestBytes)||build.epoch!==epoch||build.goal!==goal||build.sessionID===sessionID||build.buildID)throw Error('Independent build/revision mismatch');}
  await verifySnapshot(snapshot);
  if(!Array.isArray(manifest.inputs)||!Array.isArray(member.files)||snapshot.inventory.some(f=>!member.files.includes(f.path)&&!manifest.inputs.some(i=>i.path===f.path&&i.sha256===f.sha256))||manifest.inputs.some(i=>!snapshot.inventory.some(f=>f.path===i.path&&f.sha256===i.sha256)))throw Error('Unapproved build inputs');
  const directory=await mkdtemp(join(runRoot,'run-'));
  for(const f of snapshot.inventory){const bytes=await readFile(join(snapshot.directory,f.path));if(digest(bytes)!==f.sha256)throw Error('Snapshot changed during copy');await mkdir(join(directory,f.path,'..'),{recursive:true});await writeFile(join(directory,f.path),bytes,{flag:'wx',mode:0o600});}
  // Cache/snapshot paths originate only from protected broker stores, never request JSON.
  const scope={id:digest(JSON.stringify([projectID,scopeID])),image:BUILD_IMAGE,directory,cache,uid,gid,goals:member.goals,authorize:approval};
  const job=await jobs.enqueue(scope,taskID,goal,{projectID,sessionID,snapshotHash:snapshot.hash,manifestHash:digest(manifestBytes),epoch,buildID:buildID??null});
  approval();const result=await jobs.start(job.id,scope);await verifySnapshot(snapshot);approval();
  for(const f of snapshot.inventory)if(digest(await readFile(join(directory,f.path)))!==f.sha256)throw Error('Build changed source inputs');
  const artifacts=[];let total=0;
  async function inventory(path,prefix='target'){
    let entries;try{entries=await readdir(path,{withFileTypes:true});}catch(error){if(error.code==='ENOENT'&&prefix==='target')return;throw error;}
    for(const entry of entries){
      const file=join(path,entry.name),name=`${prefix}/${entry.name}`;
      if(entry.isDirectory())await inventory(file,name);
      else{
        if(!entry.isFile()||artifacts.length>=5000)throw Error('Invalid build artifact');
        const stat=await lstat(file);if(!stat.isFile()||(total+=stat.size)>32*1024*1024)throw Error('Invalid build artifact size');
        const bytes=await readFile(file),sha256=digest(bytes);
        if(artifactStore)await artifactStore.put(bytes);
        artifacts.push({path:name,sha256});
      }
    }
  }
  await inventory(join(directory,'target'));artifacts.sort((a,b)=>a.path.localeCompare(b.path));
  return {...result,snapshotHash:snapshot.hash,projectID,sessionID,role:member.role,artifacts,outputHash:digest(result.output??'')};
}
