import { useState } from 'react';

export function TaskActions({id}: {id:string}) {
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [commit,setCommit]=useState('');
  async function action(name:string,body:unknown={}) {
    setBusy(true);setError('');
    try {
      const response=await fetch(`/api/tasks/${encodeURIComponent(id)}/${name}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json();if(!response.ok)throw new Error(result.error??`HTTP ${response.status}`);
    }catch(e){setError(String(e));}finally{setBusy(false);}
  }
  return <div className="panel"><div className="task-actions">
    <button disabled={busy} onClick={()=>void action('execute')}>Giao agent thực hiện</button>
    <button disabled={busy} onClick={()=>void action('review')}>Tạo snapshot review</button>
    <a href={`/api/tasks/${encodeURIComponent(id)}/patch`}>Tải patch đã duyệt</a>
  </div><details><summary>Xác nhận đã tích hợp thủ công</summary>
    <p>Chỉ xác nhận sau khi đã review, tích hợp và kiểm thử trong source chính. Thao tác này không chạy merge.</p>
    <input aria-label="Commit đã tích hợp" placeholder="Commit SHA đầy đủ (40 ký tự)" value={commit} onChange={e=>setCommit(e.target.value)}/>
    <button disabled={busy||!/^[0-9a-f]{40}$/.test(commit)} onClick={()=>{
      if(window.confirm('Xác nhận bạn đã tích hợp đúng patch và kiểm thử source chính? Hệ thống chỉ kiểm tra commit tồn tại trong lịch sử, không tự chứng minh nội dung tương đương.'))void action('integrated',{commit});
    }}>Xác nhận commit tích hợp</button>
  </details>{error&&<p role="alert" className="error-text">{error}</p>}</div>;
}
