import { DurableObject } from 'cloudflare:workers';

export const labSteps = ['image-8GB', 'image-16GB-create-snapshot', 'snapshot-to-16GB', 'snapshot-to-8GB'];
const paths = ['/data/snapshot-lab-marker.txt', '/opt/snapshot-lab-marker.txt'];
export function probeScript(token, seed = false) {
  return `const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process');
const paths=${JSON.stringify(paths)}, token=${JSON.stringify(token)};
if(${seed}) for(const p of paths){fs.mkdirSync(require('node:path').dirname(p),{recursive:true});fs.writeFileSync(p,token);}
const files=paths.map(path=>({path,exists:fs.existsSync(path),sha256:fs.existsSync(path)?crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex'):null}));
const s=fs.statfsSync('/');const run=(cmd,args)=>{try{return cp.execFileSync(cmd,args,{encoding:'utf8',timeout:3000,maxBuffer:32768});}catch(e){return String(e.message);}};
console.log(JSON.stringify({files,expectedHash:crypto.createHash('sha256').update(token).digest('hex'),filesystem:{type:s.type,blockSize:s.bsize,blocks:s.blocks,totalBytes:s.bsize*s.blocks,availableBytes:s.bsize*s.bavail},df:run('df',['-B1','/','/data','/opt']),mountinfo:fs.readFileSync('/proc/self/mountinfo','utf8').slice(0,24000),lsblk:run('lsblk',['-b','-o','NAME,SIZE,FSTYPE,MOUNTPOINTS']),runtimeVersion:fs.existsSync('/app/runtime-version.json')?fs.readFileSync('/app/runtime-version.json','utf8'):null}));`;
}

// Separate DO/container: never addresses env.DSH, BACKUPS, AI, or Browser.
export class SnapshotLab extends DurableObject {
  async status() { return await this.ctx.storage.get('lab') || { next: 0, results: [], phase: 'idle' }; }
  async step() {
    if (this.busy) throw Error('实验步骤正在运行');
    this.busy = true;
    let timer;
    try {
      const state = await this.status();
      if (state.phase === 'running' || state.phase === 'blocked') throw Error('上一步中断或对照失败，请先重置实验');
      if (state.next >= labSteps.length) return state;
      const index = state.next;
      if (index >= 2 && !state.snapshot) throw Error('缺少快照');
      const c = this.ctx.container;
      if (c.running) throw Error('发现未清理的测试容器，请重置');
      const diskMb = index === 0 || index === 3 ? 8000 : 16000;
      const instance = { vcpu: 1, memoryMib: 3072, diskMb };
      state.token ||= crypto.randomUUID();
      state.image ||= c.images.dsh;
      state.phase = 'running';
      await this.ctx.storage.put('lab', state);
      const result = { step: labSteps[index], instance, source: index < 2 ? 'image' : 'containerSnapshot', imageReference: state.image, snapshotId: index >= 2 ? state.snapshot.id : null, startedAt: new Date().toISOString() };
      let monitorError = null;
      const started = Date.now();
      try {
        const options = { instance, entrypoint: ['sleep', '600'], enableInternet: false };
        if (index < 2) options.image = state.image;
        else options.containerSnapshot = state.snapshot;
        c.start(options);
        await c.setInactivityTimeout(120000);
        // Record asynchronous startup failures; start() alone is not readiness evidence.
        c.monitor().catch(e => { monitorError = String(e.message || e); });
        let timeout;
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => { timeout = true; reject(Error('测试启动/执行超时（90秒）')); }, 90000); });
        const operation = (async () => {
          const process = await c.exec(['node', '-e', probeScript(state.token, index === 1)]);
          const output = await process.output();
          if (output.exitCode !== 0) throw Error('探测命令失败: ' + new TextDecoder().decode(output.stderr).slice(0, 3000));
          const evidence = JSON.parse(new TextDecoder().decode(output.stdout));
          const filesMatch = evidence.files.every(f => f.exists && f.sha256 === evidence.expectedHash);
          if (index >= 1 && !filesMatch) throw Error('测试文件校验失败: ' + JSON.stringify(evidence));
          if (timeout) return;
          result.evidence = evidence;
          result.filesMatch = filesMatch;
          if (index === 1) {
            state.snapshot = await c.snapshotContainer({ name: 'isolated-16GB-to-8GB-test' });
            result.snapshot = state.snapshot;
          }
        })();
        await Promise.race([operation, deadline]);
        result.ok = true;
      } catch (e) {
        result.ok = false;
        result.error = String(e.message || e).slice(0, 5000);
      } finally {
        clearTimeout(timer);
        result.monitorError = monitorError;
        result.elapsedMs = Date.now() - started;
        try { await c.destroy(); result.stopped = true; } catch (e) { result.stopped = false; result.stopError = String(e.message || e); }
      }
      result.completedAt = new Date().toISOString();
      state.results.push(result);
      state.next++;
      state.phase = !result.stopped || (!result.ok && index < 3) ? 'blocked' : state.next === 4 ? 'complete' : 'ready';
      await this.ctx.storage.put('lab', state);
      return state;
    } finally { clearTimeout(timer); this.busy = false; }
  }
  async reset() {
    if (this.busy) throw Error('请等待当前步骤结束');
    this.busy = true;
    try {
      await this.ctx.container.destroy();
      const previous = await this.status();
      if (previous.results.length) await this.ctx.storage.put('previousLab', previous);
      await this.ctx.storage.delete('lab');
      return await this.status();
    } finally { this.busy = false; }
  }
}

export const labPage = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>快照跨规格隔离实验</title><style>body{font:16px system-ui;max-width:1000px;margin:28px auto;padding:0 16px}button{padding:10px;margin:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f4f6;color:#111;padding:16px}p{line-height:1.7}</style><h1>16 GB 快照 → 8 GB 实例</h1><p>独立测试容器，不访问现有 DSH 工作区，不使用 R2。CPU 固定 1 vCPU、内存 3072 MiB。每次点击只执行一个步骤，结束后停止测试容器；会产生运行及快照存储费用。测试仅写两个小文件，不覆盖所有数据规模。单位为 diskMb=16000 / 8000。</p><p>顺序：镜像启动 8 GB → 镜像启动 16 GB 并创建快照 → 快照恢复 16 GB → 同一快照恢复 8 GB。</p><p>成功执行命令并不证明磁盘容量已缩小。请比较各步骤 filesystem.totalBytes、df、挂载和块设备信息；结果不代表底层存储实现已被证明。</p><button id="next">执行下一步</button><button id="refresh">刷新结果</button><button id="reset">停止测试容器并重置记录</button><p id="message"></p><pre id="result">正在读取…</pre><script type="module">const out=document.getElementById('result'),msg=document.getElementById('message'),buttons=[...document.querySelectorAll('button')];async function call(action){buttons.forEach(b=>b.disabled=true);msg.textContent='处理中…';try{const r=await fetch('/api/snapshot-lab'+(action?'/'+action:''),{method:action?'POST':'GET'});const data=await r.json();out.textContent=JSON.stringify(data,null,2);if(!r.ok)throw Error(data.error||r.status);msg.textContent='结果已更新';}catch(e){msg.textContent=String(e.message);}finally{buttons.forEach(b=>b.disabled=false);}}document.getElementById('next').onclick=()=>call('step');document.getElementById('refresh').onclick=()=>call();document.getElementById('reset').onclick=()=>call('reset');await call();</script></html>`;
