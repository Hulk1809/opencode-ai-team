// Query the mounted panel host, never the window or the query container itself.
export const chatStyle = `
.ai-team-host{container:team-chat / inline-size;position:relative;isolation:isolate;flex:1 1 0%;align-self:stretch;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden}

.ai-team-pane{--chat-bg:var(--background-base,#10151c);--chat-surface:var(--background-raised,#171e28);--chat-raised:var(--background-weak,#202a37);--chat-text:var(--text-base,#edf2f7);--chat-muted:var(--text-weak,#a8b6c8);--chat-line:color-mix(in srgb,var(--chat-text) 18%,transparent);--chat-accent:#65dfc5;--chat-accent-ink:#102b26;--chat-own:color-mix(in srgb,var(--chat-accent) 18%,var(--chat-bg));--chat-focus:#50b7d1;display:grid;grid-template-columns:240px minmax(0,1fr) 280px;grid-template-rows:minmax(0,1fr);gap:0;padding:0;min-width:0;min-height:0;width:100%;height:100%;overflow:hidden;background:var(--chat-bg);color:var(--chat-text);font:14px/1.5 system-ui}
.ai-team-pane *{box-sizing:border-box}.ai-team-pane button,.ai-team-pane textarea,.ai-team-pane select{font:inherit}.ai-team-pane button{color:inherit;background:var(--chat-raised);border:1px solid var(--chat-line);min-height:36px}.ai-team-pane button:disabled{cursor:not-allowed}.ai-team-pane :focus-visible{outline:2px solid var(--chat-focus);outline-offset:3px}.ai-team-pane .dim{opacity:1;color:var(--chat-muted);font-size:12px}
.ai-team-pane .team-nav{min-width:0;min-height:0;flex:0 0 240px;display:flex;flex-direction:column;gap:6px;padding:16px 10px;overflow:auto;background:var(--chat-surface);border-right:1px solid var(--chat-line)}.ai-team-pane .brand{padding:8px 10px;font-size:18px}.ai-team-pane .brand small{font-size:11px;font-weight:400;opacity:1;color:var(--chat-muted)}.ai-team-pane .nav-section{padding:12px 10px 4px;font-size:11px;color:var(--chat-muted);text-transform:uppercase;letter-spacing:.08em}.ai-team-pane .project-name{padding:0 10px;overflow-wrap:anywhere;font-size:12px;color:var(--chat-muted)}
.ai-team-pane .team-nav .conversation-item{display:flex;align-items:center;gap:10px;width:100%;min-height:72px;padding:10px;border:0;border-radius:12px;text-align:left;background:transparent}.ai-team-pane .conversation-item[aria-current=true]{background:var(--chat-own)}.ai-team-pane .conversation-content{flex:1;min-width:0}.ai-team-pane .conversation-heading{display:flex;justify-content:space-between;gap:6px;align-items:center}.ai-team-pane .conversation-heading time{font-size:10px;color:var(--chat-muted)}.ai-team-pane .conversation-preview{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--chat-muted)}.ai-team-pane .unread{border-radius:999px;padding:2px 7px;background:var(--chat-accent);color:var(--chat-accent-ink);font-size:11px;font-weight:700}.ai-team-pane .nav-links{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-top:auto;padding-top:16px}.ai-team-pane .nav-links button{font-size:11px}
.ai-team-pane .team-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;padding:0;gap:0;overflow:auto;position:relative;background:var(--chat-bg)}.ai-team-pane .team-main.chat-view{overflow:hidden}.ai-team-pane .team-main>header{display:flex;align-items:center;justify-content:space-between;flex:none;padding:16px 20px;border-bottom:1px solid var(--chat-line);background:var(--chat-surface);gap:10px}.ai-team-pane header h3{margin:0;font-size:16px}.ai-team-pane .header-actions{display:flex;gap:8px;align-items:center}.ai-team-pane header input{width:160px}.ai-team-pane .team-main>.warn,.ai-team-pane .team-main>.dim,.ai-team-pane .team-main>details{flex:none;margin:8px 16px;font-size:11px}.ai-team-pane .team-main>details summary{cursor:pointer;color:var(--chat-muted)}.ai-team-pane .warn{background:color-mix(in srgb,#cc9354 9%,var(--chat-bg));border:1px solid #a87840;border-radius:10px}.ai-team-pane .chat-history{display:flex;flex-direction:column;flex:1 1 0%;min-width:0;min-height:0;max-height:none;overflow-y:auto;overscroll-behavior:contain;padding:20px;gap:0}.ai-team-pane .message-row{flex:none;min-width:0;display:flex;align-items:flex-end;gap:8px;margin-bottom:18px}.ai-team-pane .message-row.own{flex-direction:row-reverse}.ai-team-pane .avatar{display:grid;place-items:center;flex:0 0 32px;width:32px;height:32px;border-radius:12px;background:var(--chat-raised);color:var(--chat-text);font-size:11px;font-weight:700}.ai-team-pane .message-body{max-width:min(82%,720px);min-width:0}.ai-team-pane .who{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:5px;font-size:11px}.ai-team-pane .who time{color:var(--chat-muted);font-weight:400}.ai-team-pane .role-badge{border:1px solid var(--chat-line);border-radius:999px;padding:1px 6px;font-size:10px;font-weight:500}.ai-team-pane .message-row .message{max-width:none;align-self:auto;background:var(--chat-raised);border:0;padding:12px 16px;border-radius:16px 16px 16px 5px}.ai-team-pane .message-row.own .message{background:var(--chat-own);border-radius:16px 16px 5px 16px}.ai-team-pane .own .who{justify-content:flex-end}.ai-team-pane .message-status{display:block;margin-top:4px;color:var(--chat-muted);font-size:10px}.ai-team-pane .own .message-status{text-align:right}.ai-team-pane .message{min-width:0;overflow-wrap:anywhere}.ai-team-pane .message-text{min-width:0;max-width:100%;overflow:hidden}.ai-team-pane .message pre{max-width:100%;overflow-x:auto;white-space:pre}.ai-team-pane .message table{display:block;max-width:100%;overflow-x:auto}.ai-team-pane .message img{max-width:100%;height:auto}.ai-team-pane .team-monitor pre{max-width:100%;overflow:auto}.ai-team-pane .team-monitor>*{flex-shrink:0}.ai-team-pane .message-actions button{opacity:1;color:var(--chat-muted)}
.ai-team-pane .composer{flex:none;display:flex;flex-wrap:wrap;min-width:0;margin-top:auto;margin:0;padding:12px 16px;border-top:1px solid var(--chat-line);background:var(--chat-surface);gap:8px;max-height:45%;overflow:auto}.ai-team-pane .composer-tools{display:flex;gap:6px;align-items:center}.ai-team-pane .composer select{width:auto;max-width:100%;font-size:12px}.ai-team-pane .composer textarea{width:100%;flex-basis:100%;min-height:64px;max-height:160px;resize:vertical;border:1px solid var(--chat-line);background:var(--chat-bg);border-radius:14px}.ai-team-pane .composer details{position:relative}.ai-team-pane .composer summary{cursor:pointer;padding:8px;border-radius:8px;border:1px solid var(--chat-line);font-size:12px}.ai-team-pane .picker{display:flex;flex-wrap:wrap;gap:4px;max-width:240px;padding:8px;background:var(--chat-bg);border-radius:8px}.ai-team-pane .send-button{margin-left:auto;background:var(--chat-accent);color:var(--chat-accent-ink);border-color:transparent;font-weight:650}.ai-team-pane .team-monitor{flex:0 0 280px;display:flex;flex-direction:column;min-width:0;min-height:0;padding:16px;gap:12px;background:var(--chat-surface);border-left:1px solid var(--chat-line);overflow:auto}.ai-team-pane .team-monitor h3{margin:0}.ai-team-pane .member,.ai-team-pane .attachment,.ai-team-pane .special-card{border:1px solid var(--chat-line);border-radius:12px;padding:12px;background:var(--chat-surface)}.ai-team-pane .special-card{margin-top:10px;border-left:3px solid var(--chat-accent)}.ai-team-pane .special-card h4{margin:8px 0}.ai-team-pane .special-card p{white-space:pre-wrap;max-height:120px;overflow:auto}.ai-team-pane .card-heading{display:flex;justify-content:space-between;gap:8px;font-size:11px}.ai-team-pane .file-grid,.ai-team-pane .kanban,.ai-team-pane .agents{padding:16px}.ai-team-pane .file-preview{margin:8px 16px;max-height:35%;overflow:auto;flex-shrink:0}.ai-team-pane .mobile-back{display:none}.ai-team-pane .team-monitor details summary{cursor:pointer}.ai-team-pane .team-monitor .member>button{margin-top:8px}

/* Daily-use polish; keep host-based layout and existing breakpoints. */
.ai-team-pane .team-main>section{padding:12px;min-width:0;overflow-wrap:anywhere;flex-shrink:0}
.ai-team-pane .team-main>button{flex-shrink:0;white-space:normal;overflow-wrap:anywhere}
.ai-team-pane .kanban article small,.ai-team-pane .kanban article code{display:block;overflow-wrap:anywhere}
.ai-team-pane .team-main>header{overflow-wrap:anywhere}
.ai-team-pane{--chat-font-body:14px;--chat-font-meta:12px;font-size:var(--chat-font-body)}
.ai-team-pane .dim,.ai-team-pane .message-status,.ai-team-pane .who time,.ai-team-pane .conversation-heading time{color:var(--chat-muted);font-size:var(--chat-font-meta)}
.ai-team-pane input::placeholder,.ai-team-pane textarea::placeholder{color:var(--chat-muted);opacity:1}
.ai-team-pane button:hover:not(:disabled),.ai-team-pane summary:hover{background:var(--chat-own)}
.ai-team-pane .conversation-item[aria-current=true]{box-shadow:inset 3px 0 var(--chat-accent);background:var(--chat-own)}
.ai-team-pane .team-nav .conversation-item{min-height:64px;padding:9px 10px;gap:8px}
.ai-team-pane .conversation-item.team-room .avatar{background:var(--chat-accent);color:var(--chat-accent-ink)}
.ai-team-pane .conversation-heading strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.ai-team-pane .conversation-heading time{flex-shrink:0;font-size:11px}
.ai-team-pane .team-main>header{padding:12px 16px;flex-wrap:wrap}
.ai-team-pane .header-actions{flex-wrap:wrap;min-width:0;max-width:100%}
.ai-team-pane .chat-history{padding:16px}
.ai-team-pane .message-row{margin-bottom:12px}
.ai-team-pane .message-row .message{padding:10px 14px;font-size:var(--chat-font-body);line-height:1.6}
.ai-team-pane .message-text p{margin:0 0 8px}.ai-team-pane .message-text p:last-child{margin-bottom:0}
.ai-team-pane .who{font-size:12px;gap:6px}.ai-team-pane .role-badge{font-size:11px}
.ai-team-pane .message-body{max-width:min(calc(100% - 40px),680px)}
.ai-team-pane .special-card{padding:12px;margin-top:8px;overflow-wrap:anywhere;min-width:0}
.ai-team-pane .special-card h4{font-size:14px;line-height:1.4}
.ai-team-pane .card-heading{font-size:12px;flex-wrap:wrap}
.ai-team-pane .team-monitor{padding:12px;gap:8px}
.ai-team-pane .team-monitor h4{margin:6px 0;font-size:13px}
.ai-team-pane .compact-member{padding:0;background:transparent}
.ai-team-pane .compact-member>summary{display:flex;align-items:center;gap:9px;padding:10px;min-width:0;list-style:none;border-radius:12px}
.ai-team-pane .compact-member>summary::-webkit-details-marker{display:none}
.ai-team-pane .compact-member>summary::after{content:'+';margin-left:auto;color:var(--chat-muted)}
.ai-team-pane .compact-member[open]>summary::after{content:'−'}
.ai-team-pane .member-summary{display:grid;grid-template-columns:minmax(0,1fr);min-width:0;gap:2px}
.ai-team-pane .member-summary strong{font-size:13px}
.ai-team-pane .member-state,.ai-team-pane .member-task{font-size:12px;color:var(--chat-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-team-pane .member-expanded{padding:0 10px 10px;overflow-wrap:anywhere}
.ai-team-pane .member-expanded button{margin:6px 4px 0 0;font-size:12px}
.ai-team-pane .info-section{border-top:1px solid var(--chat-line);padding:10px 0;min-width:0}
.ai-team-pane .info-section>summary{font-size:13px;font-weight:650;padding:4px;border-radius:6px}
.ai-team-pane .info-section>.attachment{margin-top:8px}
.ai-team-pane .composer{gap:6px;padding:10px 12px;align-items:center;scrollbar-gutter:stable}
.ai-team-pane .composer>select{flex:0 1 auto;min-width:0;font-size:12px}
.ai-team-pane .composer button,.ai-team-pane .composer summary{font-size:12px;min-height:34px}
.ai-team-pane .composer textarea{margin:0;min-height:60px;font-size:14px;line-height:1.5}
.ai-team-pane .composer>.attachment,.ai-team-pane .composer>.dim{flex-basis:100%;min-width:0;overflow-wrap:anywhere}
.ai-team-pane .composer .picker{position:static;max-width:100%}
.ai-team-pane .composer-tools{flex-wrap:wrap;min-width:0;max-width:100%}
.ai-team-pane .team-main>[role=dialog]{max-height:50%;overflow:auto;flex-shrink:0;padding:12px}
@container team-chat (max-width:1179px){
 .ai-team-pane{grid-template-columns:210px minmax(0,1fr)}
 .ai-team-pane .team-monitor{display:none}
 .ai-team-pane.show-details .team-monitor{display:flex;grid-column:2;grid-row:1}
 .ai-team-pane.show-details .team-main{display:none}
}
@container team-chat (max-width:759px){
 .ai-team-pane{grid-template-columns:minmax(0,1fr)}
 .ai-team-pane .team-nav{display:none}
 .ai-team-pane.show-conversations .team-nav{display:flex;grid-column:1;grid-row:1}
 .ai-team-pane.show-conversations .team-main,.ai-team-pane.show-conversations .team-monitor{display:none}
 .ai-team-pane.show-details:not(.show-conversations) .team-monitor{grid-column:1;grid-row:1}
 .ai-team-pane .mobile-back{display:inline-block}
 .ai-team-pane .team-main>header{padding:12px;flex-wrap:wrap}
 .ai-team-pane header input{width:130px}
 .ai-team-pane .chat-history{padding:12px}
 .ai-team-pane .message-body{max-width:calc(100% - 40px)}
 .ai-team-pane .composer{padding:10px}
 .ai-team-pane .composer-tools{flex-wrap:wrap}
}
/* Compact composer keeps existing actions in native disclosure; no new RPC. */
.ai-team-pane .composer{position:relative;overflow:visible;align-items:center;padding:10px 12px;max-height:40%;gap:8px}
.ai-team-pane .composer textarea{flex:1 1 120px;width:auto;min-width:0;min-height:42px;height:48px;max-height:100px;flex-basis:120px;resize:none;border:0;padding:12px}
.ai-team-pane .composer details.composer-menu{flex:none;position:static}
.ai-team-pane .composer-menu>summary{font-size:22px;line-height:24px;list-style:none;border:0;width:36px;text-align:center}
.ai-team-pane .composer-menu>summary::-webkit-details-marker{display:none}
.ai-team-pane .composer-options{position:absolute;z-index:5;bottom:100%;left:12px;display:flex;flex-wrap:wrap;gap:8px;padding:12px;width:min(360px,calc(100% - 24px));max-height:min(280px,50vh);overflow:auto;background:var(--chat-surface);box-shadow:0 -4px 20px #0004;border:1px solid var(--chat-line);border-radius:12px}
.ai-team-pane .composer>.attachment,.ai-team-pane .composer>.dim,.ai-team-pane .composer>[role=status]{flex-basis:100%;max-height:60px;overflow:auto}
.ai-team-pane .header-actions .unread-count{display:inline-block;margin-left:8px;padding:2px 6px;border-radius:8px;background:var(--chat-own);font-size:11px}
.ai-team-pane .task-links{display:flex;gap:6px;overflow:auto;flex:none;padding:6px 12px;max-height:70px}
/* V0.8.1 chat-first: one conversation sidebar, optional non-modal drawers. */
.ai-team-pane{grid-template-columns:240px minmax(0,1fr)}
.ai-team-pane .brand small{display:block;margin-top:3px}
.ai-team-pane .sidebar-hint{margin-top:auto;padding:16px 10px;color:var(--chat-muted);font-size:12px}
.ai-team-pane .chat-heading{min-width:0}.ai-team-pane .chat-heading small{display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-team-pane .content-tabs{display:flex;gap:20px;padding:0 20px;border-bottom:1px solid var(--chat-line);flex:none}
.ai-team-pane .content-tabs button{border:0;border-radius:0;background:transparent;padding:12px 4px;color:var(--chat-muted)}
.ai-team-pane .content-tabs button[aria-current=page]{color:var(--chat-text);box-shadow:inset 0 -2px var(--chat-accent)}
.ai-team-pane .header-actions>button{border:0;background:transparent}
.ai-team-pane .message-row .message{border-radius:16px;padding:12px 16px}
.ai-team-pane .inbox-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-bottom:14px;font-size:12px}
.ai-team-pane .request-list{display:flex;flex-direction:column}
.ai-team-pane .request-row{display:grid;grid-template-columns:minmax(100px,1fr) 70px 70px 50px 85px;gap:12px;align-items:center;text-align:left;padding:12px 8px;border:0;border-bottom:1px solid var(--chat-line);border-radius:0;background:transparent;font-size:12px;min-width:0}
.ai-team-pane .request-row.unread{background:var(--chat-own);color:var(--chat-text);border-radius:0;font-weight:400}
.ai-team-pane .request-row span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-team-pane .request-title strong,.ai-team-pane .request-title small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-team-pane .request-title strong{font-size:14px;font-weight:500}.ai-team-pane .request-row.unread strong{font-weight:700}.ai-team-pane .request-title small{color:var(--chat-muted);margin-top:3px}
.ai-team-pane .request-drawer,.ai-team-pane .settings-panel{position:absolute;z-index:3;right:0;top:0;bottom:0;width:min(420px,100%);padding:20px;overflow:auto;background:var(--chat-surface);box-shadow:-8px 0 30px #0003;border-left:1px solid var(--chat-line);overflow-wrap:anywhere}
.ai-team-pane .request-drawer h3{font-size:17px;line-height:1.5}.ai-team-pane .request-drawer dd{margin:0 0 12px}.ai-team-pane .request-drawer dt{color:var(--chat-muted);font-size:12px}.ai-team-pane .settings-panel details{margin:16px 0}.ai-team-pane .settings-panel small{display:block}
.ai-team-pane .kanban{display:flex;flex-direction:column;gap:0;overflow:visible}.ai-team-pane .kanban section{flex:auto}.ai-team-pane .kanban section h4{margin:12px 0 4px;color:var(--chat-muted);font-size:12px;text-transform:uppercase}.ai-team-pane .kanban article{border:0;border-bottom:1px solid var(--chat-line);border-radius:0;margin:0;padding:12px 0}
@container team-chat (max-width:1179px){.ai-team-pane{grid-template-columns:210px minmax(0,1fr)}}
@container team-chat (max-width:759px){.ai-team-pane{grid-template-columns:minmax(0,1fr)}.ai-team-pane .header-actions input{width:110px}.ai-team-pane .header-actions button small{display:none}.ai-team-pane .content-tabs{gap:16px;padding:0 12px}.ai-team-pane .request-row{grid-template-columns:minmax(100px,1fr) 65px 55px;gap:8px}.ai-team-pane .request-row>span:nth-child(3),.ai-team-pane .request-row time{display:none}}
`
