import {fixture} from './operation-fixture.mjs';
const [directory,point,when]=process.argv.slice(2);
const f=await fixture(directory,{[when==='before'?'beforeSave':'saveHook']:async state=>{
  if(state.operationAudit?.at(-1)?.type===point){
    process.send({point});
    await new Promise(()=>{});
  }
}});
await f.approveOwner();
const row=await f.control.handlers.operationApprove(f.peer('admin'),f.request());
await f.control.handlers.operationAdmit(f.peer('qa'),{operationID:row.operationID});
await f.control.operations.execute(row.operationID);
