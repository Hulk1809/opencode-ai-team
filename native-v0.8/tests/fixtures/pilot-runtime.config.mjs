import {defineConfig} from 'vite';
import solid from 'vite-plugin-solid';
import {readFileSync,mkdtempSync} from 'node:fs';
import {OfficialCoordinator} from '../../src/official-coordinator.mjs';
import {fileURLToPath} from 'node:url';
const source=fileURLToPath(new URL('../../.isolated/opencode-host-v2.2.5-direct-staging/packages/plugin/src/gui/index.ts',import.meta.url));
const snapshot=JSON.parse(readFileSync(new URL('../../.isolated/official-integration-audit/unified-snapshot.json',import.meta.url),'utf8'));
const root=mkdtempSync('/tmp/opencode/gui-pilot-store-');
const store=new OfficialCoordinator({location:{project:{canonical:root}},options:{pilotStore:root}});
store.mutate(()=>({state:snapshot}));
export default defineConfig({plugins:[solid(),{name:'pilot-coordinator-read-only-bridge',configureServer(server){server.middlewares.use((req,res,next)=>{
  if(req.url==='/pilot-snapshot'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(store.read()));return}
  if(req.url==='/pilot-update'&&req.method==='POST'){
    store.mutate(state=>{state.messages.push({from:'worker-1',to:'admin',text:'GUI storage update verified'});state.tasks[0].status='done';return {}});res.end('ok');return
  }next()
})}}],resolve:{alias:[{find:/^@opencode\/plugin\/gui$/,replacement:source}]},server:{host:'127.0.0.1',port:4189,strictPort:true,watch:{usePolling:true,interval:2000,ignored:['**/.isolated/**','**/node_modules/**']}}});
