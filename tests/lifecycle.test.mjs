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
const { DshAgent, validateInstance } = await import('data:text/javascript;base64,' + Buffer.from(prelude + stripped).toString('base64'));
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
test('stopped environment cannot silently wake to switch version or size',async()=>{
 const f=versionFixture({running:false});
 await assert.rejects(f.g.changeVersion({version:'v2',confirm:true}),/环境已停止/);
 await assert.rejects(f.g.changeInstance({instance:'standard-2',confirm:true}),/环境已停止/);
 assert.ok(!f.events.includes('backup'));assert.ok(!f.events.some(x=>Array.isArray(x)&&x[0]==='start'));
});
test('smaller disk switches through fresh R2 backup, not source snapshot',async()=>{
 const f=versionFixture();await f.g.changeInstance({instance:'standard-3',confirm:true});f.events.length=0;
 await f.g.changeInstance({instance:'standard-1',confirm:true});
 const start=f.events.find(x=>Array.isArray(x)&&x[0]==='start')[1];assert.equal(start.instance,'standard-1');assert.equal(start.containerSnapshot,undefined);assert.equal(start.image,'current-image');
 assert.ok(f.events.indexOf('backup')<f.events.indexOf('destroy'));assert.ok(f.events.indexOf('restore')>f.events.indexOf('destroy'));
 assert.equal(f.data.get('checkpoint').instance,'standard-1');
});
test('insufficient restore space retains larger source checkpoint for explicit recovery',async()=>{
 const f=versionFixture();await f.g.changeInstance({instance:'standard-3',confirm:true});const source=f.data.get('checkpoint');
 const restore=f.g.backups.restore.bind(f.g.backups);f.g.backups.restore=async()=>{throw Error('ENOSPC')};
 await assert.rejects(f.g.changeInstance({instance:'standard-1',confirm:true}),/ENOSPC/);
 assert.equal(f.data.get('checkpoint').snapshot.id,source.snapshot.id);assert.equal(f.data.get('selectedInstance'),'standard-3');assert.equal(f.c.running,false);
 f.g.backups.restore=restore;await f.g.restoreVersionSafety();assert.equal(f.data.get('activeInstance'),'standard-3');assert.equal(f.data.get('versionOperation'),null);
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
