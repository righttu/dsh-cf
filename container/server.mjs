import http from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

await mkdir('/data/workspace', { recursive: true });
let state = { sessionId: null, task: null };
try { state = JSON.parse(await readFile('/data/state.json', 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
async function save() { await writeFile('/data/state.tmp', JSON.stringify(state)); await rename('/data/state.tmp', '/data/state.json'); }
if (state.task?.status === 'running') { state.task.status = 'interrupted'; state.task.error = 'Runtime restarted; task was not replayed. Inspect side effects before submitting again.'; await save(); }
let harness, session, busy = false;
async function getSession() {
  if (session) return session;
  harness = new DeepSeekHarness({ profile: 'sdk', dshHome: '/data/dsh-home', cwd: '/data/workspace', processCwd: '/data/workspace', patches: ['/app/gateway.cordis.yml'], provider: 'cloudflare-gateway', model: 'dsh-model', approvalRequests: true, env: { PATH: process.env.PATH, HOME: '/data', DSH_GATEWAY_PLACEHOLDER: 'cloudflare-binding-no-secret', DSH_TELEMETRY_DISABLED: '1', NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' }, onUserQuestion: async () => ({ cancelled: true }), shutdownTimeoutMs: 15000, disposeEofGraceMs: 15000 });
  // Fail closed: do not grant tool/plugin approvals without an interactive approver.
  harness.client.start();
  harness.client.onRequest(async () => ({ outcome: 'rejected' }));
  try {
    await harness.start();
    session = state.sessionId ? await harness.resumeSession(state.sessionId) : harness.session('primary');
    return session;
  } catch (e) { await harness.close(); harness = undefined; session = undefined; throw e; }
}
async function closeHarness() { if (harness) { await harness.close(); harness = undefined; session = undefined; } }
// Keep only terminal diagnostics, never whole conversation/tool payloads.
function safeDiagnostic(value) {
  try {
    return JSON.stringify(value, (key, item) => {
      if (/authorization|api.?key|token|secret|cookie|password/i.test(key)) return '[redacted]';
      return item;
    }).replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 4000);
  } catch { return 'Terminal error could not be serialized'; }
}
async function run(prompt) {
  try {
    const s = await getSession();
    // The identity is fixed. Missing/incompatible stored sessions fail rather than reset history.
    state.sessionId = state.sessionId || 'primary'; await save();
    const result = await s.run(prompt);
    state.sessionId = result.sessionId;
    const terminal = result.events?.findLast(event => event.type === 'turn/end');
    const failed = result.finishReason === 'error';
    const error = failed ? (safeDiagnostic(terminal?.data?.reason) || result.finalResponse || 'DSH returned error without a terminal diagnostic; inspect AI Gateway logs.') : undefined;
    state.task = { ...state.task, status: failed ? 'failed' : result.finishReason === 'aborted' ? 'interrupted' : 'completed', response: result.finalResponse, finishReason: result.finishReason, ...(failed ? { error } : {}) };
    if (failed) console.error('DSH task failed', state.task.id, error);
  } catch (e) { state.task = { ...state.task, status: 'failed', error: String(e.message).slice(0, 4000) }; }
  finally { try { await closeHarness(); } catch (e) { state.task.status = 'failed'; state.task.error = 'Shutdown failed: ' + e.message; } await save(); busy = false; }
}
const reply = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') return reply(res, 200, { ...state, busy });
    if (req.method === 'POST' && req.url === '/quiesce') {
      if (busy) return reply(res, 409, { error: 'Task is running' });
      await closeHarness(); await save(); return reply(res, 200, { ready: true });
    }
    if (req.method === 'POST' && req.url === '/tasks') {
      if (busy) return reply(res, 409, { error: 'Task is running' });
      let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32768) return reply(res, 413, { error: 'Prompt too large' }); }
      const body = JSON.parse(text);
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || typeof body.id !== 'string') return reply(res, 400, { error: 'Invalid task' });
      if (state.task?.id === body.id) return reply(res, 200, state.task);
      busy = true; state.task = { id: body.id, status: 'running', startedAt: Date.now() }; await save();
      reply(res, 202, state.task); void run(body.prompt); return;
    }
    reply(res, 404, { error: 'Not found' });
  } catch (e) { reply(res, 500, { error: String(e.message).slice(0, 2000) }); }
}).listen(8080, '0.0.0.0');
