import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the actual control-plane source with platform interfaces replaced by
// deterministic in-memory doubles. No Cloudflare account, network or model calls.
const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const stripped = source.replace(/^import .*;\n/gm, '').replace(/^export \{ DirectoryBackupGateway \} from .*;\n/gm, '');
const prelude = `
import { normalizeTask } from ${JSON.stringify(new URL('../container/history.mjs', import.meta.url).href)};
const page = '';
const previewServer = '';
const previewHeaders = () => ({});
class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
class WorkerEntrypoint {}
const Lifecycle = { install() { return { async start() {}, jobs: { async push() {} } }; } };
class DirectoryBackup {
  constructor(container) { this.c = container; }
  async intercept() { await this.c.interceptOutboundHttp('backup', {}); }
  async backup() {
    await this.intercept();
    if (this.c.targets.indexOf('backup') > this.c.targets.indexOf('all') && this.c.targets.includes('all')) throw Error('Backup routed to catch-all');
    this.c.events.push('backup');
    return { id: 'backup-record', dir: '/data' };
  }
  async restore() { await this.intercept(); this.c.events.push('restore'); if (this.c.failRestore) throw Error('restore failed'); }
}
`;
const { DshAgent, validateInstance, taskPhaseFor, newKnownWait, applyKnownWait, captureKnownApprovals, knownWaitView } = await import('data:text/javascript;base64,' + Buffer.from(prelude + stripped).toString('base64'));
function fixture({ running = false, busy = false, revision, backup } = {}) {
  const data = new Map();
  if (revision) data.set('networkRevision', revision);
  if (backup) data.set('latestBackup', backup);
  const events = [], targets = running && revision !== 2 ? ['all'] : [];
  const c = {
    running, images: { dsh: 'current-image' }, events, targets,
    start(options) { assert.equal(this.running, false); this.running = true; events.push(['start', options]); },
    async setInactivityTimeout() {},
    async interceptOutboundHttp(name) { if (!targets.includes(name)) targets.push(name); },
    async interceptAllOutboundHttp() { if (!targets.includes('all')) targets.push('all'); },
    async interceptOutboundHttps() {},
    async exec() { events.push('exec'); return {}; },
    async snapshotContainer() { assert.equal(this.running, true); events.push('snapshot'); return { id: 'snapshot-' + events.length }; },
    async destroy() { this.running = false; targets.splice(0); events.push('destroy'); }
  };
  const ctx = {
    container: c, exports: { Outbound: {}, DirectoryBackupGateway: {} },
    blockConcurrencyWhile(fn) { return fn(); },
    storage: {
      async get(key) { return data.get(key); },
      async put(key, value) { if (typeof key === 'string') data.set(key, structuredClone(value)); else for (const [k, v] of Object.entries(key)) data.set(k, structuredClone(v)); },
      async delete(key) { for(const k of Array.isArray(key)?key:[key]) data.delete(k); }
    }
  };
  const g = new DshAgent(ctx, {});
  const info = { busy, task: null };
  g.bridge = async (path) => {
    if (path === '/history') return Response.json({ available: true, entries: [], total: 0 });
    if (path === '/quiesce') { events.push('quiesce'); return Response.json({}, { status: info.busy ? 409 : 200 }); }
    return Response.json(info);
  };
  return { g, c, data, info, events };
}

test('fresh boot registers backup before catch-all', async () => {
  const { g, c, data } = fixture();
  await g.boot();
  assert.ok(c.targets.indexOf('backup') < c.targets.indexOf('all'));
  assert.equal(data.get('networkRevision'), 2);
});

test('legacy live container is snapshotted and restarted before backup', async () => {
  const { g, c, data, events } = fixture({ running: true });
  data.set('everStarted', true);
  const result = await g.checkpoint();
  assert.equal(result.saved, true);
  assert.equal(c.running, false);
  assert.ok(events.indexOf('snapshot') < events.indexOf('destroy'));
  assert.ok(events.indexOf('destroy') < events.indexOf('backup'));
  const start = events.find(e => Array.isArray(e) && e[0] === 'start');
  assert.ok(start[1].containerSnapshot);
  assert.equal(start[1].image, undefined);
  assert.ok(data.get('latestBackup'));
  assert.equal(data.has('routingRecovery'), false);
});

test('busy work cannot be stopped by checkpoint', async () => {
  const { g, c, data, events } = fixture({ running: true, busy: true });
  await assert.rejects(g.checkpoint(), /busy/);
  assert.equal(c.running, true);
  assert.equal(events.includes('destroy'), false);
  assert.ok(data.get('checkpointError'));
});

test('ten-minute idle deadline starts at completion and polling does not reset it', async () => {
  const { g, c, data, info } = fixture({ running: true, revision: 2 });
  const finishedAt = Date.now() - 120000;
  data.set('lastTask', { id: 'task-a', status: 'running' });
  info.task = { id: 'task-a', status: 'completed', finishedAt };
  await g.status();
  assert.equal(data.get('lastActivity'), finishedAt);
  await g.status();
  assert.equal(data.get('lastActivity'), finishedAt);
  assert.equal((await g.status()).idleShutdownAt, finishedAt + 600000);
  await g.onJob({ job: { fn: 'inspect' } });
  assert.equal(c.running, true);
});

