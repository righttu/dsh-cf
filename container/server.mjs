import http from 'node:http';
import { ApprovalQueue } from './approvals.mjs';
import { timeStage } from './timing.mjs';
import { updateHistory, historyView, normalizeTask } from './history.mjs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

await mkdir('/data/workspace', { recursive: true });
let state = { sessionId: null, task: null, history: [] };
try { state = JSON.parse(await readFile('/data/state.json', 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
let saveChain = Promise.resolve();
function save() { updateHistory(state); const text=JSON.stringify(state); const next=saveChain.then(async()=>{await writeFile('/data/state.tmp',text);await rename('/data/state.tmp','/data/state.json')});saveChain=next.catch(()=>{});return next; }
state.approvals = (state.approvals || []).map(a => a.status === 'pending' ? {...a,status:'cancelled',finishedAt:Date.now()} : a);
const approvals = new ApprovalQueue(state.approvals, save);
if (state.task?.status === 'running') { state.task.status = 'interrupted'; state.task.error = 'Runtime restarted; task was not replayed. Inspect side effects before submitting again.'; await save(); }
let harness, session, runtimeId, busy = false, activeRunClock = null;
async function getSession(timing) {
  timing.runtimeReused = !!session;
  timing.initializeMs = 0; timing.resumeMs = 0;
  if (session) { timing.runtimeId = runtimeId; return session; }
  runtimeId = crypto.randomUUID(); timing.runtimeId = runtimeId;
  harness = new DeepSeekHarness({ profile: 'sdk', dshHome: '/data/dsh-home', cwd: '/data/workspace', processCwd: '/data/workspace', patches: ['/app/gateway.cordis.yml'], provider: 'cloudflare-gateway', model: 'dsh-model', approvalRequests: true, env: { PATH: process.env.PATH, HOME: '/data', DSH_GATEWAY_PLACEHOLDER: 'cloudflare-binding-no-secret', DSH_TELEMETRY_DISABLED: '1', NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt' }, onUserQuestion: async () => ({ cancelled: true }), shutdownTimeoutMs: 15000, disposeEofGraceMs: 15000 });
  // Each SDK approval waits for the authenticated console owner; never auto-grant.
  harness.client.start();
  harness.client.onRequest((method, params) => method === 'approval/request' ? approvals.request(params, state.task?.id) : Promise.reject(new Error('Unsupported host request')));
  try {
    await timeStage(timing, 'initialize', () => harness.start());
    session = state.sessionId ? await timeStage(timing, 'resume', () => harness.resumeSession(state.sessionId)) : harness.session('primary');
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
  activeRunClock = null;
  try {
    const timing = state.task.timings = { version: 1, phase: 'prepare' };
    const prepareStarted = performance.now();
    const s = await getSession(timing);
    timing.prepareMs = performance.now() - prepareStarted;
    // The identity is fixed. Missing/incompatible stored sessions fail rather than reset history.
    state.sessionId = state.sessionId || 'primary'; await timeStage(timing, 'stateSave', save);
    timing.beforeRunAt = Date.now(); activeRunClock = performance.now(); timing.phase = 'agent';
    console.log('DSH_PREPARE_TIMING', JSON.stringify({ taskId: state.task.id, ...timing }));
    const result = await s.run(prompt);
    timing.agentMs = Date.now() - timing.beforeRunAt; timing.phase = 'finished';
    state.sessionId = result.sessionId;
    const terminal = result.events?.findLast(event => event.type === 'turn/end');
    const failed = result.finishReason === 'error';
    const error = failed ? (safeDiagnostic(terminal?.data?.reason) || result.finalResponse || 'DSH returned error without a terminal diagnostic; inspect AI Gateway logs.') : undefined;
    state.task = { ...state.task, status: failed ? 'failed' : result.finishReason === 'aborted' ? 'interrupted' : 'completed', response: result.finalResponse, finishReason: result.finishReason, ...(failed ? { error } : {}) };
    state.task = normalizeTask(state.task);
    if (state.task.status === 'failed') console.error('DSH task failed', state.task.id, state.task.error);
  } catch (e) {
    state.task = { ...state.task, status: 'failed', error: String(e.message).slice(0, 4000) };
    try { await closeHarness(); } catch (closeError) { state.task.error += '; Shutdown failed: ' + closeError.message; }
  }
  // Keep the initialized DSH runtime/session warm between tasks. /quiesce closes
  // it and drains persistence before any backup or filesystem snapshot.
  finally { try { await approvals.cancelAll(); state.task.finishedAt = Date.now(); await save(); } finally { busy = false; } }
}
const reply = (res, code, value) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/status') return reply(res, 200, { sessionId: state.sessionId, task: state.task, busy, historySupported: true, bridgeVersion: 'approvals-browser-run-v1', approvals: approvals.view(), runtimeReady: !!session, runElapsedMs: busy && activeRunClock !== null ? performance.now() - activeRunClock : null });
    if (req.method === 'GET' && req.url === '/history') return reply(res, 200, historyView(state));
    if (req.method === 'POST' && req.url === '/approvals/decide') {
      let text='';for await (const chunk of req){text+=chunk;if(text.length>2048)return reply(res,413,{error:'Too large'})}
      const body=JSON.parse(text);return reply(res,200,await approvals.decide(body.id,body.outcome));
    }
    if (req.method === 'POST' && req.url === '/quiesce') {
      if (busy) return reply(res, 409, { error: 'Task is running' });
      await closeHarness(); await save(); return reply(res, 200, { ready: true });
    }
    if (req.method === 'POST' && req.url === '/tasks') {
      if (busy) return reply(res, 409, { error: 'Task is running' });
      let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32768) return reply(res, 413, { error: 'Prompt too large' }); }
      const body = JSON.parse(text);
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || typeof body.id !== 'string') return reply(res, 400, { error: 'Invalid task' });
      if (busy) return reply(res, 409, { error: 'Task is running' });
      if (state.task?.id === body.id) return reply(res, 200, state.task);
      busy = true; state.task = { id: body.id, prompt: body.prompt, status: 'running', startedAt: Date.now() }; await save();
      reply(res, 202, state.task); void run(body.prompt); return;
    }
    reply(res, 404, { error: 'Not found' });
  } catch (e) { reply(res, 500, { error: String(e.message).slice(0, 2000) }); }
}).listen(8080, '0.0.0.0');
