import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script} from 'node:vm';
import {page} from '../src/page.js';
test('console script parses and all literal element references exist',()=>{
 const script=page.match(/<script>([\s\S]*)<\/script>/)[1];new Script(script);
 const ids=new Set([...page.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
 for(const m of script.matchAll(/el\('([^']+)'\)/g))assert.ok(ids.has(m[1]),m[1]);
});
test('both images use the same recipe with only the runtime version differing',async()=>{
 const c=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 const images=c.containers[0].images;assert.equal(images.dsh.dockerfile,images.v2.dockerfile);assert.equal(images.v2.build_vars.DSH_APP_VERSION,'v2');
 const d=await readFile(new URL('../Dockerfile',import.meta.url),'utf8');assert.match(d,/ARG DSH_APP_VERSION=v1/);assert.match(d,/\/app\/runtime-version.json/);
});

test('presentation task replaces coffee task without deleting user files',()=>{
 assert.match(page,/制作分析演示稿/);assert.match(page,/node \/app\/site-check.mjs review-deck/);assert.doesNotMatch(page,/制作咖啡馆网站|coffee-site/);
 assert.match(page,/instance-select/);assert.doesNotMatch(page,/暂不支持缩小磁盘/);
});

function uiFunctions(){
 const script=page.match(/<script>([\s\S]*)<\/script>/)[1];
 const nodes=new Map();const el=id=>{if(!nodes.has(id))nodes.set(id,{value:'hello',hidden:false});return nodes.get(id)};
 const context={el,document:{querySelectorAll:()=>[]},state:null,connected:true,pending:''};
 const buttons=script.slice(script.indexOf('function buttons()'),script.indexOf('async function api('));
 const instance=script.slice(script.indexOf('const instancePresets='),script.indexOf('let instanceTarget='));
 new Script(buttons+'\n'+instance).runInNewContext(context);return{context,el};
}
test('upgrade is available while stopped but disabled when busy, latest, disconnected or blocked',()=>{
 const {context:c,el}=uiFunctions();
 const base={running:true,busy:false,versions:{current:'v1',available:['v1','v2'],operation:null}};
 for(const patch of [{busy:true},{versions:{...base.versions,current:'v2'}},{versions:{...base.versions,available:['v1']}},{versions:{...base.versions,operation:{stage:'restoring'}}},{approvals:[{status:'pending'}]}]){
  c.state={...base,...patch};c.buttons();assert.equal(el('upgrade-version').disabled,true);assert.equal(el('upgrade-version').hidden,false);
 }
 c.state=base;c.connected=false;c.buttons();assert.equal(el('upgrade-version').disabled,true);
 c.connected=true;c.pending='version';c.buttons();assert.equal(el('upgrade-version').disabled,true);
 c.pending='';c.buttons();assert.equal(el('upgrade-version').disabled,false);c.state={...base,running:false};c.buttons();assert.equal(el('upgrade-version').disabled,false);assert.equal(el('instance-choose').disabled,true);assert.match(page,/将先自动唤醒已保存环境/);assert.match(page,/#upgrade-version:disabled/);assert.match(page,/#upgrade-version:not\(:disabled\)/);
});
test('configuration renders preset and custom CPU memory disk after a switch',()=>{
 const {context:c,el}=uiFunctions();c.renderInstance({current:'standard-1',source:'checkpoint'});
 assert.equal(el('instance-cpu-current').textContent,'0.5 vCPU');assert.equal(el('instance-memory-current').textContent,'4 GiB');assert.equal(el('instance-disk-current').textContent,'8 GB');
 c.renderInstance({current:{vcpu:2,memoryMib:6144,diskMb:16000},source:'startup-config'});
 assert.equal(el('instance-cpu-current').textContent,'2 vCPU');assert.equal(el('instance-memory-current').textContent,'6 GiB');assert.equal(el('instance-disk-current').textContent,'16 GB');
 assert.doesNotMatch(page,/Linux Container|<span>任务调度<\/span>|<span>文件目录<\/span>/);
});
test('snapshot experiment routes and deployment resources are removed',async()=>{
 const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));const source=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
 assert.equal(config.containers.length,1);assert.equal(config.containers[0].class_name,'DshAgent');assert.deepEqual(config.exports.SnapshotLab,{type:'durable-object',state:'deleted'});assert.deepEqual(config.exports.DshAgent,{type:'durable-object',storage:'sqlite'});assert.ok(!config.durable_objects.bindings.some(x=>x.name==='SNAPSHOT_LAB'));assert.doesNotMatch(source,/snapshot-lab|SNAPSHOT_LAB|SnapshotLab/);
});

test('progress uses plain labels and groups stop/start as one restart step',()=>{
 for(const label of ['启动实例','备份数据','生成快照','重启实例','恢复数据','检查运行状态','保存启动状态'])assert.ok(page.includes(label));
 assert.match(page,/\['stopping','starting'\]\.includes\(p\.stage\)/);assert.doesNotMatch(page,/\['safety-snapshot','保存原环境安全快照'\]/);
});

test('Flash adapter has room for tools and reasoning without changing the Gateway route',async()=>{
 const c=await readFile(new URL('../container/gateway.cordis.yml',import.meta.url),'utf8');
 assert.match(c,/contextWindow: 131072/);assert.match(c,/maxTokens: 32768/);
 const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));assert.equal(config.vars.AI_MODEL,'dynamic/dsh');assert.equal(config.vars.AI_GATEWAY_ID,'dsh-cf');
});

test('demo metrics are above the workspace and detailed timing is collapsed',()=>{
 const html=page.split('<script>')[0];const ids=[...html.matchAll(/id="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size,'each element ID must be unique');
 assert.ok(html.indexOf('class="demo-metrics"')<html.indexOf('class="layout"'));
 for(const id of ['boot-ms','first-text-ms'])assert.ok(html.indexOf('id="'+id+'"')<html.indexOf('class="layout"'));
 const timing=html.match(/<details class="card timing-details"[^>]*>([\s\S]*?)<\/details>/);assert.ok(timing);assert.doesNotMatch(timing[0].split('>')[0],/\bopen\b/);
 for(const id of ['init-ms','resume-ms','run-model-ms','dispatch-ms','boot-note','stream-state'])assert.ok(timing[1].includes('id="'+id+'"'));
 assert.ok(html.indexOf('id="wake"')>html.indexOf('id="confirm-restore"'));assert.ok(html.indexOf('id="wake"')<html.indexOf('id="speed-details"'));
 assert.match(html,/<summary>从备份恢复/);assert.doesNotMatch(html,/从 R2 备份恢复|自定义内存至少 3072 MiB \/ vCPU。费用随规格变化。/);
 assert.match(html,/min="3072"/);assert.match(html,/其他目录的修改不会迁移/);assert.match(html,/备份之后的新内容不在恢复版本中/);
});
