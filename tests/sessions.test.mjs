import test from 'node:test';
import assert from 'node:assert/strict';
import { initSessions, sessionView, selectSession } from '../container/sessions.mjs';
import { updateHistory, historyView } from '../container/history.mjs';
const one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
test('legacy session and all original task records survive migration',()=>{
 const state={sessionId:'primary',task:{id:'old',prompt:'old prompt',status:'completed',response:'old answer'},history:[{id:'old',prompt:'old prompt',status:'completed',response:'old answer'}]};
 initSessions(state);assert.equal(state.sessions[0].initialized,true);assert.equal(state.history[0].sessionId,'primary');
 selectSession(state,{action:'create',id:one});assert.equal(state.sessionId,one);assert.equal(state.task,null);assert.equal(state.sessions[1].initialized,false);
 assert.deepEqual(historyView(state).entries,[]);assert.equal(state.history.length,1);
 selectSession(state,{action:'select',id:'primary'});assert.equal(state.task.response,'old answer');assert.equal(historyView(state).entries.length,1);
});
test('new contexts have distinct identities and per-session history, surviving serialization',()=>{
 const state={history:[]};initSessions(state);
 selectSession(state,{action:'create',id:one});state.task={id:'a',sessionId:one,prompt:'first',response:'answer one',status:'completed'};updateHistory(state);
 selectSession(state,{action:'create',id:two});assert.equal(historyView(state).total,0);
 state.task={id:'b',sessionId:two,prompt:'second',response:'answer two',status:'completed'};updateHistory(state);
 const restored=JSON.parse(JSON.stringify(state));initSessions(restored);selectSession(restored,{action:'select',id:one});
 assert.equal(historyView(restored).entries[0].response,'answer one');assert.equal(restored.history.length,2);assert.equal(sessionView(restored).sessions.length,3);
});
test('creation retry does not duplicate or silently switch another active context',()=>{
 const state={history:[]};initSessions(state);selectSession(state,{action:'create',id:one});selectSession(state,{action:'create',id:two});selectSession(state,{action:'create',id:one});
 assert.equal(state.sessions.length,3);assert.equal(state.sessionId,two);
 assert.throws(()=>selectSession(state,{action:'select',id:'missing'}),/不存在/);assert.equal(state.sessionId,two);
 assert.throws(()=>selectSession(state,{action:'create',id:'../escape'}),/无效/);
});

test('deletion removes only selected session history and never shared files',()=>{
 const state={history:[]};initSessions(state);selectSession(state,{action:'create',id:one});state.task={id:'a',sessionId:one,prompt:'private A',response:'A',status:'completed'};updateHistory(state);
 selectSession(state,{action:'create',id:two});state.task={id:'b',sessionId:two,prompt:'private B',response:'B',status:'completed'};updateHistory(state);
 selectSession(state,{action:'delete',id:one});assert.equal(state.sessionId,two);assert.equal(state.task.id,'b');assert.ok(!state.sessions.some(s=>s.id===one));assert.deepEqual(state.history.map(x=>x.id),['b']);
 assert.throws(()=>selectSession(state,{action:'select',id:one}),/已删除/);assert.throws(()=>selectSession(state,{action:'create',id:one}),/已删除/);
 selectSession(state,{action:'delete',id:one});assert.equal(state.sessionId,two);
 selectSession(state,{action:'delete',id:two});assert.equal(state.task,null);assert.equal(state.history.length,0);
});
test('deleting last session creates fresh uninitialized context and persists tombstone',()=>{
 const state={history:[]};initSessions(state);const old=state.sessionId;selectSession(state,{action:'delete',id:old});
 assert.equal(state.sessions.length,1);assert.notEqual(state.sessionId,old);assert.equal(state.sessions[0].initialized,false);assert.equal(state.task,null);
 const saved=JSON.parse(JSON.stringify(state));initSessions(saved);assert.throws(()=>selectSession(saved,{action:'select',id:old}),/已删除/);
 assert.equal(sessionView(saved).sessionDeletionSupported,true);
});
