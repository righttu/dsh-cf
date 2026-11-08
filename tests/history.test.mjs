import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { page } from '../src/page.js';
import { updateHistory, historyView } from '../container/history.mjs';

test('page embedded JavaScript parses and element references exist', () => {
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Script(script);
  const ids = [...page.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of script.matchAll(/el\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), match[1]);
  assert.ok(page.includes('id="history-list"'));
  assert.equal(page.includes('恢复备份到工作区'), false);
});

test('prompt and final response remain one entry across atomic state serialization', () => {
  const state = { sessionId: 'primary', task: { id: 'a', prompt: '你好', status: 'running' } };
  updateHistory(state);
  state.task = { ...state.task, status: 'completed', response: '你好，有什么可以帮你？' };
  updateHistory(state);
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(historyView(restored).total, 1);
  assert.equal(historyView(restored).entries[0].prompt, '你好');
  assert.equal(historyView(restored).entries[0].response, '你好，有什么可以帮你？');
  assert.equal(historyView(restored).sessionId, 'primary');
});

test('legacy state does not manufacture missing user messages', () => {
  const state = { task: { id: 'old', response: 'old reply', status: 'completed' } };
  updateHistory(state);
  assert.equal(historyView(state).total, 0);
});

test('UI view is bounded without deleting older persisted history', () => {
  const state = {};
  for (let i = 0; i < 70; i++) { state.task = { id: String(i), prompt: String(i) }; updateHistory(state); }
  assert.equal(state.history.length, 70);
  assert.equal(historyView(state).total, 70);
  assert.equal(historyView(state).entries.length, 50);
  assert.equal(historyView(state).entries[0].id, '20');
});

test('history preview fits Durable Object value size without truncating persisted data', () => {
  const state = {};
  for (let i = 0; i < 50; i++) { state.task = { id: String(i), prompt: '你'.repeat(16000), response: '好'.repeat(16000) }; updateHistory(state); }
  const view = historyView(state);
  assert.ok(new TextEncoder().encode(JSON.stringify(view)).byteLength < 90000);
  assert.ok(view.entries.length > 0);
  assert.equal(view.entries.at(-1).truncated, true);
  assert.equal(state.history[0].prompt.length, 16000);
});

test('presentation removes requested explanatory copy without hiding backup controls', () => {
 for (const text of ['最近成功保存时的记录','DSH 对话标识：','显示最近最多 50 条任务与最终回复','单所有者工作区 / 实验版','需审批操作默认拒绝','保存失败会提示并重试。R2 不是实时同步。','新任务统一以控制层时钟计时','初始化包括 DSH 启动与握手','DEEPSEEK HARNESS · CLOUDFLARE','让想法，成为实际成果。','执行任务、查看成果，保存后可从快照或 R2 恢复。']) assert.equal(page.includes(text),false,text);
 for (const id of ['snapshots','save','recover','checkpoint-time','backup-time','dispatch-ms','history-list']) assert.ok(page.includes('id="'+id+'"'),id);
 assert.equal(page.includes('class="advanced card"'),false);
});
