import {createSignal} from 'solid-js'
const [project,setProject]=createSignal('/fixture/A')
const [scenario,setScenario]=createSignal('normal')
const calls:any[]=[]
Object.assign(window,{fixtureCalls:calls})
const roles=['admin','frontend','backend','devops','qa']
const requests=()=>Array.from({length:130},(_,i)=>({requestID:`${project()}-${i}`,project:project(),status:i%3?'PENDING_REVIEW':'SEEN',content:`Fixture request ${i}`,scope:'src only',risk:'low',requester:{role:'admin',sessionID:'fixture'},createdAt:'2026-11-01',expiresAt:'2026-11-02'}))
const task=()=>({id:'fixture-task',title:`${project()} · API contract review`,status:'blocked',assignee:'backend',priority:'high',description:'Synthetic discussion; authenticated review and OS cleanup missing',dependencies:['fixture-dependency'],acceptanceCriteria:['Versioned API contract','QA negative cases'],sourceReferences:['src/api.ts · fixture revision r2'],inputAttachments:['fixture-file'],outputAttachments:[],reviews:[{authorSessionID:'fixture-backend',reviewerSessionID:'fixture-qa',status:'BLOCKED',reason:'Synthetic metadata, not verified evidence'}]})
const messages=()=>[
  {id:'message',from:'admin',to:'owner',text:`${project()} · Kế hoạch đang chờ review. Tài liệu: fixture-file`,status:'answered'},
  {id:'question',from:'backend',to:'frontend',taskID:'fixture-task',text:`${project()} · @frontend: API trả lỗi validation theo schema nào? fixture-file`,status:'answered'},
  {id:'answer',requestID:'question',from:'frontend',to:'backend',taskID:'fixture-task',text:'Đề xuất JSON error schema v2. Cần QA kiểm tra negative cases.',status:'answered'},
  {id:'qa',requestID:'question',from:'qa',to:'backend',taskID:'fixture-task',text:'Chưa xác minh revision r2; synthetic QA không phải PASS.',status:'answered'},
  {id:'devops',from:'devops',to:'all',taskID:'fixture-task',text:'OS cleanup chưa có bằng chứng. Execution BLOCKED.',status:'answered'},
  {id:'admin',from:'admin',to:'all',taskID:'fixture-task',text:'Chưa có quyết định cuối được xác minh. Giữ task blocked.',status:'answered'},
].map(m=>({...m,at:'2026-11-01T00:00:00Z'}))
const rpc={
  snapshot:async()=>{calls.push({action:'snapshot',project:project()});if(scenario()==='error')throw Error('Fixture error: service unavailable');return {status:'ready',members:Object.fromEntries(roles.map(role=>[role,{role,sessionID:`fixture-${role}`}])) ,tasks:scenario()==='empty'?[]:[task()],messages:scenario()==='empty'?[]:messages()}},
  workspace:async({action,payload}:any)=>{
    calls.push({action,project:project()})
    if(scenario()==='error')throw Error('Fixture error: service unavailable')
    if(action==='list')return {files:scenario()==='empty'?[]:[{id:'fixture-file',name:`${project()} · api-contract.md`,size:128,mime:'text/markdown',visibility:'team',revision:'fixture-r2'}]}
    if(action==='tasks')return {tasks:scenario()==='empty'?[]:[task()]}
    if(action==='read')return {text:'Fixture file preview · synthetic API contract. Not broker evidence.'}
    if(action==='monitor')return {members:roles.map(role=>({role,state:'unknown',sessionID:`fixture-${role}`}))}
    if(action==='owner_requests'){const rows=requests(),start=payload.after??0,end=Math.min(start+100,rows.length);return {requests:rows.slice(start,end),next:end<rows.length?end:null,asOf:rows.length,snapshot:{}}}
    throw Error('Fixture mutation disabled')
  },
}
const context={sessions:{current:()=>({directory:project()})},system:{copy:async()=>{}},client:{rpc:()=>rpc},ui:{Markdown:(props:any)=><div>{props.text}</div>}}
export const usePlugin= <T,>()=>context as any
export const Plugin={define:(x:any)=>x}
export const Command={},MenuItem={},Panel={},Style={}
export {setProject,setScenario,project,scenario}
