// Only bounded structural metadata; no prompts, reasoning, tool arguments or credentials.
export function chatResponseMeta(event) {
  const choice = event?.choices?.find(c => c.index === 0) ?? event?.choices?.[0];
  const message = choice?.delta ?? choice?.message;
  const usage = {};
  for (const key of ['prompt_tokens','completion_tokens','total_tokens']) if (Number.isFinite(event?.usage?.[key])) usage[key] = event.usage[key];
  const reasoningTokens = event?.usage?.completion_tokens_details?.reasoning_tokens;
  if (Number.isFinite(reasoningTokens)) usage.reasoning_tokens = reasoningTokens;
  const reason = choice?.finish_reason;
  return { hasChoices: Array.isArray(event?.choices), wrappedResult: !!event?.result, finishReason: typeof reason === 'string' && /^[a-z_-]{1,40}$/i.test(reason) ? reason : null,
    contentChars: typeof message?.content === 'string' ? message.content.length : 0,
    reasoningPresent: typeof message?.reasoning_content === 'string' && !!message.reasoning_content,
    toolCallsPresent: !!message?.tool_calls?.length, errorPresent: !!event?.error, usage };
}
// Observe public answer text while preserving the original model stream byte-for-byte.
// Never forward reasoning, tool arguments, or other raw provider payloads to the UI.
export function observeChatStream(body, report, reportMeta = () => {}) {
  const decoder = new TextDecoder();
  const meta = { hasChoices: false, wrappedResult: false, frames: 0, finishReason: null, contentChars: 0, reasoningPresent: false, toolCallsPresent: false, errorPresent: false, usage: {} };
  let buffer = '', text = '', lastSent = 0, first = true;
  async function emit(done = false) {
    if (!done && !first && Date.now() - lastSent < 120) return;
    first = false; lastSent = Date.now();
    try { await report({ text, done }); } catch { /* UI telemetry must not fail the model call. */ }
  }
  async function frame(frame) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let event; try { event = JSON.parse(data); } catch { return; }
    const part = chatResponseMeta(event); meta.frames++; meta.hasChoices ||= part.hasChoices; meta.wrappedResult ||= part.wrappedResult;
    meta.finishReason = part.finishReason || meta.finishReason; meta.contentChars += part.contentChars;
    for (const key of ['reasoningPresent','toolCallsPresent','errorPresent']) meta[key] ||= part[key];
    Object.assign(meta.usage, part.usage);
    const choice = event.choices?.find(c => c.index === 0) ?? event.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) {
      text = (text + delta).slice(0, 160000);
      await emit();
    }
  }
  return body.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      // Enqueue original bytes before telemetry; no reconstructed OpenAI stream.
      controller.enqueue(chunk);
      buffer += decoder.decode(chunk, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) { const value = buffer.slice(0, end); buffer = buffer.slice(end + 2); await frame(value); }
      if (buffer.length > 1048576) buffer = ''; // Bound malformed/non-SSE telemetry buffering.
    },
    async flush() { buffer += decoder.decode(); if (buffer.trim()) await frame(buffer); await emit(true); try { await reportMeta(meta); } catch {} }
  }));
}

// Count shape/length only. Character counts are NOT token counts.
export function chatRequestMeta(input) {
  const roles={system:0,developer:0,user:0,assistant:0,tool:0,other:0},contentChars={...roles};
  let reasoningChars=0,toolArgumentChars=0;
  for(const message of input.messages||[]){
    const role=Object.hasOwn(roles,message.role)?message.role:'other';roles[role]++;
    contentChars[role]+=typeof message.content==='string'?message.content.length:message.content==null?0:JSON.stringify(message.content).length;
    reasoningChars+=typeof message.reasoning_content==='string'?message.reasoning_content.length:0;
    for(const call of message.tool_calls||[])toolArgumentChars+=typeof call.function?.arguments==='string'?call.function.arguments.length:0;
  }
  return {stream:input.stream===true,max_tokens:Number.isFinite(input.max_tokens)?input.max_tokens:null,max_completion_tokens:Number.isFinite(input.max_completion_tokens)?input.max_completion_tokens:null,messageCount:(input.messages||[]).length,roles,contentChars,reasoningChars,toolArgumentChars,toolCount:(input.tools||[]).length,toolDefinitionChars:JSON.stringify(input.tools||[]).length};
}
