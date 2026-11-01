import test from 'node:test';
import assert from 'node:assert/strict';
import {messageStatus,conversationMessages,unreadCount} from '../src/chat-presentation.mjs';
test('chat presentation keeps direct threads separate and unread is not read receipt',()=>{
  const rows=[{id:'1',from:'owner',to:'qa'},{id:'2',from:'qa',to:'owner'},{id:'3',from:'qa',to:'backend'}];
  assert.deepEqual(conversationMessages(rows,'qa').map(m=>m.id),['1','2']);
  assert.equal(conversationMessages(rows,'team').length,3);
  assert.equal(unreadCount(rows,new Set(['2'])),1);
  assert.equal(messageStatus('answered'),'Đã phản hồi');
  assert.equal(messageStatus('future-status'),'future-status');
});
