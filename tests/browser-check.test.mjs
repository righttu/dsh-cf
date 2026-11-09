import { Script } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sessionOptions, createCdp, checkWebsite } from '../src/browser-check.js';

test('managed browser only permits the private site and routes it through scoped Fetcher',()=>{
 const site={fetch(){}};const options=sessionOptions(site);
 assert.deepEqual(options.guardrails,{allowedDomains:['dsh-site.test']});
 assert.equal(options.outboundByHost['dsh-site.test'],site);
 assert.equal(Object.keys(options.outboundByHost).length,1);
});
test('CDP returns actual protocol results and propagates errors and disconnects',async()=>{
 const socket=new EventTarget();let command;
 socket.send=text=>{command=JSON.parse(text)};
 const emit=value=>{const e=new Event('message');e.data=JSON.stringify(value);socket.dispatchEvent(e)};
 const cdp=createCdp(socket);
 const first=cdp.send('Page.navigate',{url:'http://dsh-site.test'});assert.equal(command.method,'Page.navigate');emit({id:command.id,result:{frameId:'real-frame'}});assert.deepEqual(await first,{frameId:'real-frame'});
 const second=cdp.send('Page.captureScreenshot');emit({id:command.id,error:{message:'capture failed'}});await assert.rejects(second,/capture failed/);
 const third=cdp.send('Runtime.evaluate');socket.dispatchEvent(new Event('close'));await assert.rejects(third,/closed/);
});
test('browser startup failure is recorded, not replaced with fabricated screenshots',async()=>{
 const result=await checkWebsite({async launch(){throw Error('binding unavailable')}},{});
 assert.equal(result.report.passed,false);assert.deepEqual(result.report.screenshots,[]);assert.deepEqual(result.images,{});assert.match(result.report.checks[0].error,/binding unavailable/);
});
test('Agent client uses controlled endpoint and image no longer installs a browser',async()=>{
 const helper=await readFile(new URL('../container/site-check.mjs',import.meta.url),'utf8');
 const docker=await readFile(new URL('../Dockerfile',import.meta.url),'utf8');
 const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 assert.match(helper,/https:\/\/dsh-selfcheck.internal\/check/);assert.doesNotMatch(helper,/from 'playwright-core'|chromium.launch/);
 assert.doesNotMatch(docker,/install.*chromium/);assert.equal(config.browser.binding,'BROWSER');
});

test('explicitly connect a page target and report connection failures without screenshots',async()=>{
 let closed=false,selected;
 const binding={async launch(options){assert.equal(options.targets,true);return {sessionId:'browser-session',targets:[{id:'page-1',type:'page'}]}},async connectSession(id,options){assert.equal(id,'browser-session');selected=options.targetId;throw Error('connection unavailable')},async closeSession(){closed=true}};
 const {report,images}=await checkWebsite(binding,{});
 assert.equal(selected,'page-1');assert.equal(closed,true);assert.equal(report.failedStage,'connect-page');assert.equal(report.failureKind,'infrastructure');assert.equal(report.retryable,false);assert.equal(report.passed,false);assert.deepEqual(images,{});
});
test('create missing page target; failed navigation never runs site assertions or captures blank evidence',async()=>{
 const socket=new EventTarget();const commands=[];
 socket.accept=()=>{};socket.close=()=>socket.dispatchEvent(new Event('close'));
 socket.send=text=>{const command=JSON.parse(text);commands.push(command.method);queueMicrotask(()=>{const e=new Event('message');e.data=JSON.stringify({id:command.id,result:command.method==='Page.navigate'?{errorText:'navigation rejected'}:{}});socket.dispatchEvent(e)})};
 let created=false;
 const binding={async launch(){return {sessionId:'s',targets:[]}},devtools:{async newTarget(){created=true;return {id:'new-page',type:'page'}}},async connectSession(id,options){assert.equal(options.targetId,'new-page');return {webSocket:{async fetch(){return {webSocket:socket}}}}},async closeSession(){}};
 const {report}=await checkWebsite(binding,{});
 assert.equal(created,true);assert.equal(report.failedStage,'navigate');assert.equal(report.failureKind,'navigation');assert.equal(report.passed,false);assert.deepEqual(report.screenshots,[]);assert.equal(commands.includes('Page.captureScreenshot'),false);assert.equal(commands.includes('Runtime.evaluate'),false);
});

test('presentation checks validate real navigation and data without weakening browser CSP',async()=>{
 const source=await readFile(new URL('../src/browser-check.js',import.meta.url),'utf8');
 assert.match(source,/前后翻页与页码一致/);assert.match(source,/CSV、计算结果与显示指标一致/);assert.match(source,/site.fetch/);assert.doesNotMatch(source,/filter-coffee|cart-count/);
 const preview=await readFile(new URL('../src/preview.js',import.meta.url),'utf8');assert.match(preview,/connect-src 'none'/);assert.match(preview,/text\/csv/);
});

test('presentation workflow compiles every CDP assertion and checks data through scoped Fetcher',async()=>{
 const socket=new EventTarget(),expressions=[];socket.accept=()=>{};socket.close=()=>socket.dispatchEvent(new Event('close'));
 socket.send=text=>{const cmd=JSON.parse(text);if(cmd.method==='Runtime.evaluate'){new Script(cmd.params.expression);expressions.push(cmd.params.expression)}let result={};if(cmd.method==='Runtime.evaluate')result={result:{value:true}};if(cmd.method==='Page.getLayoutMetrics')result={cssContentSize:{width:1280,height:900}};if(cmd.method==='Page.captureScreenshot')result={data:'mock-png-for-unit-test'};queueMicrotask(()=>{const e=new Event('message');e.data=JSON.stringify({id:cmd.id,result});socket.dispatchEvent(e)})};
 const paths=[],site={async fetch(req){paths.push(new URL(req.url).pathname);return req.url.endsWith('.csv')?new Response('month,region,revenue\n2026-01,South,10\n2026-02,South,20'):Response.json({totalRevenue:30})}};
 const binding={async launch(){return {sessionId:'s',targets:[{id:'page',type:'page'}]}},async connectSession(){return {webSocket:{async fetch(){return {webSocket:socket}}}}},async closeSession(){}};
 const {report}=await checkWebsite(binding,site);assert.equal(report.passed,true);assert.deepEqual(paths,['/sales.csv','/report-data.json']);assert.ok(expressions.some(x=>x.includes('shown!==30')));assert.equal(report.screenshots.length,2);
});