test('idle job saves and stops after deadline but never interrupts busy work', async () => {
  const { g, c, data, info } = fixture({ running: true, revision: 2, busy: true });
  data.set('lastActivity', Date.now() - 660000);
  await g.onJob({ job: { fn: 'inspect' } });
  assert.equal(c.running, true);
  info.busy = false;
  await g.onJob({ job: { fn: 'inspect' } });
  assert.equal(c.running, false);
  assert.ok(data.get('checkpoint'));
});

test('restore requires a backup before touching live container', async () => {
  const { g, c, events } = fixture({ running: true });
  await assert.rejects(g.recover(), /No R2 backup/);
  assert.equal(c.running, true);
  assert.equal(events.includes('destroy'), false);
});

test('one-action restore protects live files and does not replace selected R2 backup', async () => {
  const backup = { id: 'chosen-backup', dir: '/data' };
  const { g, c, data, events } = fixture({ running: true, backup });
  await g.recover();
  assert.ok(events.indexOf('quiesce') < events.indexOf('snapshot'));
  assert.ok(events.indexOf('snapshot') < events.indexOf('destroy'));
  assert.ok(events.includes('restore'));
  assert.equal(events.includes('backup'), false);
  assert.deepEqual(data.get('latestBackup'), backup);
  assert.equal(c.running, false);
  assert.ok(data.get('checkpoint'));
});

test('failed restore retains safety snapshot', async () => {
  const { g, c, data } = fixture({ running: true, backup: { id: 'old-backup' } });
  c.failRestore = true;
  await assert.rejects(g.recover(), /restore failed/);
  assert.ok(data.get('routingRecovery')?.snapshot);
  assert.equal(c.running, false);
});

test('busy work blocks one-action restore without destroying container', async () => {
  const { g, c, events } = fixture({ running: true, busy: true, backup: { id: 'old' } });
  await assert.rejects(g.recover(), /任务正在执行/);
  assert.equal(c.running, true);
  assert.equal(events.includes('destroy'), false);
});

test('viewing saved history never starts a container', async () => {
  const { g, c, data, events } = fixture();
  data.set('checkpointHistory', { available: true, entries: [{ id: 'saved' }], total: 1 });
  const history = await g.history();
  assert.equal(history.source, 'saved');
  assert.equal(c.running, false);
  assert.equal(events.length, 0);
});

test('R2 restore replaces visible history and latest result instead of showing newer cache', async () => {
  const { g, data } = fixture({ backup: { id: 'older-backup' } });
  data.set('checkpointHistory', { available: true, entries: [{ id: 'newer' }], total: 1 });
  data.set('lastTask', { id: 'newer', status: 'completed' });
  data.set('lastGatewayError', { at: Date.now(), message: 'unrelated later failure' });
  await g.recover();
  const history = await g.history();
  assert.equal(history.source, 'r2-restored');
  assert.deepEqual(history.entries, []);
  assert.equal(data.get('lastTask'), null);
  assert.equal(data.has('lastGatewayError'), false);
});


test('snapshot wake measures service readiness without submitting a task', async () => {
  const { g, data, events } = fixture();
  data.set('everStarted', true);
  data.set('checkpoint', { snapshot: { id: 'saved-snapshot' } });
  const result = await g.wake();
  assert.equal(result.started, true);
  assert.equal(result.measurement.kind, 'snapshot');
  assert.equal(result.measurement.snapshotId, 'saved-snapshot');
  assert.ok(result.measurement.serviceReadyMs >= 0);
  assert.equal(events.find(e => Array.isArray(e) && e[0] === 'start')[1].containerSnapshot.id, 'saved-snapshot');
  assert.equal(data.has('lastTask'), false);
});

test('snapshot demo never silently falls back to a fresh image', async () => {
  const { g, c } = fixture();
  await assert.rejects(g.wake(), /没有可启动的快照/);
  assert.equal(c.running, false);
});

test('already running demo does not fabricate a new startup measurement', async () => {
  const { g, data } = fixture({ running: true });
  assert.equal((await g.wake()).started, false);
  assert.equal(data.has('lastBoot'), false);
});

test('first visible text timing survives later model calls for the same task', async () => {
  const { g, data } = fixture({ running: true });
  data.set('lastTask', { id: 'a', status: 'running', startedAt: Date.now() - 100 });
  data.set('taskTimingStart', { id: 'a', acceptedAt: Date.now() - 100 });
  const call = await g.beginModelCall();
  await g.modelProgress({ ...call, text: 'hello', done: false });
  const timing = structuredClone(data.get('responseTiming'));
  assert.ok(timing.firstTextMs >= 100);
  const next = await g.beginModelCall();
  await g.modelProgress({ ...next, text: 'next answer', done: true });
  assert.equal(data.get('responseTiming').firstTextMs, timing.firstTextMs);
  assert.equal(g.live.dispatchDelayMs, timing.dispatchDelayMs);
  await g.modelProgress({ ...call, text: 'stale stream', done: true });
  assert.equal(g.live.text, 'next answer');
});

test('closing live stream does not stop container or replay task', async () => {
  const { g, c, events } = fixture({ running: true });
  const response = await g.events('task-a');
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(c.running, true);
  assert.equal(g.viewers.size, 0);
  assert.equal(events.includes('destroy'), false);
});


