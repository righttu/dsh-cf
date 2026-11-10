import test from 'node:test';
import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {page} from '../src/page.js';
test('phase appears below heading, reports observed elapsed time and hides at task end',()=>{
 const script=page.match(/<script>([\s\S]*)<\/script>/)[1],fn=script.split('\n').find(line=>line.startsWith('function renderTaskPhase(s)'));assert.ok(fn);const nodes=new Map(),el=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{}});return nodes.get(id)};const ctx={el};new Script(fn).runInNewContext(ctx);
 ctx.renderTaskPhase({task:{status:'running'},taskPhase:{kind:'approval',label:'等待你的授权',detail:'需要单次批准',since:3000,observedAt:5000}});assert.equal(el('task-phase').hidden,false);assert.equal(el('phase-label').textContent,'等待你的授权');assert.equal(el('phase-label').dataset.phase,'approval');assert.equal(el('phase-elapsed').textContent,'本阶段 2 秒');
 ctx.renderTaskPhase({task:{status:'completed'}});assert.equal(el('task-phase').hidden,true);ctx.renderTaskPhase({task:{status:'running'},taskPhase:null});assert.equal(el('phase-label').textContent,'Agent 正在执行');assert.equal(el('phase-elapsed').textContent,'');assert.ok(page.indexOf('id="task-phase"')>page.indexOf('id="task-heading"'));
 assert.match(page,/不是 CPU 使用率/);assert.match(page,/内存和磁盘按配置规格计费/);assert.doesNotMatch(page,/CPU 使用率为 0|等待期间不计费|空等免费/);
});


test('model phase omits the removed paragraph and wait summary remains visible for final task',()=>{
 const script=page.match(/<script>([\s\S]*)<\/script>/)[1],lines=script.split('\n');const nodes=new Map(),el=id=>{if(!nodes.has(id))nodes.set(id,{dataset:{}});return nodes.get(id)};const ctx={el,ms:v=>(v/1000).toFixed(1)+' 秒'};
 new Script(lines.find(x=>x.startsWith('function renderTaskPhase(s)'))+';'+lines.find(x=>x.startsWith('function renderTaskWait(s)'))).runInNewContext(ctx);
 ctx.renderTaskPhase({task:{id:'t',status:'running'},taskPhase:{kind:'model',label:'模型请求进行中',detail:''}});assert.equal(el('phase-detail').hidden,true);assert.equal(el('phase-detail').textContent,'');
 ctx.renderTaskWait({task:{id:'t',status:'completed'},taskWait:{taskId:'t',ratio:0.6,waitMs:3000,totalMs:5000,modelMs:1000,browserMs:1000,approvalMs:1000,finished:true}});assert.equal(el('wait-summary').hidden,false);assert.match(el('wait-ratio').textContent,/60.0%/);assert.match(el('wait-duration').textContent,/已结束/);
 ctx.renderTaskWait({task:{id:'t'},taskWait:{taskId:'t',ratio:null,waitMs:0,totalMs:5000,modelMs:0,browserMs:0,approvalMs:0}});assert.equal(el('wait-ratio').textContent,'已知等待');assert.doesNotMatch(el('wait-breakdown').textContent,/未观测|覆盖/);ctx.renderTaskWait({task:{id:'old'},taskWait:{taskId:'t'}});assert.equal(el('wait-summary').hidden,true);
});

test('known-wait help excludes streaming, local work and preparation',()=>{assert.doesNotMatch(page,/未观测|观测不足|按执行阶段约每秒采样/);assert.match(page,/不含接收模型流、本地执行及浏览器准备/);assert.match(page,/总计已去重/)});
