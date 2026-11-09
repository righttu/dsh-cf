import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
const raw = await readFile(new URL('../src/snapshot-lab.js', import.meta.url), 'utf8');
const prelude = 'class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }\n';
const { SnapshotLab, probeScript, labPage } = await import('data:text/javascript;base64,' + Buffer.from(prelude + raw.replace(/^import .*;\n/gm, '')).toString('base64'));
function fixture(failAt = -1) {
  const store = new Map(), starts = [], calls = [];
  const container = {
    running: false, images: { dsh: 'immutable-image-digest' },
    start(options) { starts.push(structuredClone(options)); this.running=true; if (starts.length-1 === failAt) throw Error('test startup failure'); },
    async setInactivityTimeout() {}, monitor() { return Promise.resolve(); },
    async exec() { calls.push('exec'); const evidence = { files: [{ exists:true, sha256:'test' }, { exists:true, sha256:'test' }], expectedHash:'test', filesystem:{totalBytes:16000000000} }; return { async output() { return { exitCode:0, stdout:new TextEncoder().encode(JSON.stringify(evidence)), stderr:new Uint8Array() }; } }; },
    async snapshotContainer() { calls.push('snapshot'); return {id:'test-snapshot',size:12345}; },
    async destroy() { calls.push('destroy'); this.running=false; }
  };
  const storage = { async get(k) { return store.has(k)?structuredClone(store.get(k)):undefined; }, async put(k,v) { store.set(k,structuredClone(v)); }, async delete(k) { store.delete(k); } };
  return { lab:new SnapshotLab({container,storage},{}), starts,calls,container };
}
test('separate image controls, same snapshot, CPU/memory fixed, and requested shrink recorded',async()=>{
  const f=fixture(); for(let i=0;i<4;i++) await f.lab.step();
  const s=await f.lab.status(); assert.equal(s.phase,'complete');
  assert.deepEqual(f.starts.map(x=>x.instance.diskMb),[8000,16000,16000,8000]);
  assert.ok(f.starts.every(x=>x.instance.vcpu===1&&x.instance.memoryMib===3072&&x.enableInternet===false));
  assert.equal(f.starts[0].image,f.starts[1].image);
  assert.equal(f.starts[2].containerSnapshot.id,f.starts[3].containerSnapshot.id);
  assert.equal('image' in f.starts[3],false);
  assert.equal(s.results[3].evidence.filesystem.totalBytes,16000000000,'must retain measured capacity even if it differs from request');
  assert.equal(f.container.running,false); assert.equal(f.calls.filter(x=>x==='snapshot').length,1);
});
test('failed baseline blocks inference; final shrink failure remains recorded',async()=>{
  const baseline=fixture(0); assert.equal((await baseline.lab.step()).phase,'blocked'); await assert.rejects(()=>baseline.lab.step(),/重置/);
  const shrink=fixture(3); for(let i=0;i<4;i++) await shrink.lab.step();
  const state=await shrink.lab.status(); assert.equal(state.phase,'complete'); assert.equal(state.results[3].ok,false); assert.match(state.results[3].error,/startup failure/); assert.equal(shrink.container.running,false);
});
test('probe and page scripts compile; no R2 or DSH calls; reset cleans test container',async()=>{
  new Script(probeScript('test',true)); new Script(probeScript('test',false));
  new Script(labPage.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace('await call();','call();'));
  assert.doesNotMatch(raw,/this\.env\.(DSH|BACKUPS|AI)/);
  const f=fixture(); await f.lab.step(); const s=await f.lab.reset(); assert.equal(s.next,0); assert.equal(f.container.running,false);
});
