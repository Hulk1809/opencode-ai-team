import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import type { Team } from '../../../apps/server/src/team.ts';
import { roles, columns } from '../../shared/src/index.ts';

export async function handleMcp(team:Team,req:Request,res:Response,agent:any) {
  const server=new McpServer({name:'ai-team',version:'1.0.0'});
  const result=(v:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(v)}]});
  const parent=()=>agent.currentMessageID?team.store.get('messages',agent.currentMessageID):undefined;
  const send=async (input:any)=>result(team.send({projectID:agent.projectID,receiver:input.receiver,body:input.body,idempotencyKey:input.idempotencyKey},agent.role,parent()));
  const sendSchema={receiver:z.enum([...roles,'team']),body:z.string().min(1).max(30000),idempotencyKey:z.string().min(1).max(200)};
  server.registerTool('team_send_message',{description:'Send durable message and wake real recipient session. Stable idempotencyKey required.',inputSchema:sendSchema},send);
  server.registerTool('team_ask_agent',{description:'Ask real agent asynchronously. Reply arrives through message bus; never block both sessions waiting.',inputSchema:sendSchema},send);
  server.registerTool('team_get_inbox',{description:'Read inbox, shared context, tasks and agent worktree locations',inputSchema:{}},async()=>result({messages:team.store.all('messages').filter(m=>m.projectID===agent.projectID&&(m.receiver===agent.role||m.receiver==='team')).slice(-100),tasks:team.store.all('tasks').filter(t=>t.projectID===agent.projectID),agents:team.store.all('agents').filter(a=>a.projectID===agent.projectID).map(({capability,...a})=>a),project:team.store.get('projects',agent.projectID)}));
  server.registerTool('team_update_task',{description:'Admin/QA create tasks; assigned agent updates; only QA can mark Done with evidence',inputSchema:{action:z.enum(['create','update']),id:z.string().optional(),title:z.string().optional(),assignee:z.enum(roles).optional(),priority:z.enum(['low','medium','high']).optional(),dependencies:z.array(z.string()).optional(),criteria:z.string().optional(),status:z.enum(columns).optional(),evidence:z.string().optional()}},async input=>{
    if(input.action==='create') {
      if(!['admin','qa'].includes(agent.role)) throw new Error('Only Admin or QA creates backlog');
      return result(team.task({...input,projectID:agent.projectID},agent.role));
    }
    const t=team.store.get('tasks',input.id!); if(t.projectID!==agent.projectID) throw new Error('Cross-project task denied');
    return result(team.updateTask(t.id,input,agent.role));
  });
  server.registerTool('team_request_review',{description:'Request QA review of real task and diff',inputSchema:{taskID:z.string(),body:z.string(),idempotencyKey:z.string()}},async input=>{
    const t=team.store.get('tasks',input.taskID);if(t.projectID!==agent.projectID) throw new Error('Cross-project task denied');
    team.updateTask(t.id,{status:'Review',evidence:input.body},agent.role);
    return send({receiver:'qa',body:`Review ${t.id}: ${input.body}. Inspect actual worktree ${agent.directory}, run tests, report bugs or Done with evidence.`,idempotencyKey:input.idempotencyKey});
  });
  server.registerTool('team_report_blocker',{description:'Persist blocker and notify Admin',inputSchema:{taskID:z.string(),body:z.string(),idempotencyKey:z.string()}},async input=>{
    const t=team.store.get('tasks',input.taskID);if(t.projectID!==agent.projectID) throw new Error('Cross-project task denied');
    team.updateTask(t.id,{status:'Blocked',evidence:input.body},agent.role);
    return send({receiver:'admin',body:`Blocker ${t.id}: ${input.body}`,idempotencyKey:input.idempotencyKey});
  });
  const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
  await server.connect(transport);
  res.on('close',()=>{void transport.close();void server.close();});
  await transport.handleRequest(req,res,req.body);
}