test('container clock skew does not produce negative response timing', async () => {
  const { g, data, info } = fixture({ running: true });
  const task = { id: 'clock-test', status: 'running', startedAt: Date.now() + 60000 };
  data.set('lastTask', task); info.task = task;
  data.set('taskTimingStart', { id: task.id, acceptedAt: Date.now() - 100 });
  const call = await g.beginModelCall();
  await g.modelProgress({ ...call, text: 'hello', done: true });
  const measured = data.get('responseTiming');
  assert.equal(measured.timingVersion, 2);
  assert.ok(measured.dispatchDelayMs >= 100);
  assert.ok(measured.firstTextMs >= 100);
  assert.equal(measured.runToModelMs, null);
});

test('legacy task without a control-clock anchor is unmeasured, not guessed', async () => {
  const { g, data } = fixture({ running: true });
  data.set('lastTask', { id: 'legacy', status: 'running', startedAt: Date.now() + 60000 });
  const call = await g.beginModelCall();
  await g.modelProgress({ ...call, text: 'answer', done: true });
  assert.equal(data.get('responseTiming').dispatchDelayMs, null);
  assert.equal(data.get('responseTiming').firstTextMs, null);
});


test('preview rejects absolute and hidden directories before starting the runtime', async () => {
  const { g, c } = fixture();
  for (const root of ['/data', '../', '.secret', 'site/../other']) await assert.rejects(g.previewStart({root}), /相对目录/);
  assert.equal(c.running, false);
});

test('old preview links never wake a sleeping container', async () => {
  const { g, c, data } = fixture();
  data.set('previewConfig', { id:'active', expiresAt:Date.now()+60000 });
  assert.equal((await g.previewFile('old','index.html')).status,404);
  assert.equal((await g.previewFile('active','index.html')).status,409);
  assert.equal(c.running,false);
  await g.previewClose();
  assert.equal(data.has('previewConfig'),false);
});

test('expired demo links are rejected without waking a container', async () => {
  const { g, c, data } = fixture();
  data.set('previewConfig', {id:'expired',expiresAt:Date.now()-1});
  assert.equal((await g.previewFile('expired','index.html')).status,404);
  assert.equal(c.running,false);
});

test('busy tasks and unsupported legacy bridges cannot change sessions',async()=>{
 const {g,c,info}=fixture({running:true,busy:true});const body={action:'create',id:'11111111-1111-4111-8111-111111111111'};
 await assert.rejects(g.changeSession(body),/任务正在执行/);assert.equal(c.running,true);
 info.busy=false;await assert.rejects(g.changeSession(body),/尚不支持/);assert.equal(c.running,true);
});
test('session change clears stale result/timing without destroying or replaying work',async()=>{
 const {g,c,data,events}=fixture({running:true});let active='primary';
 g.bridge=async(path,body)=>{if(path==='/sessions')active=body.id;return Response.json({sessionsSupported:true,sessionId:active,sessions:[],busy:false,task:null})};
 data.set('lastTask',{id:'old'});data.set('responseTiming',{taskId:'old'});data.set('lastGatewayError',{message:'old'});
 await g.changeSession({action:'create',id:'11111111-1111-4111-8111-111111111111'});
 assert.equal(data.get('lastTask'),null);assert.equal(data.has('responseTiming'),false);assert.equal(data.has('lastGatewayError'),false);assert.equal(c.running,true);assert.equal(events.includes('destroy'),false);
});
test('a stale page cannot submit into a different active session',async()=>{
 const {g,data,info}=fixture({running:true});info.sessionId='new-context';
 const response=await g.submit({id:'11111111-1111-4111-8111-111111111111',prompt:'hello',sessionId:'old-context'});
 assert.equal(response.status,409);assert.equal(data.has('request:11111111-1111-4111-8111-111111111111'),false);
});

function versionFixture(options={}) {
 const f=fixture({running:true,revision:2,...options});
 f.c.images.v2='v2-image';f.info.runtimeVersion='v1';f.info.sessions=[];
 // Snapshots preserve the source runtime; they do not carry an image start option.
 const snapshots=new Map();let snapshotSequence=0;
 const snapshot=f.c.snapshotContainer.bind(f.c);
 f.c.snapshotContainer=async o=>{const saved={...await snapshot(o),id:'version-snapshot-'+(++snapshotSequence)};snapshots.set(saved.id,{runtimeVersion:f.info.runtimeVersion,nodeVersion:f.info.nodeVersion});return saved;};
 const start=f.c.start.bind(f.c);f.c.start=o=>{
  let runtime;
  if(o.containerSnapshot){runtime=snapshots.get(o.containerSnapshot.id);assert.ok(runtime,'fixture must know the snapshot source runtime');}
  else {const version=o.image==='v2-image'?'v2':'v1';runtime={runtimeVersion:version,nodeVersion:version==='v2'?'v24.0.0':undefined};}
  start(o);Object.assign(f.info,runtime);
 };
 return f;
}
test('version switching rejects busy tasks before saving or destroying',async()=>{
 const f=versionFixture({busy:true});await assert.rejects(f.g.changeVersion({version:'v2',confirm:true}),/任务/);assert.equal(f.c.running,true);assert.ok(!f.events.includes('destroy'));assert.ok(!f.events.includes('backup'));
});
test('versions use fresh backup and support repeated upgrade/downgrade',async()=>{
 const f=versionFixture();
 for(const version of ['v2','v1','v2']) {
  f.events.length=0;const r=await f.g.changeVersion({version,confirm:true});assert.equal(r.version,version);
  assert.ok(f.events.indexOf('backup')<f.events.indexOf('destroy'));assert.ok(f.events.indexOf('restore')>f.events.indexOf('destroy'));
  assert.equal(f.data.get('checkpoint').runtimeVersion,version);assert.equal(f.data.get('versionOperation'),null);assert.equal(f.c.running,true);
 }
});
test('failed restore preserves source checkpoint, blocks work, and supports explicit safety recovery',async()=>{
 const f=versionFixture();f.c.failRestore=true;
 await assert.rejects(f.g.changeVersion({version:'v2',confirm:true}),/未完成/);
 assert.equal(f.data.get('checkpoint').runtimeVersion,'v1');assert.ok(f.data.get('versionOperation'));assert.equal(f.c.running,false);
 await assert.rejects(f.g.ensure(),/尚未完成/);await assert.rejects(f.g.checkpoint(),/尚未完成/);
 f.c.failRestore=false;await f.g.restoreVersionSafety();assert.equal(f.c.running,true);assert.equal(f.data.get('versionOperation'),null);
});
test('same version is a no-op and unconfirmed/unknown target is rejected',async()=>{
 const f=versionFixture();assert.equal((await f.g.changeVersion({version:'v1',confirm:true})).changed,false);assert.ok(!f.events.includes('destroy'));
 await assert.rejects(f.g.changeVersion({version:'v3',confirm:true}));await assert.rejects(f.g.changeVersion({version:'v2'}));
});
test('sleeping version display is sourced from checkpoint, not latest available image',async()=>{
 const f=fixture();f.c.images.v2='v2-image';f.data.set('checkpoint',{runtimeVersion:'v1'});const v=await f.g.versions();assert.equal(v.current,'v1');assert.equal(v.latest,'v2');assert.equal(v.source,'checkpoint');
});

