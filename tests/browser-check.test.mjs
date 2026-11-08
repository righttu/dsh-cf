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
