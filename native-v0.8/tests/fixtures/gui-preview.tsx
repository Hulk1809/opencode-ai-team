import {render} from 'solid-js/web'
import {TeamPane,style as paneStyle} from '../../src/gui'
import {chatStyle} from '../../src/chat-style'
import {setProject,setScenario,project,scenario} from './gui-plugin'
const style=document.createElement('style');style.textContent=paneStyle+chatStyle;document.head.append(style)
Object.assign(window,{fixtureProject:setProject,fixtureScenario:setScenario,fixtureTheme:(light:boolean)=>{document.documentElement.style.cssText=light?'--background-base:#fff;--background-raised:#f3f5f7;--background-weak:#e3e8ee;--text-base:#18212d;--text-weak:#485566':''}})
render(()=><><div style={{position:'absolute',right:'8px',bottom:'0','z-index':10,'font-size':'10px',background:'#273343',color:'white'}}>FIXTURE ONLY · {project()} · {scenario()} · synthetic / no live agents</div><TeamPane/></>,document.getElementById('root')!)
