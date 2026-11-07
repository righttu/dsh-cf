import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import { DirectoryBackup } from '@cloudflare/sandbox';
import { page } from './page.js';
import { observeChatStream } from './model-stream.js';
export { DirectoryBackupGateway } from '@cloudflare/sandbox';
const MINUTE = 60000;
function diagnosticText(value) {
  return String(value ?? 'Unknown error').replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1600);
}

export class Outbound extends WorkerEntrypoint {
  async fetch(request) {
    const u = new URL(request.url);
    // This hostname is virtual: never forward container credentials or requests to OpenAI.
    if (u.protocol !== 'https:' || u.hostname !== 'api.openai.com' || u.pathname !== '/v1/chat/completions' || request.method !== 'POST') return new Response('Destination denied', { status: 403 });
    let stage = 'parse-request';
    try {
      const input = await request.json();
      delete input.model;
      const model = this.env.AI_MODEL;
      stage = 'ai-binding';
      const agent = this.env.DSH.getByName('owner');
      const call = await agent.beginModelCall().catch(() => null);
      if (!model || model.startsWith('@cf/')) throw new Error('Configure AI_MODEL as a Gateway catalog model or dynamic route (OpenAI chat format).');
      const output = await this.env.AI.run(model, input, { gateway: { id: this.env.AI_GATEWAY_ID || 'default', skipCache: true } });
      const report = update => call ? agent.modelProgress({ ...call, ...update }) : Promise.resolve();
      if (output instanceof Response) {
        if (output.ok && output.body && output.headers.get('content-type')?.includes('text/event-stream')) return new Response(observeChatStream(output.body, report), { status: output.status, headers: output.headers });
        return output;
      }
      if (output instanceof ReadableStream) return new Response(observeChatStream(output, report), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
      const text = output?.choices?.[0]?.message?.content;
      await report({ text: typeof text === 'string' ? text : '', done: true }).catch(() => {});
      return Response.json(output);
    } catch (e) {
      const failure = { at: Date.now(), stage, model: String(this.env.AI_MODEL || ''), gateway: String(this.env.AI_GATEWAY_ID || 'default'), message: diagnosticText(e?.message || e), code: e?.code == null ? null : diagnosticText(e.code), status: Number.isInteger(e?.status) ? e.status : null };
      // Never log request headers, prompt, tools or the complete error object.
      console.error('DSH_GATEWAY_FAILURE', JSON.stringify(failure));
      try { await this.env.DSH.getByName('owner').recordGatewayError(failure); } catch { console.error('DSH_GATEWAY_DIAGNOSTIC_PERSIST_FAILED'); }
      return Response.json({ error: { message: failure.message, type: 'gateway_error', code: failure.code } }, { status: 502 });
    }
  }
}

export class DshAgent extends DurableObject {
  lifecycle = Lifecycle.install(this);
  queue = Promise.resolve();
  setup;
  live = null;
  viewers = new Set();
  constructor(ctx, env) {
    super(ctx, env);
    this.backups = new DirectoryBackup(ctx.container, ctx.exports.DirectoryBackupGateway, { binding: 'BACKUPS', prefix: 'dsh/' });
    if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(5 * MINUTE));
  }
  exclusive(fn) { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
  async rememberTask(task) {
    const previous = await this.ctx.storage.get('lastTask');
    const values = { lastTask: task, ['request:' + task.id]: task };
    // Count idle time from task completion, never from polling or task start.
    if (task.status !== 'running' && (!previous || previous.id !== task.id || previous.status === 'running')) {
      values.lastActivity = Number.isFinite(task.finishedAt) ? Math.min(task.finishedAt, Date.now()) : Date.now();
    }
    await this.ctx.storage.put(values);
  }
  async bridge(path, body) {
    return this.ctx.container.getTcpPort(8080).fetch('http://container' + path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  }
  async ensure() {
    if (!this.setup || !this.ctx.container.running) this.setup = this.boot().catch(e => { this.setup = undefined; throw e; });
    await this.setup;
  }
  async boot() {
    const c = this.ctx.container;
    const fresh = !c.running;
    let bootMeasurement;
    if (fresh) {
      const lastTask = await this.ctx.storage.get('lastTask');
      if (lastTask?.status === 'running') throw new Error('Previous task lost its runtime. Inspect side effects and explicitly recover from R2; refusing automatic replay.');
      // A temporary safety snapshot protects live files during egress-policy migration.
      const checkpoint = await this.ctx.storage.get('routingRecovery') ?? await this.ctx.storage.get('checkpoint');
      const recovering = await this.ctx.storage.get('everStarted');
      if (recovering && !checkpoint) throw new Error('No saved checkpoint exists. Recovery requires inspection; refusing to start empty.');
      // Snapshot failure is explicit. Use the authenticated R2 recovery endpoint if expired.
      bootMeasurement = { kind: checkpoint?.snapshot ? 'snapshot' : 'image', snapshotId: checkpoint?.snapshot?.id || null, startedAt: Date.now() };
      c.start({ ...(checkpoint?.snapshot ? { containerSnapshot: checkpoint.snapshot } : { image: c.images.dsh }), instance: 'standard-1', entrypoint: ['sleep', 'infinity'], enableInternet: false });
    }
    await c.setInactivityTimeout(5 * MINUTE);
    // Specific backup target MUST precede the port-80 catch-all.
    await this.backups.intercept();
    await c.interceptAllOutboundHttp(this.ctx.exports.Outbound);
    await c.interceptOutboundHttps('*', this.ctx.exports.Outbound);
    if (fresh) {
      await this.ctx.storage.put({ everStarted: true, networkRevision: 2 });
      // Redirect all output to files: piped exec streams cannot outlive the request.
      await c.exec(['sh', '-c', 'exec node /app/server.mjs >>/data/bridge.log 2>&1'], { stdout: 'ignore', stderr: 'ignore' });
      bootMeasurement.execAcceptedMs = Date.now() - bootMeasurement.startedAt;
    }
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { const r = await this.bridge('/status'); if (r.ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Bridge is not ready. Inspect container logs; no task was retried.');
    if (bootMeasurement) { bootMeasurement.readyAt = Date.now(); bootMeasurement.serviceReadyMs = bootMeasurement.readyAt - bootMeasurement.startedAt; await this.ctx.storage.put('lastBoot', bootMeasurement); console.log('DSH_BOOT_TIMING', JSON.stringify(bootMeasurement)); }
    await this.lifecycle.jobs.push({ id: 'inspect', fn: 'inspect', time: Date.now() + MINUTE });
  }
  async submit(body) {
    await this.lifecycle.start();
    return this.exclusive(async () => {
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(body.id || '') || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000) return Response.json({ error: 'Invalid task' }, { status: 400 });
      const known = await this.ctx.storage.get('request:' + body.id);
      if (known) return Response.json(known);
      await this.ensure();
      const status = await (await this.bridge('/status')).json();
      if (status.busy) return Response.json({ error: 'Another task is running' }, { status: 409 });
      // Record intent before crossing the process boundary. An ambiguous response must not replay work.
      const intent = { id: body.id, status: 'submission-unknown', startedAt: Date.now() };
      await this.ctx.storage.put({ ['request:' + body.id]: intent, lastActivity: Date.now() });
      const r = await this.bridge('/tasks', body); const task = await r.json();
      if (r.ok) { this.live = null; await this.ctx.storage.put({ ['request:' + body.id]: task, lastTask: task }); }
      return Response.json(task, { status: r.status });
    });
  }
  async wake() {
    await this.lifecycle.start();
    return this.exclusive(async () => {
      if (this.ctx.container.running) return { started: false, reason: 'already running' };
      const cp = await this.ctx.storage.get('routingRecovery') ?? await this.ctx.storage.get('checkpoint');
      if (!cp?.snapshot) throw new Error('没有可启动的快照；本按钮不会用空环境冒充快照恢复。');
      await this.ctx.storage.put('lastActivity', Date.now());
      await this.ensure();
      return { started: true, measurement: await this.ctx.storage.get('lastBoot') };
    });
  }
  async beginModelCall() {
    return this.exclusive(async () => {
      let task = await this.ctx.storage.get('lastTask');
      let runtime = null;
      try { const r = await this.bridge('/status'); if (r.ok) { const info = await r.json(); if (info.task && info.task.id === task?.id) { task = info.task; runtime = info.task.timings || null; } } } catch {}
      const call = { taskId: task?.id || null, callId: crypto.randomUUID(), startedAt: Date.now(), taskStartedAt: task?.startedAt || null };
      const previous = await this.ctx.storage.get('responseTiming');
      const timing = previous?.taskId === call.taskId ? previous : { taskId: call.taskId, firstModelAt: call.startedAt, dispatchDelayMs: task?.startedAt ? call.startedAt - task.startedAt : null, runtime, runToModelMs: runtime?.beforeRunAt ? Math.max(0, call.startedAt - runtime.beforeRunAt) : null };
      if (previous?.taskId !== call.taskId) console.log('DSH_PREMODEL_BREAKDOWN', JSON.stringify({ taskId: task?.id, dispatchDelayMs: timing.dispatchDelayMs, runtime, runToModelMs: timing.runToModelMs }));
      await this.ctx.storage.put('responseTiming', timing);
      this.live = { ...call, ...timing, text: '', done: false };
      this.publishLive();
      return call;
    });
  }
  async modelProgress(update) {
    if (!this.live || update.callId !== this.live.callId || update.taskId !== this.live.taskId) return;
    this.live.text = String(update.text || '').slice(0, 160000);
    this.live.done = !!update.done;
    if (this.live.text && !this.live.firstTextAt) {
      this.live.firstTextAt = Date.now();
      this.live.firstTextMs = this.live.taskStartedAt ? this.live.firstTextAt - this.live.taskStartedAt : null;
      await this.ctx.storage.put('responseTiming', { taskId: this.live.taskId, firstModelAt: this.live.firstModelAt, dispatchDelayMs: this.live.dispatchDelayMs, firstTextAt: this.live.firstTextAt, firstTextMs: this.live.firstTextMs, runtime: this.live.runtime || null, runToModelMs: this.live.runToModelMs ?? null });
      console.log('DSH_RESPONSE_TIMING', JSON.stringify({ taskId: this.live.taskId, dispatchDelayMs: this.live.dispatchDelayMs, firstTextMs: this.live.firstTextMs }));
    }
    this.publishLive();
  }
  publishLive() {
    const bytes = new TextEncoder().encode('data: ' + JSON.stringify(this.live) + '\n\n');
    for (const controller of this.viewers) {
      try { if (controller.desiredSize <= 0) { controller.close(); this.viewers.delete(controller); } else controller.enqueue(bytes); }
      catch { this.viewers.delete(controller); }
    }
  }
  async events(taskId) {
    if (!this.ctx.container.running) return new Response('Container stopped', { status: 409 });
    // Transient view only. Closing this stream never cancels or replays a task.
    let controller, timer;
    const stream = new ReadableStream({
      start: c => {
        controller = c; this.viewers.add(c);
        c.enqueue(new TextEncoder().encode(': connected\n\n'));
        if (this.live?.taskId === taskId) c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(this.live) + '\n\n'));
        timer = setTimeout(() => { this.viewers.delete(c); try { c.close(); } catch {} }, 55000);
      },
      cancel: () => { clearTimeout(timer); this.viewers.delete(controller); }
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  }
  async recordGatewayError(failure) {
    await this.lifecycle.start();
    await this.ctx.storage.put('lastGatewayError', { at: Number(failure.at), stage: diagnosticText(failure.stage), model: diagnosticText(failure.model), gateway: diagnosticText(failure.gateway), message: diagnosticText(failure.message), code: failure.code == null ? null : diagnosticText(failure.code), status: Number.isInteger(failure.status) ? failure.status : null });
  }
  async status() {
    await this.lifecycle.start();
    return this.exclusive(async () => {
      let info = { task: await this.ctx.storage.get('lastTask') ?? null, busy: false };
      if (this.ctx.container.running) {
        info = await (await this.bridge('/status')).json();
        if (info.task) await this.rememberTask(info.task);
      }
      const cp = await this.ctx.storage.get('checkpoint');
      const latestBackup = await this.ctx.storage.get('latestBackup');
      const hasBackup = !!latestBackup;
      const backupAt = await this.ctx.storage.get('latestBackupAt') ?? (latestBackup?.id && latestBackup.id === cp?.backup?.id ? cp.at : null);
      const lastActivity = await this.ctx.storage.get('lastActivity');
      return { ...info, live: this.live?.taskId === info.task?.id ? this.live : null, lastBoot: await this.ctx.storage.get('lastBoot') ?? null, responseTiming: await this.ctx.storage.get('responseTiming') ?? null, hasBackup, backupAt, idleShutdownAt: this.ctx.container.running && !info.busy && lastActivity ? lastActivity + 10 * MINUTE : null, running: this.ctx.container.running, checkpointAt: cp?.at ?? null, checkpointError: await this.ctx.storage.get('checkpointError') ?? null, lastGatewayError: await this.ctx.storage.get('lastGatewayError') ?? null, modelConfig: { model: this.env.AI_MODEL || null, gateway: this.env.AI_GATEWAY_ID || 'default' } };
    });
  }
  async readHistory() {
    const r = await this.bridge('/history');
    if (r.status === 404) return { available: false, entries: [], total: 0, reason: '此容器仍使用旧版本，未提供任务历史。可先保存，再恢复备份以切换到新版容器；旧任务原文无法自动补齐。' };
    if (!r.ok) throw new Error('无法读取容器中的任务历史');
    const data = await r.json();
    if (!Array.isArray(data.entries)) throw new Error('历史数据格式不正确');
    return { available: true, entries: data.entries, total: data.total, sessionId: data.sessionId || null, readAt: Date.now() };
  }
  async history() {
    return this.exclusive(async () => {
      if (this.ctx.container.running) return { ...(await this.readHistory()), source: 'container' };
      const saved = await this.ctx.storage.get('checkpointHistory');
      return saved ? { ...saved, source: saved.restoredAt ? 'r2-restored' : 'saved', running: false }
        : { available: false, entries: [], total: 0, source: 'unknown', reason: '尚无可核验的历史记录。不会为查看历史自动启动容器。' };
    });
  }
  async checkpoint() {
    await this.lifecycle.start();
    return this.exclusive(async () => {
      try { return await this.saveAndStop(); }
      catch (e) { await this.ctx.storage.put('checkpointError', diagnosticText(e.message)); throw e; }
    });
  }
  async saveAndStop() {
    const c = this.ctx.container;
    if (!c.running) return { saved: false, reason: 'already stopped' };
    const r = await this.bridge('/quiesce', {});
    if (!r.ok) throw new Error('Task is busy; checkpoint postponed');
    const info = await (await this.bridge('/status')).json();
    if (info.task) await this.rememberTask(info.task);
    if (await this.ctx.storage.get('networkRevision') !== 2) {
      // Old containers already registered catch-all first; targets cannot be removed.
      // Quiesce above, durably store a safety snapshot, then restart from exactly it.
      const snapshot = await c.snapshotContainer({ name: 'before-backup-routing-fix' });
      await this.ctx.storage.put('routingRecovery', { snapshot, at: Date.now(), image: c.images.dsh });
      await c.destroy(); this.setup = undefined;
      await this.ensure();
      const quiet = await this.bridge('/quiesce', {});
      if (!quiet.ok) throw new Error('Restarted bridge is not quiescent; backup postponed');
    }
    const history = await this.readHistory();
    const backup = await this.backups.backup({ dir: '/data' });
    await this.ctx.storage.put({ latestBackup: backup, latestBackupAt: Date.now() });
    const snapshot = await c.snapshotContainer({ name: 'dsh-idle' });
    await this.ctx.storage.put('checkpoint', { snapshot, backup, image: c.images.dsh, at: Date.now() });
    await this.ctx.storage.put('checkpointHistory', history);
    await this.ctx.storage.delete('checkpointError');
    await this.ctx.storage.delete('routingRecovery');
    await c.destroy(); this.setup = undefined;
    return { saved: true };
  }
  async recover() {
    await this.lifecycle.start();
    return this.exclusive(async () => {
      const backup = await this.ctx.storage.get('latestBackup');
      if (!backup) throw new Error('No R2 backup exists');
      const c = this.ctx.container;
      if (c.running) {
        const info = await (await this.bridge('/status')).json();
        if (info.busy) throw new Error('任务正在执行，请等待结束后再恢复备份。');
        if (info.task) await this.rememberTask(info.task);
        const quiet = await this.bridge('/quiesce', {});
        if (!quiet.ok) throw new Error('无法安全停止 DSH，未覆盖任何文件。');
        // Protect the current files without replacing the R2 backup selected above.
        const snapshot = await c.snapshotContainer({ name: 'before-r2-restore' });
        await this.ctx.storage.put('routingRecovery', { snapshot, image: c.images.dsh, at: Date.now() });
        await c.destroy(); this.setup = undefined;
      }
      c.start({ image: c.images.dsh, instance: 'standard-1', entrypoint: ['sleep', 'infinity'], enableInternet: false });
      await c.setInactivityTimeout(5 * MINUTE);
      try {
        await this.backups.intercept();
        await this.backups.restore(backup);
        await c.exec(['sh', '-c', 'exec node /app/server.mjs >>/data/bridge.log 2>&1'], { stdout: 'ignore', stderr: 'ignore' });
        let restoredInfo;
        for (let i = 0; i < 40; i++) {
          try { const r = await this.bridge('/status'); if (r.ok) { restoredInfo = await r.json(); break; } } catch {}
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!restoredInfo) throw new Error('恢复后的文件无法核验；已保留恢复前的安全快照。');
        const history = await this.readHistory();
        const quiet = await this.bridge('/quiesce', {});
        if (!quiet.ok) throw new Error('恢复后的环境无法安全保存');
        const snapshot = await c.snapshotContainer({ name: 'r2-recovery' });
        await this.ctx.storage.put('checkpoint', { snapshot, backup, image: c.images.dsh, at: Date.now() });
        await this.ctx.storage.delete('routingRecovery');
        await this.ctx.storage.delete('checkpointError');
        await this.ctx.storage.put('checkpointHistory', { ...history, restoredAt: Date.now() });
        // The visible result must come from restored files, not the newer DO cache.
        await this.ctx.storage.put('lastTask', restoredInfo.task || null);
        await this.ctx.storage.delete('lastGatewayError');
        await this.ctx.storage.delete('responseTiming'); this.live = null;
      } finally { await c.destroy(); this.setup = undefined; }
      return { recovered: true, note: 'Next task starts DSH and validates session compatibility. No task was replayed.' };
    });
  }
  async onJob({ job }) {
    if (job.fn !== 'inspect') return;
    return this.exclusive(async () => {
      const c = this.ctx.container;
      if (!c.running) return;
      await c.setInactivityTimeout(5 * MINUTE);
      try {
        const info = await (await this.bridge('/status')).json();
        if (info.task) await this.rememberTask(info.task);
        const last = await this.ctx.storage.get('lastActivity') ?? 0;
        if (!info.busy && Date.now() - last > 10 * MINUTE) { await this.saveAndStop(); return; }
      } catch (e) { await this.ctx.storage.put('checkpointError', String(e.message)); }
      return { rescheduleAt: Date.now() + MINUTE };
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    // Runtime-verified Access identity, not a client-controlled email/JWT header.
    if (!ctx.access) return new Response('请先在 Cloudflare 为此 Worker 启用 Access（All traffic），仅允许你自己的邮箱使用 One-time PIN 登录。', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    const identity = await ctx.access.getIdentity();
    if (!identity?.email) return new Response('Email identity required', { status: 403 });
    const u = new URL(request.url);
    if (u.pathname === '/' && request.method === 'GET') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    if (request.method !== 'GET' && request.headers.get('origin') !== u.origin) return new Response('Origin required', { status: 403 });
    if (request.headers.get('origin') && request.headers.get('origin') !== u.origin) return new Response('Origin denied', { status: 403 });
    const agent = env.DSH.getByName('owner');
    try {
      let response;
      if (u.pathname === '/api/events' && request.method === 'GET') response = await agent.events(u.searchParams.get('taskId'));
      else if (u.pathname === '/api/wake' && request.method === 'POST') response = Response.json(await agent.wake());
      else if (u.pathname === '/api/history' && request.method === 'GET') response = Response.json(await agent.history());
      else if (u.pathname === '/api/status' && request.method === 'GET') response = Response.json(await agent.status());
      else if (u.pathname === '/api/tasks' && request.method === 'POST') { if (Number(request.headers.get('content-length')) > 32768) return new Response('Too large', { status: 413 }); const text = await request.text(); if (text.length > 32768) return new Response('Too large', { status: 413 }); response = await agent.submit(JSON.parse(text)); }
      else if (u.pathname === '/api/checkpoint' && request.method === 'POST') response = Response.json(await agent.checkpoint());
      else if (u.pathname === '/api/recover' && request.method === 'POST') response = Response.json(await agent.recover());
      else response = new Response('Not found', { status: 404 });
      response.headers.set('cache-control', 'no-store'); return response;
    } catch (e) { return Response.json({ error: String(e.message).slice(0, 2000) }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
  }
};
