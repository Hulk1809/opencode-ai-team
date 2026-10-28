import { z } from 'zod';

export const proposalSchema=z.object({
  summary:z.string().trim().min(1).max(15000),
  findings:z.string().trim().min(1).max(15000),
  risks:z.string().trim().min(1).max(10000),
  questions:z.array(z.string().trim().min(1).max(1000)).max(20),
  members:z.array(z.object({role:z.enum(['frontend','backend','devops','qa']),count:z.literal(1),model:z.string().trim().max(200),reason:z.string().trim().min(1).max(2000)})).min(1).max(4).refine(items=>new Set(items.map(m=>m.role)).size===items.length,'Mỗi role chỉ có một session'),
});
export const approvalSchema=z.object({version:z.number().int().positive(),goal:z.string().trim().min(1).max(10000),budgetNote:z.string().trim().min(1).max(2000),maxParallel:z.number().int().min(1).max(4)});
export const surveyPrompt=`Survey this Git project using read/glob/grep only. Do not modify files, run shell, create coding sessions, delegate coding, or claim tests passed. Inspect source and explain observed architecture, implemented features, gaps, risks and evidence paths. Ask concrete questions if goal is unknown. Use team_submit_proposal to save structured assessment and suggested coding roles (one session per role maximum), model (empty string means inherited default), reason, and questions. Do not invent provider prices or cost estimates. No coding until human approves goal, team and budget acknowledgement. Existing backlog may be read, not executed.`;
