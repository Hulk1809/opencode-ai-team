import {randomUUID} from 'node:crypto';
import {buildArgs} from './build.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,open,readFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
const run=promisify(execFile);

export function dockerAdapter(execute=run){
  const call=async(args,timeout=15000)=>{
    try{return (await execute('/usr/bin/docker',args,{timeout,maxBuffer:4*1024*1024})).stdout.trim();}
    catch(error){if(error.killed)error.code='TIMEOUT';throw error;}
  };
  return {
    create:({name,labels,args})=>call(['create','--name',name,...Object.entries(labels).flatMap(([k,v])=>['--label',`${k}=${v}`]),...args]),
    start:id=>call(['start',id]),
    wait:async(id,timeout)=>({exitCode:Number(await call(['wait',id],timeout))}),
    logs:async id=>{const result=await execute('/usr/bin/docker',['logs',id],{timeout:15000,maxBuffer:4*1024*1024});return `${result.stdout??''}${result.stderr??''}`;},
    inspect:async id=>{const [info]=JSON.parse(await call(['inspect',id]));return {labels:info.Config.Labels,running:info.State.Running,exitCode:info.State.ExitCode};},
    stop:(id,seconds)=>call(['stop','--time',String(seconds),id]),
    remove:id=>call(['rm',id]),
  };
}

// Single global writer, including execution. Stale lock deliberately blocks after crash;
// never steal it or replay an uncertain job without container reconciliation.
export async function withBuildJobs(directory,callback,docker=dockerAdapter()){
  await mkdir(directory,{recursive:true,mode:0o700});
  const lockPath=join(directory,'writer.lock');
  const lock=await open(lockPath,'wx',0o600);
  try{
    await lock.writeFile(JSON.stringify({pid:process.pid,at:new Date().toISOString()}));await lock.sync();
    const path=join(directory,'jobs.json');
    const load=async()=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return {jobs:[]};throw error;}};
    const save=async state=>{
      const tmp=join(directory,`jobs-${randomUUID()}.tmp`),file=await open(tmp,'wx',0o600);
      try{await file.writeFile(JSON.stringify(state));await file.sync();}finally{await file.close();}
      await rename(tmp,path);
      const parent=await open(directory,'r');try{await parent.sync();}finally{await parent.close();}
    };
    return await callback(new BuildJobs({load,save,docker,maxJobs:1}));
  }finally{await lock.close();await unlink(lockPath);}
}

