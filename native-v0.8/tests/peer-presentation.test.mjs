import test from 'node:test';
import assert from 'node:assert/strict';
import {memberTasks,taskActive,taskDone,taskState,taskProgress,uniqueMessages,routingAdmissionBlocked,markdownBlocks} from '../src/peer-presentation.mjs';

test('peer board handles uppercase and legacy states without inventing measured progress',()=>{
  const member={id:'peer-1',role:'peer-1'},tasks=[{assignee:'peer-1',status:'RUNNING'},{assignee:'peer-1',status:'done'},{assignee:'peer-2',status:'BLOCKED'}];
  assert.equal(memberTasks({tasks},member).length,2);assert.equal(tasks.filter(taskDone).length,1);
  assert.equal(taskActive(tasks[0]),true);assert.equal(taskState(tasks[2]),'BLOCKED');
  assert.equal(taskProgress(tasks[0]),2);assert.equal(taskProgress(tasks[1]),6);assert.equal(taskProgress(tasks[2]),0);
});
test('refresh deduplicates durable IDs, preserving Unicode and sender',()=>{
  const message={id:'m1',from:'peer-2',to:'peer-1',text:'Kiểm tra tiếng Việt: Đặng, Nguyễn'};
  assert.deepEqual(uniqueMessages([message,{...message}, {...message,id:'m2'}]),[message,{...message,id:'m2'}]);
});
test('routing fails closed for missing admission data, outstanding execution and uncertain team wakes',()=>{
  const m={id:'peer-1',role:'peer-1'},team={tasks:[],messages:[]};
  assert.equal(routingAdmissionBlocked({},m),true);assert.equal(routingAdmissionBlocked(team,m),false);
  assert.equal(routingAdmissionBlocked({...team,mode:'peer'},m),true);
  assert.equal(routingAdmissionBlocked({...team,mode:'peer',runtime:{protocolVersion:1}},m),false);
  for(const task of [{assignee:'peer-1',status:'CLAIMED'},{assignee:'peer-1',status:'CANCELLED',executionState:'outstanding'}])assert.equal(routingAdmissionBlocked({...team,tasks:[task]},m),true);
  assert.equal(routingAdmissionBlocked({...team,tasks:[{assignee:'peer-2',status:'RUNNING',executionState:'outstanding'}]},m),false);
  assert.equal(routingAdmissionBlocked({...team,messages:[{to:'team',wake:{status:'uncertain'}}]},m),true);
});
test('safe report subset treats HTML, links and diagrams as text, never executable markup',()=>{
  const text='# Heading\n- Item\n> Quote\n```html\n<script>alert(1)</script>\n```\n[bad](javascript:alert(1))\n<img src=x onerror=alert(1)>';
  const blocks=markdownBlocks(text);assert.deepEqual(blocks.map(b=>b.kind),['heading','item','quote','code','text','text']);
  assert.equal(blocks[3].text,'<script>alert(1)</script>');assert.equal(blocks[4].text,'[bad](javascript:alert(1))');
  assert.equal(markdownBlocks('```\nunclosed')[0].text,'unclosed');
});
