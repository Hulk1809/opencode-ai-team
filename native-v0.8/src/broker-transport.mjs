import {createServer} from 'node:https';
import {timingSafeEqual} from 'node:crypto';
import {operationFields} from './broker-operations.mjs';

const fields={submit:['scopeID','epoch','taskID','goal','files','buildID','requestID'],status:['jobID'],approve:['decision','signature','manifest'],revoke:['decision','signature','manifest'],done:['projectID','scopeID','taskID','epoch','snapshotHash','buildReceiptID','qaReceiptID','revision','acceptanceEpoch'],view:[]};
fields.completionStatus=fields.done;
fields.taskPolicy=['taskID'];
const text=x=>typeof x==='string'&&x.length>0&&x.length<=160;
const operationRoutes={'/v1/operations/approve':'operationApprove','/v1/operations/admit':'operationAdmit','/v1/operations/status':'operationStatus'};
operationRoutes['/v1/operations/proposal']='operationProposal';
const operationInputs={operationApprove:operationFields,operationAdmit:['operationID'],operationStatus:['operationID']};
operationInputs.operationProposal=['operationID','generation','files'];
function peerPolicy(socket,policy){
  if(!socket.authorized)throw Error('Unauthorized TLS peer');
  const fingerprint=socket.getPeerCertificate().fingerprint256;
  const peer=policy.find(p=>typeof fingerprint==='string'&&p.fingerprint.length===fingerprint.length&&timingSafeEqual(Buffer.from(p.fingerprint),Buffer.from(fingerprint)));
  if(!peer||!['owner','agent','admin'].includes(peer.kind))throw Error('Unknown TLS identity');
  return peer;
}
export function validateBrokerInput(operation,input,{isolatedOperations=false}={}){
  if(isolatedOperations&&Object.hasOwn(operationInputs,operation)){
    const keys=operationInputs[operation];
    if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).sort().join(',')!==[...keys].sort().join(',')||(operation!=='operationApprove'&&!/^[a-f0-9]{64}$/.test(input.operationID)))throw Error('Invalid versioned operation fields');
    return;
  }
  if(!Object.hasOwn(fields,operation)||!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).some(k=>!fields[operation].includes(k)))throw Error('Invalid operation fields');
  if(operation==='submit'&&(!text(input.scopeID)||!text(input.taskID)||!text(input.requestID)||!Number.isSafeInteger(input.epoch)||input.epoch<0||!['test','verify'].includes(input.goal)||!Array.isArray(input.files)||input.files.length>5000||(input.buildID!==undefined&&!text(input.buildID))))throw Error('Invalid submit');
  if(operation==='status'&&!text(input.jobID))throw Error('Invalid job ID');
  if(operation==='taskPolicy'&&!text(input.taskID))throw Error('Invalid task ID');
  if(['done','completionStatus'].includes(operation)&&(!['projectID','scopeID','taskID','snapshotHash','buildReceiptID','qaReceiptID'].every(k=>text(input[k]))||!Number.isSafeInteger(input.epoch)||input.epoch<0||!text(input.revision)||!Number.isSafeInteger(input.acceptanceEpoch)||input.acceptanceEpoch<0))throw Error('Invalid completion binding');
  if(['approve','revoke'].includes(operation)&&!['decision','signature','manifest'].every(k=>typeof input[k]==='string'&&input[k].length>0))throw Error('Invalid signed envelope');
}
// policy and handlers are protected host configuration, never supplied in requests.
// No reverse-proxy headers, sessionID, role, directory, Docker argv or service token trusted.
export function createBrokerServer({tls,policy,handlers,maxBytes=48*1024*1024,isolatedOperations=false}){
  if(!Array.isArray(policy)||!policy.length||new Set(policy.map(p=>p.fingerprint)).size!==policy.length||policy.some(p=>!/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(p.fingerprint)||!['owner','agent','admin'].includes(p.kind)||(p.kind!=='owner'&&(!text(p.projectID)||!text(p.sessionID)))))throw Error('Invalid protected identity policy');
  if(isolatedOperations&&(policy.some(p=>!text(p.projectID)||!text(p.principalID)||!text(p.sessionID)||!(p.kind==='owner'?p.role==='owner':p.kind==='admin'?p.role==='admin':['frontend','backend','devops','qa'].includes(p.role)))||new Set(policy.map(p=>JSON.stringify([p.projectID,p.sessionID]))).size!==policy.length||new Set(policy.map(p=>JSON.stringify([p.projectID,p.principalID]))).size!==policy.length))throw Error('Invalid isolated operation identity policy');
  policy=policy.map(p=>Object.freeze({...p}));
  const server=createServer({...tls,minVersion:'TLSv1.3',requestCert:true,rejectUnauthorized:true},async(req,res)=>{
    let dispatched=false;
    const reply=(status,body)=>{if(!res.destroyed){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));}};
    try{
      const peer=peerPolicy(req.socket,policy),versioned=isolatedOperations&&Object.hasOwn(operationRoutes,req.url),operation=versioned?operationRoutes[req.url]:req.url?.slice(1);
      if(req.method!=='POST'||!(versioned||Object.hasOwn(fields,operation))||req.headers['content-type']!=='application/json')return reply(400,{error:'Invalid request'});
      if(!(versioned?(peer.kind==='admin'?['operationApprove','operationStatus']:peer.kind==='agent'?['operationAdmit','operationStatus','operationProposal']:[]):peer.kind==='owner'?['approve','revoke','view']:peer.kind==='admin'?['done','completionStatus','taskPolicy']:['submit','status','taskPolicy']).includes(operation))return reply(403,{error:'Operation denied'});
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>maxBytes){reply(413,{error:'Request too large'});req.destroy();return;}chunks.push(chunk);}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));validateBrokerInput(operation,input,{isolatedOperations});
      if(isolatedOperations&&peer.kind==='owner'&&['approve','revoke'].includes(operation)&&JSON.parse(Buffer.from(input.decision,'base64').toString()).projectID!==peer.projectID)return reply(403,{error:'Owner project denied'});
      if(typeof handlers[operation]!=='function')return reply(503,{error:'Operation unavailable'});
      dispatched=true;
      // Client disconnect never cancels an admitted job or triggers replay.
      const output=await handlers[operation](Object.freeze({...peer}),input);
      reply(200,{output});
    }catch{reply(dispatched?409:400,{error:dispatched?'Operation rejected; reconcile by request ID':'Invalid or unauthorized request'});}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  return server;
}
