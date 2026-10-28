// Resume recorded fixture review. Approve only fixture reads, stop on shell for human review.
import { connect } from '../apps/server/src/opencode.ts';
const sessionID=process.env.QA_SESSION;
if(!sessionID)throw new Error('Set QA_SESSION to existing fixture QA session');
const {client}=await connect();
const permissions=await client.permission.list({sessionID});
console.log(JSON.stringify(permissions,null,2));
const messages=await client.message.list({sessionID,limit:10,order:'desc'});
console.log(JSON.stringify(messages.data.map(m=>m.type==='assistant'?{type:m.type,content:m.content,error:m.error}:{type:m.type}),null,2));
