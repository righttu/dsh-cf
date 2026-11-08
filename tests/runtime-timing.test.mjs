import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { timeStage } from '../container/timing.mjs';

test('local stage timing uses a monotonic clock and preserves results', async () => {
  const values = [10, 17];
  const timing = {};
  assert.equal(await timeStage(timing, 'initialize', async () => 'ready', () => values.shift()), 'ready');
  assert.equal(timing.initializeMs, 7);
});

test('failed stage is measured without suppressing the error', async () => {
  const values = [10, 14];
  const timing = {};
  await assert.rejects(timeStage(timing, 'resume', async () => { throw Error('missing session'); }, () => values.shift()), /missing session/);
  assert.equal(timing.resumeMs, 4);
});

test('actual bridge session preparation initializes once then reports runtime reuse', async () => {
  let source = await readFile(new URL('../container/server.mjs', import.meta.url), 'utf8');
  source = source.replace("import http from 'node:http';", "const http = { createServer() { return { listen() {} }; } };");
  source = source.replace("import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';", "const mkdir = async () => {}; const readFile = async () => JSON.stringify({ sessionId: 'primary', task: null, history: [] }); const writeFile = async () => {}; const rename = async () => {};");
  source = source.replace("import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';", `
    export const counts = { initialize: 0, resume: 0 };
    class DeepSeekHarness {
      client = { start() {}, onRequest() {} };
      async start() { counts.initialize++; }
      async resumeSession() { counts.resume++; return {}; }
      session() { return {}; }
      async close() {}
    }
  `);
  for (const name of ['timing.mjs', 'history.mjs', 'approvals.mjs']) source = source.replace("'./" + name + "'", JSON.stringify(new URL('../container/' + name, import.meta.url).href));
  source += '\nexport { getSession, closeHarness };\n';
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const first = {}, second = {};
  await module.getSession(first);
  await module.getSession(second);
  assert.equal(first.runtimeReused, false);
  assert.equal(second.runtimeReused, true);
  assert.equal(first.runtimeId, second.runtimeId);
  assert.equal(second.initializeMs, 0);
  assert.equal(second.resumeMs, 0);
  assert.deepEqual(module.counts, { initialize: 1, resume: 1 });
  await module.closeHarness();
});
