import test from 'node:test';
import assert from 'node:assert/strict';
import {trustedDevelopment} from '../src/native-development.mjs';
test('native coding opt-in requires exact project, registered session and unchanged worktree',()=>{
  const options={trustedDevelopment:{mode:'TRUSTED_DEVELOPMENT',project:'/project'}};
  const session={id:'test-session',metadata:{teamDirectory:'/project'},location:{directory:'/tree'}};
  const team={members:{backend:{sessionID:'test-session',directory:'/tree'}}};
  assert.equal(trustedDevelopment(options,'/project',session,team),true);
  for(const [o,l,s,t] of [[{},'/project',session,team],[options,'/other',session,team],[options,'/project',{...session,id:'forged'},team],[options,'/project',{...session,location:{directory:'/other'}},team],[options,'/project',{...session,metadata:{}},team]])assert.equal(trustedDevelopment(o,l,s,t),false);
});
