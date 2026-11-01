import {For,Show,type JSX} from 'solid-js'
export const roleLabel=(role:string)=>({admin:'Admin',backend:'Backend',frontend:'Frontend',devops:'DevOps',qa:'QA',owner:'Owner',all:'Team Room'}[role]??role)

export function ConversationItem(props:{title:string,initials:string,preview:string,at?:string,unread?:number,team?:boolean,selected:boolean,onSelect:()=>void}) {
  return <button type="button" class="conversation-item" classList={{'team-room':props.team}} aria-current={props.selected?'true':undefined} onClick={props.onSelect}>
    <span class="avatar" aria-hidden="true">{props.initials}</span><span class="conversation-content"><span class="conversation-heading"><strong>{props.title}</strong><Show when={props.at}><time dateTime={props.at}>{new Date(props.at!).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}</time></Show></span><span class="conversation-preview">{props.preview}</span></span><Show when={props.unread&&props.unread>0}><span class="unread" aria-label={`${props.unread} tin chưa đọc`}>{props.unread!>99?'99+':props.unread}</span></Show>
  </button>
}
export function MessageBubble(props:{own:boolean,from:string,to:string,at:string,status:string,children:JSX.Element}) {
  return <article class="message-row" classList={{own:props.own}} aria-label={`Tin từ ${props.from}`}><span class={`avatar role-${props.from}`} aria-hidden="true">{props.from.slice(0,2).toUpperCase()}</span><div class="message-body"><div class="who"><strong>{props.own?'Bạn':roleLabel(props.from)}</strong><span class="dim">tới {roleLabel(props.to)}</span><time dateTime={props.at}>{new Date(props.at).toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit'})}</time></div><div class="message">{props.children}</div><small class="message-status">{props.status}</small></div></article>
}
export function TaskCard(props:{task:{id:string,title:string,assignee:string,status:string,description?:string},onOpen:()=>void}) {
  return <section class="special-card" aria-label={`Task ${props.task.title}`}><div class="card-heading"><span>Phân công task</span><span class="role-badge">{props.task.status}</span></div><h4>{props.task.title}</h4><small>@{props.task.assignee}</small><Show when={props.task.description}><p>{props.task.description}</p></Show><button type="button" onClick={props.onOpen}>Xem task</button></section>
}
export function ComposerTools(props:{onAttach:()=>void,onMention:(role:string)=>void,onEmoji:(value:string)=>void,uploading:boolean}) {
  return <div class="composer-tools"><button type="button" disabled={props.uploading} onClick={props.onAttach}>Đính kèm</button><details><summary aria-label="Chọn người nhận">@ Mention</summary><div class="picker"><For each={['admin','backend','frontend','devops','qa']}>{role=><button type="button" onClick={e=>{props.onMention(role);e.currentTarget.closest('details')?.removeAttribute('open')}}>@{role}</button>}</For></div></details><details><summary>Emoji</summary><div class="picker"><For each={[['👍','Đồng ý'],['✅','Hoàn tất'],['👀','Đang xem']]}>{([value,label])=><button type="button" aria-label={label} onClick={e=>{props.onEmoji(value);e.currentTarget.closest('details')?.removeAttribute('open')}}>{value}</button>}</For></div></details></div>
}
