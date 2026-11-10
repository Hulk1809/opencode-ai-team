export function selectEngine(options={}){
  if(options.nativeDispatch===true||options.pilotWake===true)throw Error('PEER_LIVE_EXECUTION_BLOCKED');
  if(options.officialPilot===true)return 'canonical';
  return 'legacy-read-only';
}
