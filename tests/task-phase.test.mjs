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
