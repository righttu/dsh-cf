// Observe public answer text while preserving the original model stream byte-for-byte.
// Never forward reasoning, tool arguments, or other raw provider payloads to the UI.
export function observeChatStream(body, report) {
  const decoder = new TextDecoder();
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
    async flush() { buffer += decoder.decode(); if (buffer.trim()) await frame(buffer); await emit(true); }
  }));
}