test('browser check lease blocks a version change without stopping the live container',async()=>{
 const f=versionFixture();f.data.set('siteCheckLease',{token:'live',expiresAt:Date.now()+60000});await assert.rejects(f.g.changeVersion({version:'v2',confirm:true}),/浏览器/);assert.equal(f.c.running,true);assert.ok(!f.events.includes('backup'));
});
test('backup failure never stops the original container',async()=>{
 const f=versionFixture();f.g.backups.backup=async()=>{throw Error('R2 unavailable')};await assert.rejects(f.g.changeVersion({version:'v2',confirm:true}),/R2 unavailable/);assert.equal(f.c.running,true);assert.ok(!f.events.includes('destroy'));assert.equal(f.info.runtimeVersion,'v1');
});
test('a mismatched target version is not committed as success',async()=>{
 const f=versionFixture();const start=f.c.start.bind(f.c);f.c.start=o=>{start(o);f.info.runtimeVersion='v1'};
 await assert.rejects(f.g.changeVersion({version:'v2',confirm:true}),/核验失败/);assert.equal(f.data.get('checkpoint').runtimeVersion,'v1');assert.ok(f.data.get('versionOperation'));assert.equal(f.c.running,false);
});

test('manual snapshot also backs up data but keeps the instance running',async()=>{
 const f=fixture({running:true,revision:2});const r=await f.g.createSnapshot();assert.equal(r.saved,true);assert.equal(f.c.running,true);assert.ok(f.events.includes('backup'));assert.ok(f.events.includes('snapshot'));assert.ok(!f.events.includes('destroy'));assert.ok(f.data.get('checkpoint').snapshot);
});
test('restart explicitly restores the previously saved snapshot without R2 restore or backup',async()=>{
 const f=fixture({running:true,revision:2});await f.g.createSnapshot();const cp=f.data.get('checkpoint');f.events.length=0;
 await f.g.restart({confirm:true,checkpointAt:cp.at});
 assert.equal(f.c.running,true);assert.ok(!f.events.includes('backup'));assert.ok(!f.events.includes('restore'));
 const start=f.events.find(e=>Array.isArray(e)&&e[0]==='start')[1];assert.equal(start.containerSnapshot.id,cp.snapshot.id);assert.equal(start.image,undefined);
 assert.equal(f.data.get('versionOperation'),null);assert.ok(f.data.get('lastRestartSafety').snapshot);
});
test('restart rejects missing/stale checkpoints and busy tasks before destroying',async()=>{
 const f=fixture({running:true,revision:2});await assert.rejects(f.g.restart({confirm:true}),/先创建快照/);
 await f.g.createSnapshot();const cp=f.data.get('checkpoint');await assert.rejects(f.g.restart({confirm:true,checkpointAt:cp.at-1}),/已变化/);
 f.info.busy=true;await assert.rejects(f.g.restart({confirm:true,checkpointAt:cp.at}),/任务/);assert.ok(!f.events.includes('destroy'));
});
test('creating a V1 snapshot does not hide the V2 update',async()=>{
 const f=versionFixture();await f.g.createSnapshot();const v=await f.g.versions(f.info);assert.equal(v.current,'v1');assert.equal(v.latest,'v2');assert.ok(v.available.includes('v2'));
});
test('restart failure keeps an explicit operation and its pre-restart safety snapshot',async()=>{
 const f=fixture({running:true,revision:2});await f.g.createSnapshot();const cp=f.data.get('checkpoint');f.c.start=()=>{throw Error('start failed')};
 await assert.rejects(f.g.restart({confirm:true,checkpointAt:cp.at}),/重启未完成/);assert.ok(f.data.get('versionOperation').safety.snapshot);await assert.rejects(f.g.ensure(),/尚未完成/);
});

