import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { Lifecycle } from 'agents/lifecycle';
import { DirectoryBackup } from '@cloudflare/sandbox';
import { page } from './page.js';
import { normalizeTask } from '../container/history.mjs';
import { previewServer, previewHeaders } from './preview.js';
import { observeChatStream, chatResponseMeta, chatRequestMeta } from './model-stream.js';
import { checkWebsite } from './browser-check.js';
export { DirectoryBackupGateway } from '@cloudflare/sandbox';
export function validateInstance(value) {
  if(typeof value==='string') { if(!['lite','standard-1','standard-2','standard-3','standard-4'].includes(value))throw Error('不支持的实例规格'); return value; }
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('请输入实例规格');
  const {vcpu,memoryMib,diskMb}=value;
  if(!Number.isInteger(vcpu)||vcpu<1||vcpu>4||!Number.isInteger(memoryMib)||memoryMib<vcpu*3072||memoryMib>12288||!Number.isInteger(diskMb)||diskMb<1||diskMb>20000)throw Error('自定义规格需 1–4 个整数 vCPU，每 vCPU 至少 3072 MiB 内存，总内存不超过 12288 MiB，磁盘不超过 20000 MB');
  return {vcpu,memoryMib,diskMb};
}
const MINUTE = 60000;
// Observed execution phase, NOT CPU telemetry or a billing estimate.
export function taskPhaseFor(info,models,lease,now=Date.now()) {
  const task=info.task;if(task?.status!=='running')return null;
  const phase=(kind,label,detail,since)=>({taskId:task.id,kind,label,detail,since:Number.isFinite(since)?since:null,observedAt:now});
  const pending=(info.approvals||[]).filter(a=>a.status==='pending'&&a.expiresAt>now&&(!a.taskId||a.taskId===task.id));
  if(pending.length)return phase('approval','等待你的授权','有工具操作等待本次授权，请核对并处理权限申请。',Math.min(...pending.map(a=>a.at).filter(Number.isFinite)));
  if(lease?.taskId===task.id&&lease.expiresAt>now)return phase('browser','等待浏览器检查结果','正在准备或执行 Cloudflare Browser Run 检查与截图。',lease.startedAt);
  const calls=models?.taskId===task.id?(models.calls||[]).filter(c=>c.startedAt>now-15*MINUTE):[];
  if(calls.length)return phase('model','模型请求进行中','',Math.min(...calls.map(c=>c.startedAt)));
  if(info.runtimeReady===false)return phase('preparing','正在准备 Agent','正在初始化或恢复 Agent 会话。',task.startedAt);
  return phase('executing','Agent 正在执行','正在执行或处理工具结果；当前没有已确认的外部等待事件。',null);
}
// Wall-clock phase sampling; never infer CPU idle time from these measurements.
export function advanceTaskWait(previous,task,phase,now=Date.now()) {
  if(!previous||previous.taskId!==task?.id)return null;
  if(previous.finishedAt)return previous;
  const end=task.status!=='running'&&Number.isFinite(task.finishedAt)?Math.min(now,task.finishedAt):now;
  const next=structuredClone(previous),at=Math.max(previous.lastObservedAt,end),delta=at-previous.lastObservedAt;
  const kinds=['model','browser','approval','other','unobserved'];
  const key=delta>3000?'unobserved':kinds.includes(previous.phase)?previous.phase:'unobserved';
  next.ms[key]=(next.ms[key]||0)+delta;next.lastObservedAt=at;
  next.phase=phase&&['model','browser','approval'].includes(phase.kind)?phase.kind:'other';
  if(task.status!=='running')next.finishedAt=at;
  return next;
}
export function taskWaitView(stats) {
  if(!stats)return null;const totalMs=Math.max(0,(stats.finishedAt||stats.lastObservedAt)-stats.startedAt),unobservedMs=stats.ms.unobserved||0;
  const waitMs=(stats.ms.model||0)+(stats.ms.browser||0)+(stats.ms.approval||0),coverage=totalMs?Math.max(0,1-unobservedMs/totalMs):0;
  return {taskId:stats.taskId,totalMs,waitMs,coverage,ratio:totalMs>0&&coverage>=0.9?Math.min(1,waitMs/totalMs):null,modelMs:stats.ms.model||0,browserMs:stats.ms.browser||0,approvalMs:stats.ms.approval||0,unobservedMs,estimated:true,finished:!!stats.finishedAt};
}
function diagnosticText(value) {
  return String(value ?? 'Unknown error').replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1600);
}

