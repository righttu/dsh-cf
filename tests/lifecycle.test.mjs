import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the actual control-plane source with platform interfaces replaced by
// deterministic in-memory doubles. No Cloudflare account, network or model calls.
const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const stripped = source.replace(/^import .*;\n/gm, '').replace(/^export \{ DirectoryBackupGateway \} from .*;\n/gm, '');
const prelude = `
const page = '';
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
const { DshAgent } = await import('data:text/javascript;base64,' + Buffer.from(prelude + stripped).toString('base64'));
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
      async delete(key) { data.delete(key); }
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
