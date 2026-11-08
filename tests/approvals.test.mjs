import test from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalQueue } from '../container/approvals.mjs';

test('approval waits for a real single-use user decision and persists it', async () => {
 const records=[];let saves=0;
 const q=new ApprovalQueue(records,async()=>{saves++});
 let settled=false;const pending=q.request({sessionId:'primary',toolName:'bash',callId:'c1',reason:'Run a command'},'t1').then(r=>{settled=true;return r});
 await new Promise(r=>setTimeout(r,0));assert.equal(settled,false);
 const id=q.view()[0].id;
 assert.equal(q.view()[0].status,'pending');
 assert.equal((await q.decide(id,'allowed-once')).outcome,'allowed-once');
 assert.deepEqual(await pending,{outcome:'allowed-once'});
 assert.ok(saves>=2);
 await assert.rejects(q.decide(id,'allowed-once'),/失效/);
});
test('reject, cancellation and expired approvals never allow execution',async()=>{
 for(const outcome of ['rejected','cancelled']){
  const q=new ApprovalQueue([],async()=>{});const p=q.request({sessionId:'p',toolName:'bash'},'t');
  await new Promise(r=>setTimeout(r,0));await q.decide(q.view()[0].id,outcome);assert.equal((await p).outcome,outcome);
 }
 const q=new ApprovalQueue([],async()=>{},10);const p=q.request({sessionId:'p',toolName:'bash'},'t');assert.equal((await p).outcome,'cancelled');
});
test('task end cancels pending requests; arbitrary permanent grants are rejected',async()=>{
 const q=new ApprovalQueue([],async()=>{});const p=q.request({sessionId:'p',toolName:'bash'},'t');await new Promise(r=>setTimeout(r,0));
 await assert.rejects(q.decide(q.view()[0].id,'always-allow'),/Invalid/);await q.cancelAll();assert.equal((await p).outcome,'cancelled');
});
