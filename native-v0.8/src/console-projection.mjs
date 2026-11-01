// Read-only UI projection; never consumed by broker authorization.
export function inboxProjection(requests,{status='',project=''}={}){
  return {
    pending:requests.filter(r=>['PENDING_REVIEW','SEEN'].includes(r.status)).length,
    unread:requests.filter(r=>r.status==='PENDING_REVIEW').length,
    requests:requests.filter(r=>(!status||r.status===status)&&(!project||r.project===project)),
    authorization:false,
  };
}