test('official runtime sizes and bounded custom sizes are validated',()=>{
 for(const v of ['lite','standard-1','standard-2','standard-3','standard-4'])assert.equal(validateInstance(v),v);
 assert.deepEqual(validateInstance({vcpu:2,memoryMib:6144,diskMb:16000}),{vcpu:2,memoryMib:6144,diskMb:16000});
 for(const v of ['basic','unknown',{vcpu:5,memoryMib:16000,diskMb:16000},{vcpu:2,memoryMib:4096,diskMb:16000},{vcpu:1,memoryMib:4096,diskMb:20001}])assert.throws(()=>validateInstance(v));
});
test('resize backs up before stopping, preserves version, and commits selected size',async()=>{
 const f=versionFixture();const result=await f.g.changeInstance({instance:'standard-2',confirm:true});assert.equal(result.version,'v1');assert.equal(result.instance,'standard-2');
 const start=f.events.find(e=>Array.isArray(e)&&e[0]==='start');assert.equal(start[1].instance,'standard-2');assert.equal(start[1].image,'current-image');
 assert.ok(f.events.indexOf('backup')<f.events.indexOf('destroy'));assert.equal(f.data.get('checkpoint').instance,'standard-2');assert.equal(f.data.get('activeInstance'),'standard-2');
});
test('resize rejects busy tasks without stopping',async()=>{
 const f=versionFixture({busy:true});await assert.rejects(f.g.changeInstance({instance:'standard-2',confirm:true}),/任务/);assert.ok(!f.events.includes('destroy'));
});
test('confirmed upgrade while stopped wakes saved snapshot then migrates through R2',async()=>{
 const f=versionFixture();await f.g.createSnapshot();const cp=f.data.get('checkpoint');await f.c.destroy();f.events.length=0;
 const result=await f.g.changeVersion({version:'v2',confirm:true});
 const starts=f.events.filter(x=>Array.isArray(x)&&x[0]==='start').map(x=>x[1]);
 assert.equal(starts[0].containerSnapshot.id,cp.snapshot.id);assert.equal(starts[0].image,undefined);assert.equal(starts[1].image,'v2-image');
 assert.ok(f.events.indexOf('backup')<f.events.indexOf('destroy'));assert.ok(f.events.indexOf('restore')>f.events.indexOf('destroy'));
 assert.equal(result.version,'v2');assert.equal(f.info.runtimeVersion,'v2');assert.equal(f.c.running,true);assert.equal(f.data.get('checkpoint').runtimeVersion,'v2');
});
test('stopped size selection still requires explicit wake',async()=>{
 const f=versionFixture({running:false});await assert.rejects(f.g.changeInstance({instance:'standard-2',confirm:true}),/环境已停止/);
 assert.ok(!f.events.some(x=>Array.isArray(x)&&x[0]==='start'));
});
test('stopped upgrade cannot bypass missing saved state protection',async()=>{
 const f=versionFixture({running:false});f.data.set('everStarted',true);
 await assert.rejects(f.g.changeVersion({version:'v2',confirm:true}),/No saved checkpoint/);assert.ok(!f.events.includes('backup'));assert.equal(f.c.running,false);
});
test('smaller disk switches through fresh R2 backup, not source snapshot',async()=>{
 const f=versionFixture();await f.g.changeInstance({instance:'standard-3',confirm:true});f.events.length=0;
 await f.g.changeInstance({instance:'standard-1',confirm:true});
 const start=f.events.find(x=>Array.isArray(x)&&x[0]==='start')[1];assert.equal(start.instance,'standard-1');assert.equal(start.containerSnapshot,undefined);assert.equal(start.image,'current-image');
 assert.ok(f.events.indexOf('backup')<f.events.indexOf('destroy'));assert.ok(f.events.indexOf('restore')>f.events.indexOf('destroy'));
 assert.equal(f.data.get('checkpoint').instance,'standard-1');
});
test('insufficient restore space retains larger source checkpoint for explicit recovery',async()=>{
 const f=versionFixture();await f.g.changeInstance({instance:'standard-3',confirm:true});const previous=f.data.get('checkpoint');
 let safety;const start=f.c.start.bind(f.c);f.c.start=o=>{if(o.image)safety=structuredClone(f.data.get('checkpoint'));start(o);};
 const restore=f.g.backups.restore.bind(f.g.backups);f.g.backups.restore=async()=>{throw Error('ENOSPC')};
 await assert.rejects(f.g.changeInstance({instance:'standard-1',confirm:true}),/ENOSPC/);
 const retained=f.data.get('checkpoint');
 assert.notEqual(safety.snapshot.id,previous.snapshot.id,'switch must save a fresh source snapshot before target startup');
 assert.equal(retained.snapshot.id,safety.snapshot.id);assert.equal(retained.instance,'standard-3');assert.equal(retained.runtimeVersion,'v1');assert.deepEqual(retained.backup,safety.backup);
 assert.equal(f.data.get('selectedInstance'),'standard-3');assert.equal(f.c.running,false);
 f.g.backups.restore=restore;await f.g.restoreVersionSafety();
 const restoredStart=f.events.filter(e=>Array.isArray(e)&&e[0]==='start').at(-1)[1];assert.equal(restoredStart.containerSnapshot.id,safety.snapshot.id);assert.equal(restoredStart.instance,'standard-3');
 assert.equal(f.data.get('activeInstance'),'standard-3');assert.equal(f.data.get('versionOperation'),null);
});
test('custom size survives snapshot restart and version switches',async()=>{
 const f=versionFixture(),size={vcpu:2,memoryMib:6144,diskMb:16000};await f.g.changeInstance({instance:size,confirm:true});
 f.events.length=0;await f.g.changeVersion({version:'v2',confirm:true});assert.deepEqual(f.events.find(e=>Array.isArray(e)&&e[0]==='start')[1].instance,size);
 const cp=f.data.get('checkpoint');f.events.length=0;await f.g.restart({confirm:true,checkpointAt:cp.at});
 const restoredStart=f.events.find(e=>Array.isArray(e)&&e[0]==='start')[1];
 assert.deepEqual(restoredStart.instance,size);assert.equal(restoredStart.containerSnapshot.id,cp.snapshot.id);assert.equal(restoredStart.image,undefined);
 assert.equal(f.info.runtimeVersion,'v2');assert.equal(f.info.nodeVersion,'v24.0.0');assert.deepEqual(f.data.get('activeInstance'),size);assert.equal(f.data.get('versionOperation'),null);
 assert.ok(!f.events.includes('restore'));assert.ok(!f.events.includes('backup'));
});
test('snapshot restart preserves each version through repeated V2/V1 switching',async()=>{
 const f=versionFixture();
 for(const version of ['v2','v1','v2']){
  await f.g.changeVersion({version,confirm:true});const cp=f.data.get('checkpoint');
  await f.g.restart({confirm:true,checkpointAt:cp.at});
  assert.equal(f.info.runtimeVersion,version);assert.equal(f.info.nodeVersion,version==='v2'?'v24.0.0':undefined);
  assert.equal(f.data.get('versionOperation'),null);assert.equal(f.c.running,true);
 }
});
test('restart still rejects an actual snapshot runtime version mismatch',async()=>{
 const f=versionFixture();await f.g.changeVersion({version:'v2',confirm:true});const cp=f.data.get('checkpoint');
 const start=f.c.start.bind(f.c);f.c.start=o=>{start(o);if(o.containerSnapshot)f.info.runtimeVersion='v1';};
 await assert.rejects(f.g.restart({confirm:true,checkpointAt:cp.at}),/重启后的版本与快照不符/);
 assert.equal(f.c.running,false);assert.ok(f.data.get('versionOperation'));assert.equal(f.data.get('checkpoint').snapshot.id,cp.snapshot.id);
 await assert.rejects(f.g.ensure(),/尚未完成/);
});
test('failed resizing restores source size only after explicit safety recovery',async()=>{
 const f=versionFixture();f.c.failRestore=true;await assert.rejects(f.g.changeInstance({instance:'standard-2',confirm:true}));assert.equal(f.data.get('selectedInstance'),undefined);assert.equal(f.data.get('checkpoint').instance,'standard-1');
 f.c.failRestore=false;await f.g.restoreVersionSafety();assert.equal(f.data.get('activeInstance'),'standard-1');
});

