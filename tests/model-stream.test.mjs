import test from 'node:test';
import assert from 'node:assert/strict';
import { observeChatStream, chatResponseMeta, chatRequestMeta } from '../src/model-stream.js';
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

test('model diagnostics report structural evidence, never reasoning or tool arguments', async () => {
 const event={choices:[{index:0,delta:{content:'',reasoning_content:'private thinking',tool_calls:[{function:{arguments:'private operation'}}]},finish_reason:'length'}],usage:{prompt_tokens:10,completion_tokens:20,completion_tokens_details:{reasoning_tokens:20}}};
 const meta=chatResponseMeta(event);
 assert.equal(meta.finishReason,'length');assert.equal(meta.reasoningPresent,true);assert.equal(meta.usage.reasoning_tokens,20);
 assert.doesNotMatch(JSON.stringify(meta),/private/);
 const sse='data: '+JSON.stringify(event)+'\n\ndata: [DONE]\n\n';
 let final;
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(sse));c.close()}});
 assert.equal(await new Response(observeChatStream(stream,()=>{},m=>{final=m})).text(),sse);
 assert.equal(final.finishReason,'length');assert.equal(final.contentChars,0);assert.equal(final.reasoningPresent,true);
});

test('request diagnostics contain counts and lengths, never history content',()=>{
 const input={stream:true,max_completion_tokens:32768,messages:[{role:'system',content:'private system'},{role:'user',content:'private user'},{role:'assistant',content:'answer',reasoning_content:'private reasoning',tool_calls:[{function:{arguments:'private arguments'}}]},{role:'tool',content:'private tool result'}],tools:[{function:{name:'private tool name'}}]};
 const meta=chatRequestMeta(input);assert.equal(meta.messageCount,4);assert.equal(meta.roles.user,1);assert.equal(meta.roles.tool,1);assert.equal(meta.toolCount,1);assert.equal(meta.reasoningChars,17);assert.equal(meta.max_completion_tokens,32768);assert.doesNotMatch(JSON.stringify(meta),/private|answer/);
});
