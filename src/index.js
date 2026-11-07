import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import { DirectoryBackup } from '@cloudflare/sandbox';
import { page } from './page.js';
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
      if (!model || model.startsWith('@cf/')) throw new Error('Configure AI_MODEL as a Gateway catalog model or dynamic route (OpenAI chat format).');
      const output = await this.env.AI.run(model, input, { gateway: { id: this.env.AI_GATEWAY_ID || 'default', skipCache: true } });
      if (output instanceof Response) return output;
      if (output instanceof ReadableStream) return new Response(output, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
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
  constructor(ctx, env) {
    super(ctx, env);
    this.backups = new DirectoryBackup(ctx.container, ctx.exports.DirectoryBackupGateway, { binding: 'BACKUPS', prefix: 'dsh/' });
    if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => ctx.container.setInactivityTimeout(5 * MINUTE));
  }
  exclusive(fn) { const p = this.queue.then(fn); this.queue = p.catch(() => {}); return p; }
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
    if (fresh) {
      const lastTask = await this.ctx.storage.get('lastTask');
      if (lastTask?.status === 'running') throw new Error('Previous task lost its runtime. Inspect side effects and explicitly recover from R2; refusing automatic replay.');
      const checkpoint = await this.ctx.storage.get('checkpoint');
      const recovering = await this.ctx.storage.get('everStarted');
      if (recovering && !checkpoint) throw new Error('No saved checkpoint exists. Recovery requires inspection; refusing to start empty.');
      // Snapshot failure is explicit. Use the authenticated R2 recovery endpoint if expired.
      c.start({ ...(checkpoint?.snapshot ? { containerSnapshot: checkpoint.snapshot } : { image: c.images.dsh }), instance: 'standard-1', entrypoint: ['sleep', 'infinity'], enableInternet: false });
    }
    await c.setInactivityTimeout(5 * MINUTE);
    await c.interceptAllOutboundHttp(this.ctx.exports.Outbound);
    await c.interceptOutboundHttps('*', this.ctx.exports.Outbound);
    if (fresh) {
      await this.ctx.storage.put('everStarted', true);
      // Redirect all output to files: piped exec streams cannot outlive the request.
      await c.exec(['sh', '-c', 'exec node /app/server.mjs >>/data/bridge.log 2>&1'], { stdout: 'ignore', stderr: 'ignore' });
    }
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { const r = await this.bridge('/status'); if (r.ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('Bridge is not ready. Inspect container logs; no task was retried.');
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
      if (r.ok) await this.ctx.storage.put({ ['request:' + body.id]: task, lastTask: task });
      return Response.json(task, { status: r.status });
    });
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
        if (info.task) await this.ctx.storage.put({ lastTask: info.task, ['request:' + info.task.id]: info.task });
      }
      const cp = await this.ctx.storage.get('checkpoint');
      return { ...info, running: this.ctx.container.running, checkpointAt: cp?.at ?? null, checkpointError: await this.ctx.storage.get('checkpointError') ?? null, lastGatewayError: await this.ctx.storage.get('lastGatewayError') ?? null, modelConfig: { model: this.env.AI_MODEL || null, gateway: this.env.AI_GATEWAY_ID || 'default' } };
    });
  }
  async checkpoint() {
    await this.lifecycle.start();
    return this.exclusive(() => this.saveAndStop());
  }
  async saveAndStop() {
    const c = this.ctx.container;
    if (!c.running) return { saved: false, reason: 'already stopped' };
    const r = await this.bridge('/quiesce', {});
    if (!r.ok) throw new Error('Task is busy; checkpoint postponed');
    const info = await (await this.bridge('/status')).json();
    if (info.task) await this.ctx.storage.put({ lastTask: info.task, ['request:' + info.task.id]: info.task });
    const backup = await this.backups.backup({ dir: '/data' });
    await this.ctx.storage.put('latestBackup', backup);
    const snapshot = await c.snapshotContainer({ name: 'dsh-idle' });
    await this.ctx.storage.put('checkpoint', { snapshot, backup, image: c.images.dsh, at: Date.now() });
    await this.ctx.storage.delete('checkpointError');
    await c.destroy(); this.setup = undefined;
    return { saved: true };
  }
  async recover() {
    await this.lifecycle.start();
    return this.exclusive(async () => {
      if (this.ctx.container.running) throw new Error('Stop/checkpoint the live instance before recovery');
      const backup = await this.ctx.storage.get('latestBackup');
      if (!backup) throw new Error('No R2 backup exists');
      const c = this.ctx.container;
      c.start({ image: c.images.dsh, instance: 'standard-1', entrypoint: ['sleep', 'infinity'], enableInternet: false });
      await c.setInactivityTimeout(5 * MINUTE);
      try {
        await this.backups.restore(backup);
        const snapshot = await c.snapshotContainer({ name: 'r2-recovery' });
        await this.ctx.storage.put('checkpoint', { snapshot, backup, image: c.images.dsh, at: Date.now() });
        const previous = await this.ctx.storage.get('lastTask');
        if (previous?.status === 'running') {
          const interrupted = { ...previous, status: 'interrupted', error: 'Explicitly restored an older R2 backup. External side effects are not rolled back. No task was replayed.' };
          await this.ctx.storage.put({ lastTask: interrupted, ['request:' + previous.id]: interrupted });
        }
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
        if (info.task) await this.ctx.storage.put({ lastTask: info.task, ['request:' + info.task.id]: info.task });
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
      if (u.pathname === '/api/status' && request.method === 'GET') response = Response.json(await agent.status());
      else if (u.pathname === '/api/tasks' && request.method === 'POST') { if (Number(request.headers.get('content-length')) > 32768) return new Response('Too large', { status: 413 }); const text = await request.text(); if (text.length > 32768) return new Response('Too large', { status: 413 }); response = await agent.submit(JSON.parse(text)); }
      else if (u.pathname === '/api/checkpoint' && request.method === 'POST') response = Response.json(await agent.checkpoint());
      else if (u.pathname === '/api/recover' && request.method === 'POST') response = Response.json(await agent.recover());
      else response = new Response('Not found', { status: 404 });
      response.headers.set('cache-control', 'no-store'); return response;
    } catch (e) { return Response.json({ error: String(e.message).slice(0, 2000) }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
  }
};