test('durable progress reports backup before version operation is created and can be polled without queue lock',async()=>{
 const f=versionFixture(),stages=[];const put=f.g.ctx.storage.put.bind(f.g.ctx.storage);
 f.g.ctx.storage.put=async(k,v)=>{if(k==='environmentProgress')stages.push(v.stage);return put(k,v);};
 let release,entered;const gate=new Promise(r=>release=r),seen=new Promise(r=>entered=r);const backup=f.g.backups.backup.bind(f.g.backups);
 f.g.backups.backup=async()=>{entered();await gate;return backup();};
 const work=f.g.changeVersion({version:'v2',confirm:true});await seen;
 const live=await f.g.versionProgress();assert.equal(live.progress.stage,'backing-up');assert.equal(live.progress.status,'running');assert.equal(live.operation,null);
 release();await work;const done=await f.g.versionProgress();assert.equal(done.progress.status,'completed');
 const expected=['quiescing','backing-up','safety-snapshot','stopping','starting','restoring','validating','checkpointing','complete'];
 for(let i=1;i<expected.length;i++)assert.ok(stages.indexOf(expected[i-1])<stages.indexOf(expected[i]));
});
test('failed R2 restore leaves persistent failed progress at the actual stage',async()=>{
 const f=versionFixture();f.c.failRestore=true;await assert.rejects(f.g.changeInstance({instance:'standard-2',confirm:true}));
 const status=await f.g.versionProgress();assert.equal(status.progress.kind,'resize');assert.equal(status.progress.status,'failed');assert.equal(status.progress.stage,'restoring');assert.match(status.progress.error,/restore failed/);assert.ok(status.operation);assert.equal(f.data.get('checkpoint').runtimeVersion,'v1');
});

test('session deletion removes cached task replies and refuses old bridge capability',async()=>{
 const f=fixture({running:true});let supported=false;
 f.g.bridge=async path=>Response.json(path==='/sessions'?{deletedTaskIds:['a','b'],sessions:[],sessionId:'next'}:{sessionsSupported:true,sessionDeletionSupported:supported,busy:false,task:null});
 f.data.set('request:a',{id:'a'});f.data.set('request:b',{id:'b'});f.data.set('request:keep',{id:'keep'});
 await assert.rejects(f.g.changeSession({action:'delete',id:'old'}),/不支持删除/);assert.ok(f.data.has('request:a'));
 supported=true;await f.g.changeSession({action:'delete',id:'old'});assert.equal(f.data.has('request:a'),false);assert.equal(f.data.has('request:b'),false);assert.equal(f.data.has('request:keep'),true);
});