export class Outbound extends WorkerEntrypoint {
  async fetch(request) {
    const u = new URL(request.url);
    if(u.origin==='https://dsh-selfcheck.internal'&&u.pathname==='/check'&&request.method==='POST') {
      const text=await request.text();if(text.length>2048)return new Response('Too large',{status:413});
      try{return Response.json(await this.ctx.exports.BrowserCheck.check(JSON.parse(text)))}catch(e){return Response.json({error:String(e.message).slice(0,1200)},{status:503})}
    }
    // This hostname is virtual: never forward container credentials or requests to OpenAI.
    if (u.protocol !== 'https:' || u.hostname !== 'api.openai.com' || u.pathname !== '/v1/chat/completions' || request.method !== 'POST') return new Response('Destination denied', { status: 403 });
    let stage = 'parse-request', call = null;
    try {
      const input = await request.json();
      delete input.model;
      const model = this.env.AI_MODEL;
      stage = 'ai-binding';
      const agent = this.env.DSH.getByName('owner');
      call = await agent.beginModelCall().catch(() => null);
      console.log('DSH_MODEL_REQUEST_META',JSON.stringify({taskId:call?.taskId||null,sessionId:call?.sessionId||null,callIndex:call?.callIndex||null,...chatRequestMeta(input)}));
      if (!model || model.startsWith('@cf/')) throw new Error('Configure AI_MODEL as a Gateway catalog model or dynamic route (OpenAI chat format).');
      const output = await this.env.AI.run(model, input, { gateway: { id: this.env.AI_GATEWAY_ID || 'default', skipCache: true } });
      const report = update => call ? agent.modelProgress({ ...call, ...update }) : Promise.resolve();
      const reportMeta = metadata => console.log('DSH_MODEL_RESULT_META', JSON.stringify({ taskId: call?.taskId ?? null, ...metadata }));
      if (output instanceof Response) {
        console.log('DSH_MODEL_RESPONSE_META', JSON.stringify({ taskId: call?.taskId ?? null, status: output.status, eventStream: !!output.headers.get('content-type')?.includes('text/event-stream') }));
        if (output.ok && output.body && output.headers.get('content-type')?.includes('text/event-stream')) return new Response(observeChatStream(output.body, report, reportMeta), { status: output.status, headers: output.headers });
        if (output.headers.get('content-type')?.includes('application/json')) {
          try { reportMeta(chatResponseMeta(await output.clone().json())); } catch {}
        }
        await report({text:'',done:true}).catch(()=>{});
        return output;
      }
      if (output instanceof ReadableStream) return new Response(observeChatStream(output, report, reportMeta), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
      reportMeta(chatResponseMeta(output));
      const text = output?.choices?.[0]?.message?.content;
      await report({ text: typeof text === 'string' ? text : '', done: true }).catch(() => {});
      return Response.json(output);
    } catch (e) {
      if(call)try{await this.env.DSH.getByName('owner').modelProgress({...call,text:'',done:true})}catch{}
      const failure = { at: Date.now(), stage, model: String(this.env.AI_MODEL || ''), gateway: String(this.env.AI_GATEWAY_ID || 'default'), message: diagnosticText(e?.message || e), code: e?.code == null ? null : diagnosticText(e.code), status: Number.isInteger(e?.status) ? e.status : null };
      // Never log request headers, prompt, tools or the complete error object.
      console.error('DSH_GATEWAY_FAILURE', JSON.stringify(failure));
      try { await this.env.DSH.getByName('owner').recordGatewayError(failure); } catch { console.error('DSH_GATEWAY_DIAGNOSTIC_PERSIST_FAILED'); }
      return Response.json({ error: { message: failure.message, type: 'gateway_error', code: failure.code } }, { status: 502 });
    }
  }
}

// No public route: invocation-local Fetcher scoped to one preview capability.
export class BrowserSite extends WorkerEntrypoint {
  async fetch(request) {
    const u=new URL(request.url),p=this.ctx.props;
    if(request.method!=='GET'||u.origin!=='http://dsh-site.test'||!p?.id||p.expiresAt<Date.now())return new Response('Denied',{status:403});
    return this.env.DSH.getByName('owner').previewFile(p.id,u.pathname.slice(1));
  }
}
export class BrowserCheck extends WorkerEntrypoint {
  async check(body) {
    if(!body||typeof body.root!=='string'||!body.root||body.root==='.')throw Error('请输入网站子目录');
    const agent=this.env.DSH.getByName('owner');const token=await agent.acquireSiteCheck();
    try{
      const config=await agent.previewStart({root:body.root});
      const site=this.ctx.exports.BrowserSite({props:{id:config.id,expiresAt:Date.now()+120000}});
      const result=await checkWebsite(this.env.BROWSER,site);
      const summary={at:result.report.finishedAt,passed:result.report.passed,failedStage:result.report.failedStage||null,failureKind:result.report.failureKind||null,screenshots:result.report.screenshots.length,
        failures:result.report.checks.filter(c=>!c.passed).map(c=>({name:c.name,error:diagnosticText(c.error).replace(/https?:\/\/\S+/g,'[url]')})).slice(0,8)};
      await agent.recordBrowserCheck(summary);
      console.log('DSH_BROWSER_CHECK',JSON.stringify(summary));
      return result;
    }finally{await agent.releaseSiteCheck(token)}
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
  async assertVersionIdle() { if (await this.ctx.storage.get('versionOperation')) throw Error('环境操作尚未完成，请先恢复操作前环境；不会自动重试或重放任务。'); }
  async ensure() {
    await this.assertVersionIdle();
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
      c.start({ ...(checkpoint?.snapshot ? { containerSnapshot: checkpoint.snapshot } : { image: c.images[(await this.ctx.storage.get('selectedVersion')) === 'v2' ? 'v2' : 'dsh'] }), instance: validateInstance(checkpoint?.instance || (await this.ctx.storage.get('selectedInstance')) || 'standard-1'), entrypoint: ['sleep', 'infinity'], enableInternet: false });
      await this.ctx.storage.put('activeInstance',checkpoint?.instance || (await this.ctx.storage.get('selectedInstance')) || 'standard-1');
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
  async prepareDemoFiles(info) {
    if(info.busy||info.approvals?.some(a=>a.status==='pending'))throw Error('任务或审批正在执行，请结束后再准备演示。');
    if(info.demoEnvironmentVersion!==1)throw Error('运行环境尚未更新。请先点击“更新运行镜像”，确认保存并迁移后再准备演示。本次未调用模型。');
    const r=await this.bridge('/demo/prepare',{}),result=await r.json();
    if(!r.ok||result.ready!==true)throw Error(result.error||'演示环境准备未完成，本次未调用模型。');
    await this.ctx.storage.put('lastActivity',Date.now());return result;
  }
  async prepareDemo() {
    await this.lifecycle.start();return this.exclusive(async()=>{await this.ensure();return this.prepareDemoFiles(await (await this.bridge('/status')).json())});
  }
  async submit(body) {
    await this.lifecycle.start();
    return this.exclusive(async () => {
      if (!/^[a-zA-Z0-9-]{16,80}$/.test(body.id || '') || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000) return Response.json({ error: 'Invalid task' }, { status: 400 });
      const known = await this.ctx.storage.get('request:' + body.id);
      if (known) return Response.json(known);
      await this.ensure();
      const status = await (await this.bridge('/status')).json();
      if(body.sessionId && body.sessionId!==status.sessionId)return Response.json({error:'当前会话已变化，请刷新后核对再提交'},{status:409});
      if (status.busy) return Response.json({ error: 'Another task is running' }, { status: 409 });
      if(body.demo==='web-deck-v1')await this.prepareDemoFiles(status);
      // Record intent before crossing the process boundary. An ambiguous response must not replay work.
      const intent = { id: body.id, status: 'submission-unknown', startedAt: Date.now() };
      await this.ctx.storage.put({ ['request:' + body.id]: intent, lastActivity: Date.now(), taskTimingStart: { id: body.id, acceptedAt: intent.startedAt }, taskWaitMetrics:{taskId:body.id,startedAt:intent.startedAt,lastObservedAt:intent.startedAt,phase:'unobserved',ms:{model:0,browser:0,approval:0,other:0,unobserved:0}} });
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
  async previewStart(body) {
    const root = body?.root === '.' ? '' : body?.root;
    if (typeof root !== 'string' || root.length > 240 || root.startsWith('/') || root.includes('\\') || root.split('/').some(x => x.startsWith('.'))) throw new Error('请输入工作区内的相对目录，例如 coffee-site 或 dist；工作区根目录填 .');
    await this.lifecycle.start();
    return this.exclusive(async () => {
      await this.ensure();
      const secret = await this.ctx.storage.get('previewSecret') || crypto.randomUUID();
      await this.ctx.storage.put('previewSecret', secret);
      const port = this.ctx.container.getTcpPort(8090);
      const options = { headers: { 'x-dsh-preview': secret } };
      let ready = false;
      try { const r = await port.fetch('http://preview/_health', options); ready = r.ok && await r.text() === 'dsh-static-preview-v1'; } catch {}
      if (!ready) {
        await this.ctx.container.exec(['node', '--input-type=module', '-e', previewServer], { env: { DSH_PREVIEW_SECRET: secret }, stdout: 'ignore', stderr: 'ignore' });
        for (let i = 0; i < 30; i++) {
          try { const r = await port.fetch('http://preview/_health', options); if (r.ok && await r.text() === 'dsh-static-preview-v1') { ready = true; break; } } catch {}
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (!ready) throw new Error('预览服务未启动；8090 端口可能已被占用。未停止或替换任何已有服务。');
      const r = await port.fetch('http://preview/_configure', { method: 'POST', headers: { ...options.headers, 'content-type': 'application/json' }, body: JSON.stringify({ root }) });
      if (!r.ok) throw new Error('目录不可预览：请确认目录存在、含 index.html，且文件位于 /data/workspace 内。');
      const probe = await port.fetch('http://preview/index.html', options);
      if (!probe.ok) throw new Error('入口 HTTP 检查失败，演示未开放。');
      const checks = [{ name: '目录与入口安全校验', passed: true }, { name: '入口 HTTP 200', passed: true }];
      const config = { id: crypto.randomUUID(), root: root || '.', at: Date.now(), expiresAt: Date.now() + 60 * MINUTE }; 
      await this.ctx.storage.put({ previewConfig: config, lastActivity: Date.now() });
      return { ...config, checks, url: '/preview/' + config.id + '/index.html' };
    });
  }
  async previewFile(id, pathname) {
    return this.exclusive(async () => {
      const config = await this.ctx.storage.get('previewConfig');
      if (!config || config.id !== id || !config.expiresAt || Date.now() >= config.expiresAt) return new Response('预览已关闭或已更新，请在工作台重新打开。', { status: 404 });
      if (!this.ctx.container.running) return new Response('环境已休眠。请回工作台点击打开预览；不会为旧链接自动启动容器。', { status: 409 });
      const secret = await this.ctx.storage.get('previewSecret');
      // Only GET on the dedicated static server; never proxy the DSH bridge or caller headers.
      let response;
      try { response = await this.ctx.container.getTcpPort(8090).fetch('http://preview/' + pathname, { headers: { 'x-dsh-preview': secret } }); }
      catch { return new Response('预览进程已停止，请回工作台重新打开预览。', { status: 503 }); }
      if (response.ok) await this.ctx.storage.put('lastActivity', Date.now());
      return new Response(response.body, { status: response.status, headers: { ...previewHeaders(), 'content-type': response.headers.get('content-type') || 'text/plain; charset=utf-8' } });
    });
  }
  async previewClose() {
    return this.exclusive(async () => {
      await this.ctx.storage.delete('previewConfig');
      if (this.ctx.container.running) {
        const secret = await this.ctx.storage.get('previewSecret');
        try { await this.ctx.container.getTcpPort(8090).fetch('http://preview/_configure', { method: 'POST', headers: { 'x-dsh-preview': secret }, body: JSON.stringify({ root: null }) }); } catch {}
      }
      return { closed: true };
    });
  }
  async beginModelCall() {
    return this.exclusive(async () => {
      let task = await this.ctx.storage.get('lastTask');
      let runtime = null, runToModelMs = null;
      try { const r = await this.bridge('/status'); if (r.ok) { const info = await r.json(); if (info.task && info.task.id === task?.id) { task = info.task; runtime = info.task.timings || null; runToModelMs = Number.isFinite(info.runElapsedMs) ? info.runElapsedMs : null; } } } catch {}
      const anchor = await this.ctx.storage.get('taskTimingStart');
      const taskStartedAt = anchor?.id === task?.id && Number.isFinite(anchor?.acceptedAt) ? anchor.acceptedAt : null;
      const call = { taskId: task?.id || null, sessionId: task?.sessionId || null, callId: crypto.randomUUID(), startedAt: Date.now(), taskStartedAt };
      const previous = await this.ctx.storage.get('responseTiming');
      const timing = previous?.taskId === call.taskId && previous.timingVersion === 2 ? previous : { timingVersion: 2, taskId: call.taskId, firstModelAt: call.startedAt, dispatchDelayMs: taskStartedAt != null ? call.startedAt - taskStartedAt : null, runtime, runToModelMs };
      if (previous?.taskId !== call.taskId) console.log('DSH_PREMODEL_BREAKDOWN', JSON.stringify({ taskId: task?.id, dispatchDelayMs: timing.dispatchDelayMs, runtime, runToModelMs: timing.runToModelMs }));
      call.callIndex=(timing.modelCalls||0)+1;timing.modelCalls=call.callIndex;
      await this.ctx.storage.put('responseTiming', timing);
      const models=await this.ctx.storage.get('modelActivity');
      if(models?.taskId!==call.taskId)this.modelPhaseSeen=new Set();
      const calls=models?.taskId===call.taskId?(models.calls||[]).filter(c=>c.startedAt>Date.now()-15*MINUTE):[];
      if(call.taskId)await this.ctx.storage.put('modelActivity',{taskId:call.taskId,calls:[...calls,{callId:call.callId,startedAt:call.startedAt}].slice(-32)});
      this.live = { ...call, ...timing, text: '', done: false };
      this.publishLive();
      return call;
    });
  }
  async modelProgress(update) {
    this.modelPhaseSeen??=new Set();
    if(update.done||(update.text&&!this.modelPhaseSeen.has(update.callId))){
      this.modelPhaseSeen.add(update.callId);
      await this.exclusive(async()=>{const models=await this.ctx.storage.get('modelActivity');if(models?.taskId!==update.taskId)return;const found=models.calls?.find(c=>c.callId===update.callId);if(!found)return;if(update.done)models.calls=models.calls.filter(c=>c.callId!==update.callId);else found.responseStartedAt=Date.now();await this.ctx.storage.put('modelActivity',models)});
      if(update.done)this.modelPhaseSeen.delete(update.callId);
    }
    if (!this.live || update.callId !== this.live.callId || update.taskId !== this.live.taskId) return;
    this.live.text = String(update.text || '').slice(0, 160000);
    this.live.done = !!update.done;
    if (this.live.text && !this.live.firstTextAt) {
      this.live.firstTextAt = Date.now();
      this.live.firstTextMs = this.live.taskStartedAt ? this.live.firstTextAt - this.live.taskStartedAt : null;
      await this.ctx.storage.put('responseTiming', { timingVersion: 2, taskId: this.live.taskId, firstModelAt: this.live.firstModelAt, dispatchDelayMs: this.live.dispatchDelayMs, firstTextAt: this.live.firstTextAt, firstTextMs: this.live.firstTextMs, runtime: this.live.runtime || null, runToModelMs: this.live.runToModelMs ?? null });
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
  async acquireSiteCheck() {
    return this.exclusive(async()=>{const now=Date.now(),lease=await this.ctx.storage.get('siteCheckLease');if(lease?.expiresAt>now)throw Error('网站自检正在执行，请勿并发调用');const token=crypto.randomUUID();const task=await this.ctx.storage.get('lastTask');await this.ctx.storage.put('siteCheckLease',{token,taskId:task?.id||null,startedAt:now,expiresAt:now+180000});return token});
  }
  async recordBrowserCheck(summary) {
    return this.exclusive(async()=>{const task=await this.ctx.storage.get('lastTask');await this.ctx.storage.put('lastBrowserCheck',{...summary,taskId:task?.id||null});});
  }
  async releaseSiteCheck(token) {
    return this.exclusive(async()=>{const lease=await this.ctx.storage.get('siteCheckLease');if(lease?.token===token)await this.ctx.storage.delete('siteCheckLease')});
  }
  async decideApproval(body) {
    if(!body || typeof body.id!=='string' || !['allowed-once','rejected'].includes(body.outcome))throw Error('无效权限答复');
    return this.exclusive(async()=>{
      if(!this.ctx.container.running)throw Error('环境已停止，权限申请失效');
      const r=await this.bridge('/approvals/decide',body);const result=await r.json();if(!r.ok)throw Error(result.error||'权限答复失败');return result;
    });
  }
  async changeSession(body) {
    if (!body || !['create','select','delete'].includes(body.action) || typeof body.id !== 'string' || body.id.length>100) throw Error('无效会话操作');
    await this.lifecycle.start();
    return this.exclusive(async()=>{
      await this.ensure();
      const status=await (await this.bridge('/status')).json();
      if(status.busy)throw Error('任务正在执行，请结束后再切换会话');
      if(!status.sessionsSupported)throw Error('当前容器尚不支持独立会话。请先成功保存，再从 R2 恢复到新版镜像；未改动当前会话。');
      if(body.action==='delete'&&!status.sessionDeletionSupported)throw Error('当前镜像不支持删除会话，请先切换新版镜像。');
      const r=await this.bridge('/sessions',body), data=await r.json();
      if(!r.ok)throw Error(data.error||'切换会话失败');
      if(body.action==='delete'){const keys=(data.deletedTaskIds||[]).filter(id=>typeof id==='string').map(id=>'request:'+id);for(let i=0;i<keys.length;i+=128)await this.ctx.storage.delete(keys.slice(i,i+128));}
      const latest=await (await this.bridge('/status')).json();
      await this.ctx.storage.put({lastTask:latest.task||null,lastActivity:Date.now()});
      await this.ctx.storage.delete(['responseTiming','lastGatewayError']);this.live=null;
      return data;
    });
  }
  async status() {
    await this.lifecycle.start();
    return this.exclusive(async () => {
      let info = { task: await this.ctx.storage.get('lastTask') ?? null, busy: false };
      if (this.ctx.container.running) {
        info = await (await this.bridge('/status')).json();
        if (info.task) { info.task = normalizeTask(info.task); await this.rememberTask(info.task); }
      }
      if(!this.ctx.container.running){const saved=await this.ctx.storage.get('checkpointHistory');info={...info,sessionId:saved?.sessionId||null,sessions:saved?.sessions||[],sessionsSupported:!!saved?.sessionsSupported};}
      info.task = normalizeTask(info.task);
      const cp = await this.ctx.storage.get('checkpoint');
      const latestBackup = await this.ctx.storage.get('latestBackup');
      const hasBackup = !!latestBackup;
      const backupAt = await this.ctx.storage.get('latestBackupAt') ?? (latestBackup?.id && latestBackup.id === cp?.backup?.id ? cp.at : null);
      const lastActivity = await this.ctx.storage.get('lastActivity');
      const preview = await this.ctx.storage.get('previewConfig');
      const activePreview = this.ctx.container.running && preview?.expiresAt > Date.now() ? { ...preview, url: '/preview/' + preview.id + '/index.html' } : null;
      const taskPhase=this.ctx.container.running?taskPhaseFor(info,await this.ctx.storage.get('modelActivity'),await this.ctx.storage.get('siteCheckLease')):null;
      const previousWait=await this.ctx.storage.get('taskWaitMetrics');
      const waitStats=advanceTaskWait(previousWait,info.task,taskPhase);
      if(waitStats&&!previousWait?.finishedAt)await this.ctx.storage.put('taskWaitMetrics',waitStats);
      return { ...info, taskPhase, taskWait:taskWaitView(waitStats), environmentProgress: await this.ctx.storage.get('environmentProgress') || null, instance: {current: this.ctx.container.running ? (await this.ctx.storage.get('activeInstance')) || 'standard-1' : cp?.instance || 'standard-1', source: this.ctx.container.running ? 'startup-config' : 'checkpoint'}, versions: await this.versions(info), lastBrowserCheck: await this.ctx.storage.get('lastBrowserCheck') ?? null, preview: activePreview, live: this.live?.taskId === info.task?.id ? this.live : null, lastBoot: await this.ctx.storage.get('lastBoot') ?? null, responseTiming: await this.ctx.storage.get('responseTiming') ?? null, hasBackup, backupAt, idleShutdownAt: this.ctx.container.running && !info.busy && lastActivity ? lastActivity + 10 * MINUTE : null, running: this.ctx.container.running, checkpointAt: cp?.at ?? null, checkpointError: await this.ctx.storage.get('checkpointError') ?? null, lastGatewayError: await this.ctx.storage.get('lastGatewayError') ?? null, modelConfig: { model: this.env.AI_MODEL || null, gateway: this.env.AI_GATEWAY_ID || 'default' } };
    });
  }
  async readHistory() {
    const r = await this.bridge('/history');
    if (r.status === 404) return { available: false, entries: [], total: 0, reason: '此容器仍使用旧版本，未提供任务历史。可先保存，再恢复备份以切换到新版容器；旧任务原文无法自动补齐。' };
    if (!r.ok) throw new Error('无法读取容器中的任务历史');
    const data = await r.json();
    if (!Array.isArray(data.entries)) throw new Error('历史数据格式不正确');
    return { available: true, sessions: data.sessions || [], sessionsSupported: !!data.sessionsSupported, entries: data.entries.map(normalizeTask), total: data.total, sessionId: data.sessionId || null, readAt: Date.now() };
  }
  async history() {
    return this.exclusive(async () => {
      if (this.ctx.container.running) return { ...(await this.readHistory()), source: 'container' };
      const saved = await this.ctx.storage.get('checkpointHistory');
      return saved ? { ...saved, entries: saved.entries?.map(normalizeTask) || [], source: saved.restoredAt ? 'r2-restored' : 'saved', running: false }
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
  async saveAndStop({ stop = true, onProgress = async () => {} } = {}) {
    await this.assertVersionIdle();
    const c = this.ctx.container;
    if (!c.running) return { saved: false, reason: 'already stopped' };
    await onProgress('quiescing');
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
    await onProgress('backing-up');
    const backup = await this.backups.backup({ dir: '/data' });
    await this.ctx.storage.put({ latestBackup: backup, latestBackupAt: Date.now() });
    await onProgress('safety-snapshot');
    const snapshot = await c.snapshotContainer({ name: stop ? 'dsh-idle' : 'dsh-manual' });
    await this.ctx.storage.put('checkpoint', { snapshot, backup, image: info.runtimeVersion === 'v2' ? c.images.v2 : c.images.dsh, instance: (await this.ctx.storage.get('activeInstance')) || 'standard-1', runtimeVersion: info.runtimeVersion || null, nodeVersion: info.nodeVersion || null, at: Date.now() });
    await this.ctx.storage.put('checkpointHistory', history);
    await this.ctx.storage.delete('checkpointError');
    await this.ctx.storage.delete('routingRecovery');
    if (stop) { await onProgress('stopping'); await c.destroy(); this.setup = undefined; }
    return { saved: true, running: c.running };
  }
  async createSnapshot() {
    await this.lifecycle.start();
    return this.exclusive(async()=>{
      const lease=await this.ctx.storage.get('siteCheckLease');
      if(lease?.expiresAt>Date.now())throw Error('浏览器自检中，请结束后再创建快照。');
      if(!this.ctx.container.running)throw Error('环境已停止；请先唤醒，未创建空快照。');
      return this.saveAndStop({stop:false});
    });
  }
  async restart(body) {
    if(body?.confirm!==true)throw Error('请确认从已保存快照重启。');
    await this.lifecycle.start();
    return this.exclusive(async()=>{
      await this.assertVersionIdle();
      const cp=await this.ctx.storage.get('checkpoint');
      if(!cp?.snapshot)throw Error('请先创建快照，再重启。');
      if(body.checkpointAt!==cp.at)throw Error('快照已变化，请刷新并重新确认。');
      const lease=await this.ctx.storage.get('siteCheckLease');
      if(lease?.expiresAt>Date.now())throw Error('浏览器自检中，请结束后再重启。');
      const c=this.ctx.container;
      if(!c.running)throw Error('环境已停止，请使用快照唤醒。');
      const response=await this.bridge('/status');if(!response.ok)throw Error('无法确认任务状态，未停止环境。');
      const info=await response.json();
      if(info.busy||info.approvals?.some(a=>a.status==='pending'))throw Error('任务或审批中，请结束后再重启。');
      const quiet=await this.bridge('/quiesce',{});if(!quiet.ok)throw Error('环境无法安全停止。');
      const history=await this.readHistory();
      const safety={snapshot:await c.snapshotContainer({name:'before-manual-restart'}),instance:(await this.ctx.storage.get('activeInstance'))||'standard-1',runtimeVersion:info.runtimeVersion||null,nodeVersion:info.nodeVersion||null,at:Date.now(),history};
      const op={id:crypto.randomUUID(),kind:'restart',stage:'starting',startedAt:Date.now(),safety};
      await this.ctx.storage.put('versionOperation',op);
      try {
        await c.destroy();this.setup=undefined;
        await this.ctx.storage.put('routingRecovery',null);
        this.setup=this.boot().catch(e=>{this.setup=undefined;throw e});await this.setup;
        const r=await this.bridge('/status');if(!r.ok)throw Error('重启后状态无法读取');
        const restored=await r.json(), restoredHistory=await this.readHistory();
        if(cp.runtimeVersion&&restored.runtimeVersion!==cp.runtimeVersion)throw Error('重启后的版本与快照不符');
        const measurement=await this.ctx.storage.get('lastBoot');
        await this.ctx.storage.put({lastTask:restored.task||null,checkpointHistory:restoredHistory,lastActivity:Date.now(),responseTiming:null,previewConfig:null,versionOperation:null,lastRestartSafety:safety});
        this.live=null;
        return {restarted:true,measurement};
      }catch(e){
        try { if(c.running)await c.destroy(); } catch {} this.setup=undefined;
        await this.ctx.storage.put('versionOperation',{...op,error:diagnosticText(e.message)});
        throw Error('重启未完成：'+diagnosticText(e.message)+'。请先恢复操作前环境，不要重复提交。');
      }
    });
  }
  async recover() {
    await this.lifecycle.start();
    return this.exclusive(async () => {
      await this.assertVersionIdle();
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
      c.start({ image: c.images[(await this.ctx.storage.get('selectedVersion')) === 'v2' ? 'v2' : 'dsh'], instance: validateInstance((await this.ctx.storage.get('selectedInstance')) || 'standard-1'), entrypoint: ['sleep', 'infinity'], enableInternet: false });
      await this.ctx.storage.put('activeInstance',(await this.ctx.storage.get('selectedInstance'))||'standard-1');
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
        await this.ctx.storage.put('checkpoint', { snapshot, backup, image: restoredInfo.runtimeVersion === 'v2' ? c.images.v2 : c.images.dsh, instance: (await this.ctx.storage.get('selectedInstance')) || 'standard-1', runtimeVersion: restoredInfo.runtimeVersion || null, nodeVersion: restoredInfo.nodeVersion || null, at: Date.now() });
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
  async versions(liveInfo) {
    const cp = await this.ctx.storage.get('checkpoint');
    const op = await this.ctx.storage.get('versionOperation');
    const current = this.ctx.container.running ? liveInfo?.runtimeVersion || null : cp?.runtimeVersion || null;
    return { current, nodeVersion: this.ctx.container.running ? liveInfo?.nodeVersion || null : cp?.nodeVersion || null,
      source: this.ctx.container.running ? 'container' : 'checkpoint', latest: 'v2',
      available: ['v1','v2'].filter(v => this.ctx.container.images[v === 'v1' ? 'dsh' : 'v2']), operation: op || null };
  }
  async versionProgress() { return { operation: await this.ctx.storage.get('versionOperation') || null, progress: await this.ctx.storage.get('environmentProgress') || null }; }
  async withEnvironmentProgress(body, fn) {
    const progress={id:crypto.randomUUID(),kind:body?.kind==='resize'?'resize':'version',status:'running',stage:'checking',startedAt:Date.now()};
    const report=async stage=>{progress.stage=stage;progress.updatedAt=Date.now();await this.ctx.storage.put('environmentProgress',progress);};
    await report('checking');
    try { const result=await fn(report);progress.status='completed';progress.changed=result.changed;progress.completedAt=Date.now();await report('complete');return result; }
    catch(e) {progress.status='failed';progress.error=diagnosticText(e.message);progress.completedAt=Date.now();await report(progress.stage);throw e;}
  }
  async restoreVersionSafety() {
    return this.exclusive(async () => {
      const op = await this.ctx.storage.get('versionOperation');
      if (!op) return { restored: false };
      // No automatic replay after a restart/ambiguous response. Explicit user action only.
      const cp = op.safety || await this.ctx.storage.get('checkpoint');
      if (!cp?.snapshot) throw Error('没有可用的切换前快照，请保留现场并检查；不会启动空环境。');
      if (this.ctx.container.running) await this.ctx.container.destroy();
      this.setup = undefined;
      await this.ctx.storage.put('routingRecovery', op.safety || null);
      try {
        this.setup = this.boot().catch(e=>{this.setup=undefined;throw e});
        await this.setup;
        if(op.safety) {
          const r=await this.bridge('/status');if(!r.ok)throw Error('安全恢复后状态不可读');
          const info=await r.json();
          await this.ctx.storage.put({lastTask:info.task||null,checkpointHistory:await this.readHistory(),lastActivity:Date.now()});
        }
        await this.ctx.storage.put('versionOperation',null);
        return { restored: true };
      } catch(e) {
        await this.ctx.storage.put('versionOperation',{...op,error:diagnosticText(e.message)});
        throw e;
      }
    });
  }
  async changeVersion(body) {
    const resize = body?.kind === 'resize';
    if(resize) body.instance = validateInstance(body.instance);
    if (!body || (!resize && !['v1','v2'].includes(body.version)) || body.confirm !== true) throw Error('请选择版本并确认保存切换。');
    await this.lifecycle.start();
    return this.exclusive(() => this.withEnvironmentProgress(body, async report => {
      await this.assertVersionIdle();
      const c = this.ctx.container;
      if (resize && !c.running) throw Error('环境已停止，请先唤醒后再切换规格。');
      const lease = await this.ctx.storage.get('siteCheckLease');
      if (lease?.expiresAt > Date.now()) throw Error('浏览器检查正在执行，请结束后再切换。');
      await report(c.running?'checking':'waking');
      await this.ensure();
      const before = await (await this.bridge('/status')).json();
      if (before.busy || before.approvals?.some(a => a.status === 'pending')) throw Error('任务或审批正在执行，请结束后再切换。');
      if(resize) { if(!['v1','v2'].includes(before.runtimeVersion))throw Error('旧环境版本无法确认，请先在版本管理切换到 V1 或 V2，再调整规格。');body.version=before.runtimeVersion; }
      const image=c.images[body.version==='v1'?'dsh':'v2'];if(!image)throw Error('目标镜像尚未配置。');
      const instance=resize?body.instance:validateInstance((await this.ctx.storage.get('selectedInstance'))||'standard-1');
      const active=(await this.ctx.storage.get('activeInstance'))||'standard-1';
      if (before.runtimeVersion === body.version && JSON.stringify(active)===JSON.stringify(instance) && body.refreshImage!==true) return { changed: false };
      // saveAndStop refuses busy state again and commits fresh backup + safety checkpoint BEFORE destroy.
      await this.saveAndStop({onProgress:report});
      const source = await this.ctx.storage.get('checkpoint');
      const op = { id: crypto.randomUUID(), target: body.version, kind: resize?'resize':'version', instance, stage: 'saved', startedAt: Date.now() };
      await this.ctx.storage.put('versionOperation', op);
      let started = false;
      const stage = async value => { op.stage = value; await this.ctx.storage.put('versionOperation', op); await report(value); };
      try {
        await stage('starting');
        c.start({image, instance, entrypoint: ['sleep','infinity'], enableInternet: false}); started = true;
        await c.setInactivityTimeout(5 * MINUTE);
        await this.backups.intercept();
        await stage('restoring'); await this.backups.restore(source.backup);
        await c.interceptAllOutboundHttp(this.ctx.exports.Outbound);
        await c.interceptOutboundHttps('*',this.ctx.exports.Outbound);
        await c.exec(['sh','-c','exec node /app/server.mjs >>/data/bridge.log 2>&1'],{stdout:'ignore',stderr:'ignore'});
        await stage('validating');
        let info;
        for(let i=0;i<40;i++) { try { const r=await this.bridge('/status');if(r.ok){info=await r.json();break;} }catch{} await new Promise(r=>setTimeout(r,250)); }
        if(info?.runtimeVersion !== body.version || (body.version === 'v2' && !/^v[0-9]+\./.test(info.nodeVersion || '')) || ((body.refreshImage===true||before.demoEnvironmentVersion===1) && info.demoEnvironmentVersion!==1)) throw Error('目标容器版本或功能核验失败。');
        const history = await this.readHistory();
        if(JSON.stringify(history.sessions || []) !== JSON.stringify((await this.ctx.storage.get('checkpointHistory'))?.sessions || [])) throw Error('恢复后的会话目录不一致。');
        const quiet = await this.bridge('/quiesce',{}); if(!quiet.ok) throw Error('恢复后的环境无法安全保存。');
        await stage('checkpointing');
        const snapshot = await c.snapshotContainer({name:'version-'+body.version});
        await this.ctx.storage.delete('previewConfig');
        await this.lifecycle.jobs.push({id:'inspect',fn:'inspect',time:Date.now()+MINUTE});
        // One atomic storage put commits the new checkpoint and clears the safety priority/operation.
        await this.ctx.storage.put({checkpoint:{snapshot,backup:source.backup,image,instance,runtimeVersion:info.runtimeVersion,nodeVersion:info.nodeVersion || null,at:Date.now()},
          checkpointHistory:history,selectedInstance:instance,activeInstance:instance,selectedVersion:body.version,versionOperation:null,routingRecovery:null,checkpointError:null,lastTask:info.task || null,lastActivity:Date.now(),responseTiming:null});
        this.live = null; this.setup = Promise.resolve();
        return {changed:true,version:info.runtimeVersion,instance};
      } catch(e) {
        if(started) { await c.destroy(); this.setup=undefined; }
        await this.ctx.storage.put('versionOperation',{...op,error:diagnosticText(e.message)});
        throw Error('环境切换未完成：'+diagnosticText(e.message)+'。请点击恢复操作前环境；不会自动重试。');
      }
    }));
  }
  async changeInstance(body) { return this.changeVersion({...body,kind:'resize'}); }
  async onJob({ job }) {
    if (job.fn !== 'inspect') return;
    return this.exclusive(async () => {
      if (await this.ctx.storage.get('versionOperation')) return;
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
    if (u.pathname === '/' && request.method === 'GET') return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'" } });
    // Preview documents have an opaque sandbox origin; only their read-only route accepts Origin:null.
    const preview = /^\/preview\/([a-f0-9-]{36})\/(.*)$/.exec(u.pathname);
    if (preview && request.method === 'GET') {
      const response = await env.DSH.getByName('owner').previewFile(preview[1], preview[2]);
      for (const [key, value] of Object.entries(previewHeaders())) response.headers.set(key, value);
      return response;
    }
    if (request.method !== 'GET' && request.headers.get('origin') !== u.origin) return new Response('Origin required', { status: 403 });
    if (request.headers.get('origin') && request.headers.get('origin') !== u.origin) return new Response('Origin denied', { status: 403 });
    const agent = env.DSH.getByName('owner');
    try {
      let response;
      if (u.pathname === '/api/events' && request.method === 'GET') response = await agent.events(u.searchParams.get('taskId'));
      else if (u.pathname === '/api/preview/open' && request.method === 'POST') {
        const text = await request.text();
        if (text.length > 2048) return new Response('Too large', { status: 413 });
        response = Response.json(await agent.previewStart(JSON.parse(text)));
      }
      else if (u.pathname === '/api/preview/close' && request.method === 'POST') response = Response.json(await agent.previewClose());
      else if (u.pathname === '/api/versions/progress' && request.method === 'GET') response = Response.json(await agent.versionProgress());
      else if (u.pathname === '/api/versions/restore' && request.method === 'POST') response = Response.json(await agent.restoreVersionSafety());
      else if (u.pathname === '/api/instance' && request.method === 'POST') {const text=await request.text();if(text.length>2048)return new Response('Too large',{status:413});response=Response.json(await agent.changeInstance(JSON.parse(text)));}
      else if (u.pathname === '/api/versions' && request.method === 'POST') { const text=await request.text();if(text.length>2048)return new Response('Too large',{status:413});response=Response.json(await agent.changeVersion(JSON.parse(text))); }
      else if (u.pathname === '/api/demo/prepare' && request.method === 'POST') response = Response.json(await agent.prepareDemo());
      else if (u.pathname === '/api/wake' && request.method === 'POST') response = Response.json(await agent.wake());
      else if (u.pathname === '/api/sessions' && request.method === 'POST') { const text=await request.text();if(text.length>2048)return new Response('Too large',{status:413});response=Response.json(await agent.changeSession(JSON.parse(text))); }
      else if (u.pathname === '/api/history' && request.method === 'GET') response = Response.json(await agent.history());
      else if (u.pathname === '/api/approvals/decide' && request.method === 'POST') {const text=await request.text();if(text.length>2048)return new Response('Too large',{status:413});response=Response.json(await agent.decideApproval(JSON.parse(text)));}
      else if (u.pathname === '/api/status' && request.method === 'GET') response = Response.json(await agent.status());
      else if (u.pathname === '/api/tasks' && request.method === 'POST') { if (Number(request.headers.get('content-length')) > 32768) return new Response('Too large', { status: 413 }); const text = await request.text(); if (text.length > 32768) return new Response('Too large', { status: 413 }); response = await agent.submit(JSON.parse(text)); }
      else if (u.pathname === '/api/snapshot' && request.method === 'POST') response = Response.json(await agent.createSnapshot());
      else if (u.pathname === '/api/restart' && request.method === 'POST') { const text=await request.text();if(text.length>2048)return new Response('Too large',{status:413});response=Response.json(await agent.restart(JSON.parse(text))); }
      else if (u.pathname === '/api/checkpoint' && request.method === 'POST') response = Response.json(await agent.checkpoint());
      else if (u.pathname === '/api/recover' && request.method === 'POST') response = Response.json(await agent.recover());
      else response = new Response('Not found', { status: 404 });
      response.headers.set('cache-control', 'no-store'); return response;
    } catch (e) { return Response.json({ error: String(e.message).slice(0, 2000) }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
  }
};
