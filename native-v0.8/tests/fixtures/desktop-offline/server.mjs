import {Plugin} from '@opencode/plugin';
import {TeamChatRPC} from './rpc.mjs';
import {createFixture,projects} from './adapter.mjs';

export default Plugin.define({id:'ai-team-chat',async setup(ctx){
  if(!projects.includes(ctx.location.directory))throw Error('FIXTURE_PROJECT_DENIED');
  const fixture=createFixture();
  await ctx.rpc.register(TeamChatRPC,Object.fromEntries(['execution','models','workspace','memberSend','memberInbox','createTeam','snapshot','sync','send'].map(method=>[method,async(input,context)=>{
    try{
      if(input.directory!==ctx.location.directory)throw Error('FIXTURE_PROJECT_DENIED');
      return await fixture.call(method,input);
    }catch(error){
      if(['snapshot','sync','memberInbox'].includes(method))throw error;
      const reason=error.message;
      return context.error(method==='createTeam'?'setup_failed':'operation_failed',reason,{reason});
    }
  }])));
}});
