export function openAdminChat(ctx, snapshot) {
  const current = ctx.sessions.current();
  const admins = snapshot?.team?.members?.filter(member => member.role === 'admin') ?? [];
  if (!current || current.server.id !== snapshot?.serverID || current.directory !== snapshot?.directory || admins.length !== 1 || typeof admins[0].sessionID !== 'string' || !admins[0].sessionID.startsWith('ses_')) throw Error('PILOT_ADMIN_CHAT_UNAVAILABLE');
  ctx.tabs.open({server: snapshot.serverID, id: admins[0].sessionID}, {focus: true});
}