// Docker adapter is injected; no public tool accepts Docker argv/container IDs.
export class BuildJobs {
  constructor({load,save,docker,maxJobs=2}){this.load=load;this.save=save;this.docker=docker;this.maxJobs=maxJobs;this.busy=false;this.tail=Promise.resolve();}
  serial(fn){const result=this.tail.then(fn);this.tail=result.catch(()=>{});return result;}
  enqueue(scope,taskID,goal,metadata={}){return this.serial(()=>this.admit(scope,taskID,goal,metadata));}
  async admit(scope,taskID,goal,metadata){
    if(this.busy)throw Error('Job admission busy');
    this.busy=true;
    try{
      const state=await this.load();
      if(scope.revokedAt||state.revokedScopes?.includes(scope.id))throw Error('Build scope revoked');
      buildArgs(scope,goal);
      if(state.jobs.some(j=>j.taskID===taskID&&['queued','running','uncertain'].includes(j.state)))throw Error('Task already has active/uncertain job; no replay');
      if(state.jobs.filter(j=>['queued','running','uncertain'].includes(j.state)).length>=this.maxJobs)throw Error('Build concurrency limit');
       const job={...metadata,id:randomUUID(),scopeID:scope.id,taskID,goal,state:'queued',queuedAt:new Date().toISOString()};
      state.jobs.push(job);await this.save(state);return job;
    }finally{this.busy=false;}
  }
  revoke(scopeID){return this.serial(()=>this.stopScope(scopeID));}
  async stopScope(scopeID){
    const state=await this.load();state.revokedScopes=[...new Set([...(state.revokedScopes??[]),scopeID])];
    for(const job of state.jobs)if(job.scopeID===scopeID&&['queued','running','uncertain','timeout'].includes(job.state)){job.revokedAt=new Date().toISOString();if(job.state==='queued')job.state='revoked';}
    await this.save(state);
    for(const job of state.jobs.filter(j=>j.scopeID===scopeID&&j.revokedAt&&!j.cleanedAt&&j.state!=='revoked')){
      try{await this.reconcileJob(job.id,true);}catch(error){const latest=await this.load();const row=latest.jobs.find(j=>j.id===job.id);row.state='uncertain';row.error=String(error.message);await this.save(latest);throw error;}
    }
  }
  recover(){return this.serial(()=>this.recoverJobs());}
  async recoverJobs(){
    const state=await this.load();
    for(const job of state.jobs)if(['running','timeout'].includes(job.state)&&!job.cleanedAt)job.state='uncertain';
    await this.save(state);
    for(const job of state.jobs.filter(j=>j.state==='uncertain'&&!j.cleanedAt))await this.reconcileJob(job.id,true);
    return this.load();
  }
  async start(jobID,scope){
    const job=await this.serial(async()=>{
    const state=await this.load(),job=state.jobs.find(j=>j.id===jobID);
    if(!job||job.state!=='queued'||job.scopeID!==scope.id||scope.revokedAt||state.revokedScopes?.includes(scope.id))throw Error('Job not admissible');
    if(state.jobs.some(j=>j.id!==job.id&&['running','uncertain'].includes(j.state)&&!j.cleanedAt))throw Error('Unreconciled job blocks start');
    // Persist running before create: crash here stays uncertain, never auto-replay.
    job.state='running';job.startedAt=new Date().toISOString();await this.save(state);
    try{
      const name=job.containerName=`ai-team-build-${job.id}`;
      await this.save(state);
      scope.authorize?.();
      job.containerID=await this.docker.create({name,labels:{'ai-team.job':job.id,'ai-team.scope':scope.id},args:buildArgs(scope,job.goal).slice(3)});
      await this.save(state);
      scope.authorize?.();
      await this.docker.start(job.containerID);
    }catch(error){job.state='uncertain';job.error=String(error.message);await this.save(state);throw error;}
    return structuredClone(job);
    });
    try{
      const result=await this.docker.wait(job.containerID,300000);
      if(this.docker.logs)job.output=await this.docker.logs(job.containerID);
      job.exitCode=result.exitCode;job.state=result.exitCode===0?'succeeded':'failed';
    }catch(error){job.state=error.code==='TIMEOUT'?'timeout':'uncertain';job.error=String(error.message);}
    // A separately serialized control path may revoke while Docker wait is pending.
    return this.serial(async()=>{
    const latest=await this.load();
    if(latest.revokedScopes?.includes(scope.id)){
      Object.assign(job,latest.jobs.find(j=>j.id===jobID));
    }
    latest.jobs=latest.jobs.map(j=>j.id===jobID?job:j);
    await this.save(latest);
    if(job.state==='timeout'){
      try{await this.reconcileJob(job.id,true);}catch(error){job.state='uncertain';job.error=String(error.message);await this.save(latest);}
    }
    if(['succeeded','failed'].includes(job.state)){
      try{await this.reconcileJob(job.id);}catch(error){job.state='uncertain';job.error=String(error.message);await this.save(latest);}
    }
    return (await this.load()).jobs.find(j=>j.id===jobID);
    });
  }
  reconcile(jobID,stop=false){return this.serial(()=>this.reconcileJob(jobID,stop));}
  async reconcileJob(jobID,stop=false){
    const state=await this.load(),job=state.jobs.find(j=>j.id===jobID);
    if(!job)throw Error('Missing job');
    if(job.cleanedAt)return job;
    if(!job.containerID&&job.containerName)job.containerID=job.containerName;
    if(!job.containerID)throw Error('Missing container identity; preserve uncertain job');
    const info=await this.docker.inspect(job.containerID);
    if(info.labels?.['ai-team.job']!==job.id||info.labels?.['ai-team.scope']!==job.scopeID)throw Error('Container ownership mismatch; no stop/remove');
    if(info.running&&stop){await this.docker.stop(job.containerID,5);const after=await this.docker.inspect(job.containerID);if(after.labels?.['ai-team.job']!==job.id||after.labels?.['ai-team.scope']!==job.scopeID)throw Error('Container ownership changed; no remove');if(after.running){job.state='uncertain';await this.save(state);throw Error('Container stop unverified');}}
    else if(info.running){job.state='uncertain';await this.save(state);throw Error('Container still running');}
    job.stoppedAt=new Date().toISOString();
    if(job.revokedAt)job.state='revoked';
    else if(['running','uncertain'].includes(job.state))job.state='interrupted';
    // Remove only after ownership and stopped state verified.
    await this.docker.remove(job.containerID);job.cleanedAt=new Date().toISOString();
    await this.save(state);return job;
  }
}
