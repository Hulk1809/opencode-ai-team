import {For,Show} from 'solid-js'
import {markdownBlocks} from './peer-presentation.mjs'

export function SafeReport(props:{text:string}){
  return <div class="pilot-markdown"><For each={markdownBlocks(props.text)}>{(block:any)=><Show when={block.kind==='code'} fallback={block.kind==='heading'?<div role="heading" aria-level={block.level} class="pilot-markdown-heading">{block.text}</div>:block.kind==='item'?<div class="pilot-markdown-item">• {block.text}</div>:block.kind==='quote'?<blockquote>{block.text}</blockquote>:<div class="pilot-markdown-line">{block.text||'\u00a0'}</div>}><pre><code>{block.text}</code></pre></Show>}</For></div>
}
