const roles=['admin','frontend','backend','devops','qa'];
export const projects=['/fixture/A','/fixture/B'];
const deny=()=>{throw Error('FIXTURE_DENIED');};
const text='SYNTHETIC fixture file. Not production evidence.\n';
// ponytail: memory-only state lasts one adapter lifetime; reload resets dataset, never migrates production state.
export function createFixture({wait=()=>Promise.resolve()}={}) {
  const states=new Map(projects.map(directory=>[directory,{seen:new Map(),sent:[],sequence:0}]));
  async function call(method,input){
    if(!input||!projects.includes(input.directory))throw Error('FIXTURE_PROJECT_DENIED');
    const {directory}=input,s=states.get(directory);
    await wait(directory,method);
    if(method==='snapshot'||method==='sync')return {status:'ready',members:Object.fromEntries(roles.map(role=>[role,{role,sessionID:`fixture-${directory.at(-1)}-${role}`}])) ,messages:[
      ...roles.map((role,i)=>({id:`fixture-${i}`,from:role,to:i?'all':'owner',taskID:'fixture-task',text:`SYNTHETIC ${directory}: ${role} discussion. No execution or verified review.`,status:'answered',at:'2026-11-01T00:00:00Z'})),...s.sent]};
    if(method==='send'){
      if(!roles.includes(input.recipient)||typeof input.text!=='string'||!input.text.trim()||input.text.length>10000)deny();
      const id=`fixture-message-${++s.sequence}`;
      s.sent.push({id,from:'owner',to:input.recipient,text:input.text,status:'answered',at:'2026-11-01T00:00:00Z'});return {id};
    }
    if(method==='models'&&input.action==='list')return {models:[]};
    if(method!=='workspace')deny();
    const p=input.payload;if(!p||typeof p!=='object'||Array.isArray(p))deny();
    switch(input.action){
      case 'list':return {files:[{id:'fixture-file',name:'fixture.md',size:text.length,mime:'text/markdown',visibility:'team',revision:'fixture-r1'}]};
      case 'read':case 'download':
        if(p.fileID!=='fixture-file')deny();
        return input.action==='read'?{text}:{name:'fixture.md',base64:Buffer.from(text).toString('base64')};
      case 'tasks':return {tasks:[{id:'fixture-task',title:`SYNTHETIC ${directory}`,status:'blocked',assignee:'backend',dependencies:['fixture-dependency'],acceptanceCriteria:['Fixture only'],sourceReferences:[],inputAttachments:['fixture-file'],outputAttachments:[],reviews:[]}]};
      case 'monitor':return {members:roles.map(role=>({role,state:'unknown',sessionID:`fixture-${directory.at(-1)}-${role}`}))};
      case 'owner_requests':{
        const start=p.after??0,limit=p.limit??100;
        if(!Number.isInteger(start)||start<0||start>130||!Number.isInteger(limit)||limit<1||limit>100||p.asOf!==undefined&&p.asOf!==130||p.snapshot!==undefined&&p.snapshot.project!==directory)deny();
        const end=Math.min(130,start+limit);
        return {requests:Array.from({length:end-start},(_,j)=>{const i=start+j,requestID=`fixture-request-${i}`;return {requestID,project:directory,status:s.seen.get(requestID)??'PENDING_REVIEW',content:`SYNTHETIC request ${i}`,scope:'fixture only',risk:'low',requester:{role:'admin',sessionID:`fixture-${directory.at(-1)}-admin`},createdAt:'2026-11-01T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z'};}),next:end<130?end:null,asOf:130,snapshot:{project:directory}};
      }
      case 'owner_request_update':
        if(!/^fixture-request-(?:[0-9]|[1-9][0-9]|1[0-2][0-9])$/.test(p.requestID)||!['SEEN','DISMISSED'].includes(p.status))deny();
        s.seen.set(p.requestID,p.status);return {requestID:p.requestID,status:p.status};
      default:deny();
    }
  }
  return {call};
}
