import test from 'node:test';
import assert from 'node:assert/strict';
import { observeChatStream } from '../src/model-stream.js';
const encoder = new TextEncoder();
const frame = delta => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta }] }) + '\r\n\r\n';

test('forward original SSE bytes, handle split UTF-8/CRLF, show only public text', async () => {
  const input = frame({ reasoning_content: 'private reasoning' }) + frame({ content: '你好' }) + frame({ tool_calls: [{ function: { arguments: 'private tool argument' } }] }) + frame({ content: '！' }) + 'data: [DONE]\r\n\r\n';
  const bytes = encoder.encode(input);
  const chunks = [...bytes].map(byte => Uint8Array.of(byte));
  const updates = [];
  const source = new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(chunk); c.close(); } });
  const output = await new Response(observeChatStream(source, update => { updates.push(update); })).text();
  assert.equal(output, input);
  assert.equal(updates.at(-1).text, '你好！');
  assert.equal(updates.at(-1).done, true);
  assert.equal(JSON.stringify(updates).includes('private'), false);
});

test('first visible text is reported while provider stream is still open', async () => {
  let controller, notify;
  const reported = new Promise(resolve => { notify = resolve; });
  const source = new ReadableStream({ start(c) { controller = c; } });
  const reader = observeChatStream(source, update => { if (update.text) notify(update); }).getReader();
  controller.enqueue(encoder.encode(frame({ content: 'first' })));
  const chunk = await reader.read();
  assert.equal(chunk.done, false);
  assert.equal((await reported).text, 'first');
  controller.close();
  while (!(await reader.read()).done) {}
});

test('UI telemetry failure does not fail the harness model stream', async () => {
  const input = frame({ content: 'hello' });
  const source = new ReadableStream({ start(c) { c.enqueue(encoder.encode(input)); c.close(); } });
  const output = await new Response(observeChatStream(source, () => { throw Error('telemetry disconnected'); })).text();
  assert.equal(output, input);
});