test('old demo environment is rejected before submission intent or model task dispatch',async()=>{
 const f=fixture({running:true,revision:2});let dispatched=false;const bridge=f.g.bridge.bind(f.g);f.g.bridge=async(p,b)=>{if(p==='/tasks')dispatched=true;return bridge(p,b)};
 await assert.rejects(f.g.submit({id:'old-demo-123456789',prompt:'demo',demo:'web-deck-v1'}),/更新运行镜像/);assert.equal(dispatched,false);assert.equal(f.data.has('request:old-demo-123456789'),false);assert.equal(f.c.running,true);
});
test('demo preparation finishes before accepted task; HTML is still generated by the Agent',async()=>{
 const f=fixture({running:true,revision:2});f.info.demoEnvironmentVersion=1;const calls=[];const bridge=f.g.bridge.bind(f.g);f.g.bridge=async(p,b)=>{if(p==='/demo/prepare'){assert.equal(f.data.has('request:new-demo-123456789'),false);calls.push('prepare');return Response.json({ready:true,rows:9})}if(p==='/tasks'){calls.push('task');return Response.json({id:b.id,prompt:b.prompt,status:'running'},{status:202})}return bridge(p,b)};
 const r=await f.g.submit({id:'new-demo-123456789',prompt:'generate webpage and check',demo:'web-deck-v1'});assert.equal(r.status,202);assert.deepEqual(calls,['prepare','task']);assert.equal(f.data.get('request:new-demo-123456789').status,'running');
});
test('manual demo preparation rejects busy work and requires ready result',async()=>{
 const f=fixture({running:true,busy:true,revision:2});f.info.demoEnvironmentVersion=1;await assert.rejects(f.g.prepareDemo(),/正在执行/);f.info.busy=false;const bridge=f.g.bridge.bind(f.g);f.g.bridge=async(p,b)=>p==='/demo/prepare'?Response.json({error:'bad CSV'},{status:400}):bridge(p,b);await assert.rejects(f.g.prepareDemo(),/bad CSV/);
});
test('explicit same-label image refresh uses fresh image plus R2 migration, regular switch remains no-op',async()=>{
 const f=versionFixture();f.info.demoEnvironmentVersion=1;assert.equal((await f.g.changeVersion({version:'v1',confirm:true})).changed,false);f.events.length=0;
 const r=await f.g.changeVersion({version:'v1',confirm:true,refreshImage:true});assert.equal(r.changed,true);assert.ok(f.events.indexOf('backup')<f.events.indexOf('destroy'));assert.ok(f.events.indexOf('restore')>f.events.indexOf('destroy'));const start=f.events.find(e=>Array.isArray(e)&&e[0]==='start')[1];assert.equal(start.image,'current-image');assert.equal(start.containerSnapshot,undefined);
});
test('image refresh refuses old capability and preserves explicit recovery on failure',async()=>{
 const f=versionFixture();await assert.rejects(f.g.changeVersion({version:'v1',confirm:true,refreshImage:true}),/功能核验/);assert.ok(f.data.get('versionOperation'));assert.equal(f.c.running,false);assert.ok(f.data.get('checkpoint'));
});


test('new V1 and V2 switches preserve the common demo capability and session directory',async()=>{
 const f=versionFixture();f.info.demoEnvironmentVersion=1;for(const version of ['v2','v1','v2']){const r=await f.g.changeVersion({version,confirm:true});assert.equal(r.version,version);const info=await f.g.status();assert.equal(info.demoEnvironmentVersion,1);assert.deepEqual(info.sessions,[]);assert.equal(f.data.get('versionOperation'),null)}
});
test('switching from complete environment to a target missing demo tools is not success',async()=>{
 const f=versionFixture();f.info.demoEnvironmentVersion=1;const start=f.c.start.bind(f.c);f.c.start=o=>{start(o);f.info.demoEnvironmentVersion=0};await assert.rejects(f.g.changeVersion({version:'v2',confirm:true}),/功能核验/);assert.ok(f.data.get('versionOperation'));assert.equal(f.c.running,false);assert.ok(f.data.get('checkpoint'));
});


