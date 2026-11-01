import {realpath,access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute,resolve,relative,sep} from 'node:path';
import {checkWorktree} from './persistence.mjs';

export const MAVEN_COMMANDS=['mvn -B test','mvn -B verify','mvn -B -DskipTests package'];
export async function approveWorktree(ctx,room,directory,p) {
  if(!['frontend','backend','devops','qa'].includes(p.role)||p.approved!==true)throw Error('Owner phải phê duyệt role và phạm vi rõ ràng');
  if(!Array.isArray(p.files)||!p.files.length||p.files.length>100||p.files.some(f=>typeof f!=='string'||isAbsolute(f)||f.split(/[\\/]/).some(x=>!x||x==='..'||x.startsWith('.')||/[?*\[\]{}]/.test(x))||/\.(pem|key|p12|pfx)$/.test(f)))throw Error('Files phải là paths tương đối cụ thể, không glob/secret');
  if(!Array.isArray(p.commands)||p.commands.some(c=>!MAVEN_COMMANDS.includes(c)))throw Error('Chỉ nhận Maven commands trong allowlist');
  return room.exclusive(directory,async()=>{
    const t=await room.read(directory),m=t?.members?.[p.role];if(!m)throw Error('Role không tồn tại');
    if(t.messages.some(x=>x.to===p.role&&['waiting','queued','admitted','uncertain'].includes(x.status)))throw Error('Đợi worker hết request trước đổi quyền');
    const tree=await checkWorktree(m.directory,directory),s=await ctx.session.get({sessionID:m.sessionID});
    if(await realpath(s.location.directory)!==tree.directory)throw Error('Session directory khác worktree');
    await access(tree.directory,constants.W_OK);
    for(const f of p.files)await assertScopedPath(tree.directory,f);
    if(Object.values(t.members).some(x=>x.role!==p.role&&x.directory===m.directory))throw Error('Worktree không được dùng chung');
    const existing=(s.permissions??[]).filter(r=>!(['edit','shell','subagent'].includes(r.action)&&r.resource==='*'&&r.effect==='deny'));
    if(existing.some(r=>['edit','shell'].includes(r.action)))throw Error('Session có coding rules riêng; cần Owner review, không ghi đè');
    const permissions=[...existing,{action:'edit',resource:'*',effect:'deny'},...p.files.map(f=>({action:'edit',resource:resolve(tree.directory,f),effect:'allow'})),{action:'shell',resource:'*',effect:'ask'},...p.commands.map(c=>({action:'shell',resource:c,effect:'allow'})),{action:'subagent',resource:'*',effect:'deny'}];
    // Maven executes repository build code. Owner approves these exact commands, not a sandbox escape.
    const scope={directory:tree.directory,files:[...p.files],commands:[...p.commands],approvedAt:new Date().toISOString(),approvedBy:'owner'};
    await ctx.session.update({sessionID:m.sessionID,permissions});
    m.writable=true;m.codingScope=scope;await room.write(directory,t);return {role:p.role,scope,permissions};
  });
}

export async function assertScopedPath(base,path) {
  const root=await realpath(base),target=resolve(root,path??'.');
  const rel=relative(root,target);
  if(rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel)||rel.split(sep).some(x=>x==='.git'||x==='.env'||x.startsWith('.env.')||/\.(pem|key|p12|pfx)$/.test(x)))throw Error('Team không được đọc/ghi ngoài worktree hoặc file credentials');
  // Resolve existing ancestor too: writes to a new file through symlink must not escape.
  let existing=target;
  for(;;){try{const actual=await realpath(existing);if(actual!==root&&!actual.startsWith(root+sep))throw Error('Symlink ngoài worktree');break;}catch(e){if(e.code!=='ENOENT')throw e;const parent=resolve(existing,'..');if(parent===existing)throw e;existing=parent;}}
  return target;
}
