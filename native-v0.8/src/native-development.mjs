// Owner enables through reviewed project-local plugin options, never RPC payload.
// Existing native permissions still apply; this is not a sandbox or permission grant.
export function trustedDevelopment(options,location,session,team) {
  const config=options?.trustedDevelopment;
  if(config?.mode!=='TRUSTED_DEVELOPMENT'||config.project!==location||session.metadata?.teamDirectory!==config.project)return false;
  const member=Object.values(team?.members??{}).find(m=>m.sessionID===session.id);
  return !!member&&session.location?.directory===(member.directory??config.project);
}