test('task phase is based on actual current-task events with authorization then browser priority',()=>{
 const now=10000,task={id:'phase-task',status:'running',startedAt:1000},info={task,runtimeReady:true,approvals:[]};const model={taskId:task.id,calls:[{callId:'a',startedAt:2000}]},lease={taskId:task.id,startedAt:3000,expiresAt:20000};
 assert.equal(taskPhaseFor(info,null,null,now).kind,'executing');assert.equal(taskPhaseFor({...info,runtimeReady:false},null,null,now).kind,'preparing');assert.equal(taskPhaseFor(info,model,null,now).label,'等待模型响应');assert.equal(taskPhaseFor(info,{...model,calls:[{callId:'a',startedAt:2000,responseStartedAt:4000}]},null,now).label,'正在接收模型流');assert.equal(taskPhaseFor(info,model,lease,now).kind,'browser');
 const pending={taskId:task.id,status:'pending',at:4000,expiresAt:20000};assert.equal(taskPhaseFor({...info,approvals:[pending]},model,lease,now).kind,'approval');assert.equal(taskPhaseFor({...info,approvals:[{...pending,expiresAt:5000}]},model,lease,now).kind,'browser');assert.equal(taskPhaseFor({...info,approvals:[{...pending,taskId:'old'}]},model,lease,now).kind,'browser');
 assert.equal(taskPhaseFor(info,{...model,taskId:'old'},{...lease,taskId:'old'},now).kind,'executing');assert.equal(taskPhaseFor(info,model,{...lease,expiresAt:5000},now).kind,'model');assert.equal(taskPhaseFor(info,model,null,1000000).kind,'executing');assert.equal(taskPhaseFor({...info,task:{...task,status:'completed'}},model,lease,now),null);
});
test('parallel model requests remain waiting until each finishes, independent of transient live text',async()=>{
 const f=fixture({running:true,revision:2});f.info.task={id:'parallel-task',status:'running'};f.data.set('lastTask',f.info.task);const a=await f.g.beginModelCall(),b=await f.g.beginModelCall();assert.equal(f.data.get('modelActivity').calls.length,2);f.g.live=null;
 await f.g.modelProgress({...a,text:'',responseStarted:true,done:false});let phase=(await f.g.status()).taskPhase;assert.equal(phase.label,'正在接收模型流');
 await f.g.modelProgress({...a,text:'public response',done:true});assert.equal(f.data.get('modelActivity').calls.length,1);assert.equal((await f.g.status()).taskPhase.label,'等待模型响应');await f.g.modelProgress({...b,text:'',done:true});assert.equal((await f.g.status()).taskPhase.kind,'executing');
});
test('browser waiting starts and ends with the scoped browser lease',async()=>{
 const f=fixture({running:true,revision:2});f.info.task={id:'browser-task',status:'running'};f.data.set('lastTask',f.info.task);const token=await f.g.acquireSiteCheck();assert.equal((await f.g.status()).taskPhase.kind,'browser');await f.g.releaseSiteCheck('wrong');assert.equal((await f.g.status()).taskPhase.kind,'browser');await f.g.releaseSiteCheck(token);assert.equal((await f.g.status()).taskPhase.kind,'executing');f.info.task.status='failed';assert.equal((await f.g.status()).taskPhase,null);
});


test('known wait counts first-response delay only; overlapping streaming is excluded',()=>{
 let s=newKnownWait('t',1000);const event=(key,kind,action,at)=>{s=applyKnownWait(s,{taskId:'t',key,kind,action,at,deadline:900000})};
 event('a','model','start',1000);event('b','model','start',2000);event('a','model','stop',3000);event('sa','stream','start',3000);
 assert.equal(knownWaitView(s,6000).waitMs,2000);event('sa','stream','stop',7000);event('b','model','stop',8000);event('br','browser','start',7000);event('br','browser','stop',9000);
 s=captureKnownApprovals(s,{id:'t',status:'completed',finishedAt:11000},[{id:'p',taskId:'t',at:8000,expiresAt:20000,status:'allowed-once',finishedAt:10000}],12000);
 const v=knownWaitView(s,50000);assert.equal(v.totalMs,10000);assert.equal(v.modelMs,3000);assert.equal(v.browserMs,2000);assert.equal(v.approvalMs,2000);assert.equal(v.waitMs,5000);assert.equal(v.ratio,0.5);assert.equal(v.finished,true);
 assert.equal(captureKnownApprovals(s,{id:'t',status:'completed'},[],60000),s);assert.equal(applyKnownWait(s,{taskId:'other',kind:'model',at:12000}),s);
});
test('known interval boundaries survive polling gaps; old sampled records and expired orphan calls are not guessed',()=>{
 let s=newKnownWait('t',1000);s=applyKnownWait(s,{taskId:'t',key:'m',kind:'model',action:'start',at:2000,deadline:10000});assert.equal(knownWaitView(s,9000).waitMs,7000);assert.equal(knownWaitView(s,11000).waitMs,0);
 s=applyKnownWait(s,{taskId:'t',key:'m',kind:'model',action:'stop',at:12000});assert.equal(knownWaitView(s,50000).waitMs,10000);assert.equal(knownWaitView({taskId:'old',ms:{model:9000}}),null);assert.equal(knownWaitView(null),null);
 const a={id:'p',taskId:'t',at:2000,expiresAt:5000,status:'pending'};s=captureKnownApprovals(s,{id:'t',status:'running'},[a],9000);s=captureKnownApprovals(s,{id:'t',status:'running'},[a],15000);assert.equal(knownWaitView(s,15000).approvalMs,3000);
});
test('model and browser accounting records real boundaries independent of status polling',async()=>{
 const f=fixture({running:true,revision:2});f.info.task={id:'known',status:'running'};f.data.set('lastTask',f.info.task);f.data.set('taskWaitMetrics',newKnownWait('known',Date.now()-1000));
 const a=await f.g.beginModelCall();assert.ok(f.data.get('taskWaitMetrics').open['model:'+a.callId]);await f.g.modelProgress({...a,responseStarted:true,text:'',done:false});assert.equal(f.data.get('taskWaitMetrics').open['model:'+a.callId],undefined);assert.ok(f.data.get('taskWaitMetrics').open['stream:'+a.callId]);await f.g.modelProgress({...a,text:'',done:true});assert.equal(f.data.get('taskWaitMetrics').open['stream:'+a.callId],undefined);
 const token=await f.g.acquireSiteCheck();assert.equal(Object.keys(f.data.get('taskWaitMetrics').open).length,0);await f.g.beginBrowserWait(token);assert.ok(f.data.get('taskWaitMetrics').open['browser:'+token]);await f.g.endBrowserWait(token);assert.equal(Object.keys(f.data.get('taskWaitMetrics').open).length,0);await f.g.releaseSiteCheck(token);
});
