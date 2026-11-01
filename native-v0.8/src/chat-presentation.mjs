export function messageStatus(status) {
  return ({waiting:'Đang chờ',queued:'Trong hàng đợi',admitted:'Đã tiếp nhận',running:'Đang tạo phản hồi',completed:'Phản hồi hoàn tất — không phải task DONE',unknown:'Chưa đủ bằng chứng',processing:'Đang xử lý',answered:'Đã phản hồi',failed:'Lỗi',uncertain:'Chưa rõ kết quả',expired:'Hết hiệu lực'})[status]??status;
}
export function conversationMessages(messages,role) {
  return role==='team'?messages:messages.filter(m=>(m.from==='owner'&&m.to===role)||(m.from===role&&m.to==='owner'));
}
export function unreadCount(messages,seen) {
  return messages.filter(m=>m.from!=='owner'&&!seen.has(m.id)).length;
}
