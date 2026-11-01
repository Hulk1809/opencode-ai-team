// Called only with host tool context; never with an ID supplied by RPC input.
export async function nativeCaller(ctx,room,sessionID) {
  const session=await ctx.session.get({sessionID});
  if(ctx.location.project?.id&&session.projectID!==ctx.location.project.id)throw Error('NATIVE_CALLER_PROJECT_MISMATCH');
  const directory=session.metadata?.teamDirectory;
  if(directory!==ctx.location.directory)throw Error('NATIVE_CALLER_LOCATION_UNAVAILABLE');
  const team=await room.read(directory);
  const member=Object.values(team?.members??{}).find(m=>m.sessionID===sessionID);
  if(team?.status!=='ready'||team.directory!==directory||!member||member.role!==session.agent||session.id!==sessionID||session.location?.directory!==(member.directory??directory))throw Error('NATIVE_CALLER_BINDING_MISMATCH');
  return {directory,sessionID,role:member.role};
}
