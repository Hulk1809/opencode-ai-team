import {render} from 'solid-js/web'
import {createRoot} from 'solid-js'
import {PluginContext} from '../../.isolated/opencode-host-v2.2.5-direct-staging/packages/plugin/src/gui/internal'
import {Panel} from '@opencode/plugin/gui'
import definition from '../../src/gui'

// ponytail: compatible isolated registry host, not packaged Desktop acceptance; upgrade to full Desktop host before cutover.
const entries:any[]=[]
let connected=true
const snapshot=async(input:any)=>{
  if(!connected)throw Error('ISOLATED_DISCONNECTED')
  const response=await fetch('/pilot-snapshot',{method:'POST',body:JSON.stringify(input)})
  if(!response.ok)throw Error(await response.text())
  return response.json()
}
const data=await snapshot({})
const session={id:data.members[0].sessionID,directory:data.members[0].directory,server:{client:{rpc:()=>({snapshot})}}}
const ctx:any={id:'ai-team-chat',options:{officialPilot:true},sessions:{current:()=>session},layout:{ready:()=>true,open:()=>{},state:()=> 'visible'},t:(key:string)=>key,
  add:(registry:any,item:any)=>{entries.push({registry,item:typeof item==='function'?item():item});return ()=>{}}}
createRoot(()=>definition.setup!(ctx))
const panels=entries.filter(e=>e.registry===Panel)
if(panels.length!==1)throw Error(`GUI_PANEL_COUNT:${panels.length}`)
Object.assign(window,{pilotDisconnect:()=>{connected=false},pilotReconnect:()=>{connected=true},pilotRegistrations:entries.map(e=>({registry:e.registry.id,id:e.item.id})),pilotUpdate:async()=>{
  const response=await fetch('/pilot-update',{method:'POST'});if(!response.ok)throw Error(await response.text())
}})
render(()=><PluginContext.Provider value={ctx}>{panels[0].item.render({session})}</PluginContext.Provider>,document.getElementById('root')!)
