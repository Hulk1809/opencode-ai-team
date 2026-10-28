import { useState, type FormEvent } from 'react';

export function ProjectPlan({project}:{project:any}) {
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  if(!project?.onboarding)return null;
  const plan=project.proposal;
  async function approve(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const values=new FormData(event.currentTarget);setBusy(true);setError('');
    try {
      const response=await fetch(`/api/projects/${encodeURIComponent(project.id)}/approve-plan`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({version:plan.version,goal:values.get('goal'),budgetNote:values.get('budgetNote'),maxParallel:Number(values.get('maxParallel'))})});
      const data=await response.json();if(!response.ok)throw new Error(data.error);
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  return <section className="panel settings-panel"><h3>Khảo sát và duyệt đội AI</h3>
    <p>Trạng thái: {project.onboarding}. Khảo sát dùng một session Admin thật, có thể phát sinh phí model. Coding chỉ bắt đầu sau khi duyệt.</p>
    {plan&&<><h4>{plan.summary}</h4><pre style={{whiteSpace:'pre-wrap'}}>{plan.findings}</pre><h4>Rủi ro</h4><p>{plan.risks}</p>
      <ul>{plan.questions.map((q:string,i:number)=><li key={i}>{q}</li>)}</ul>
      <ul>{plan.members.map((m:any)=><li key={m.role}>{m.role}: {m.count} session — {m.model||'Model mặc định'} — {m.reason}</li>)}</ul>
      <p>Chưa có ước tính giá được xác minh. Ngân sách bên dưới là xác nhận của bạn, không phải bộ giới hạn chi phí tự động.</p>
      {project.onboarding==='awaiting_approval'&&<form onSubmit={approve}>
        <label>Mục tiêu và trả lời câu hỏi<textarea name="goal" required maxLength={10000}/></label>
        <label>Ngân sách / điều kiện sử dụng model<input name="budgetNote" required maxLength={2000}/></label>
        <label>Số coding session chạy đồng thời<input name="maxParallel" type="number" min={1} max={plan.members.length} defaultValue={1} required/></label>
        <p>Duyệt sẽ cho phép Admin lập backlog và gọi agent trong đội đã đề xuất. Không tự merge, push hoặc deploy.</p>
        <button disabled={busy}>Duyệt phạm vi và đội</button>
      </form>}
    </>}{!plan&&<p>Admin chưa gửi đề xuất. Xem Team Chat/Sessions; nếu có lỗi, kiểm tra model và retry tin khảo sát.</p>}
    {error&&<p className="error-text" role="alert">{error}</p>}
  </section>;
}
