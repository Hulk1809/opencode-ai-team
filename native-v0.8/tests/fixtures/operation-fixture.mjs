import {generateKeyPairSync,sign} from 'node:crypto';
import {brokerControl} from '../../src/broker-control.mjs';
import {brokerStore} from '../../src/broker-store.mjs';
import {digest} from '../../src/broker.mjs';

export const h='a'.repeat(64),outputHash='b'.repeat(64);
export async function fixture(directory,{saveHook=async()=>{},beforeSave=async()=>{},recover=true}={}){
  const keys=generateKeyPairSync('ed25519'),store=brokerStore(directory),calls=[];
  const peer=role=>({kind:role==='admin'?'admin':'agent',role,sessionID:role,projectID:'synthetic'});
  const snapshot={projectID:'synthetic',taskID:'task',revision:'r1',snapshotHash:h,repository:'example/synthetic',repositoryID:'123',branch:'ai-team/task',baseCommit:'c'.repeat(40),changedPaths:['src/Main.java'],authorSessionID:'backend'};
  const policy={version:1,projectID:'synthetic',scopeID:'scope',members:['admin','backend','devops','qa'].map(role=>({principalID:role,role})),repositories:['example/synthetic'],branches:['ai-team/*'],sourcePaths:['src'],permissions:['edit','test','commit','push','createPR','dockerBuild','deploy'],sensitivePaths:[],docker:{images:['example/build@sha256:'+h],targets:['runner'],environments:['staging']},limits:{timeoutMs:5000,cpuMillis:1000,memoryMiB:256,concurrency:2}};
  const manifest={version:2,projectID:'synthetic',scopeID:'scope',members:policy.members.map(m=>({sessionID:m.principalID,role:m.role})),tasks:[{taskID:'task',revision:'r1',snapshotHash:h,acceptanceEpoch:0}],executionPolicy:policy};
  const evidence=new WeakMap();
  const proof=(row,stage,extra={})=>{const value={operationID:row.operationID,attemptID:row.attemptID,outputHash,cleaned:true,...extra};evidence.set(value,stage);return value;};
  const adapter={preflight:async row=>proof(row,'preflight'),execute:async row=>{calls.push(row.attemptID);return proof(row,'terminal');},stop:async row=>proof(row,'stopped')};
  let clock=Date.now();
  const options={ownerPublicKey:keys.publicKey,ledger:{apply:()=>{throw Error('Legacy ledger write forbidden');},authorize:()=>{throw Error('No legacy scope');},view:()=>({})},load:store.load,save:async s=>{await beforeSave(s);await store.save(s);await saveHook(s);},operations:{now:()=>clock,adapter,describeSnapshot:async hash=>hash===snapshot.snapshotHash?structuredClone(snapshot):null,verifyEvidence:async(row,value,stage)=>evidence.get(value)===stage&&value.operationID===row.operationID&&value.attemptID===row.attemptID},stopScope:async()=>{}};
  const control=brokerControl(options);
  const signed=operation=>{
    const bytes=Buffer.from(JSON.stringify(manifest)),decision=Buffer.from(JSON.stringify({operation,projectID:manifest.projectID,scopeID:manifest.scopeID,manifestHash:digest(bytes),epoch:operation==='approve'?0:1,nonce:operation+'nonce',expiresAt:Date.now()+60000}));
    return {manifest:bytes.toString('base64'),decision:decision.toString('base64'),signature:sign(null,decision,keys.privateKey).toString('base64')};
  };
  const request=(requestID='request',operation='test',workerSessionID='qa')=>({requestID,operation,workerSessionID,taskID:'task',scopeID:'scope',authorizationEpoch:0,acceptanceEpoch:0,revision:'r1',snapshotHash:h,repository:snapshot.repository,repositoryID:'123',branch:snapshot.branch,baseCommit:snapshot.baseCommit,image:null,target:null,environment:null,qaReceiptID:null});
  if(recover)await control.recover();
  return {control,options,store,adapter,proof,calls,peer,request,snapshot,manifest,signed,time:value=>{clock=value;},approveOwner:input=>control.handlers.approve({kind:'owner'},input??signed('approve'))};
}
