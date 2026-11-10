import test from 'node:test';
import {Script} from 'node:vm';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildReviewDeck,summarizeCsv} from '../container/build-review-deck.mjs';
const csv='month,region,revenue\n2026-01,华南,120000\n2026-01,华东,100000\n2026-01,华北,80000\n2026-02,华南,130000\n2026-02,华东,110000\n2026-02,华北,85000\n2026-03,华南,150000\n2026-03,华东,120000\n2026-03,华北,95000\n';
test('demo reuses CSV and replaces only named artifacts; reruns are stable',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-demo-'));
 try{
 await writeFile(path.join(root,'sales.csv'),csv);await writeFile(path.join(root,'index.html'),'old five-slide output');await writeFile(path.join(root,'coffee.html'),'keep original coffee site');
 const result=await buildReviewDeck(root);assert.equal(result.totalRevenue,990000);assert.equal(result.slides,3);assert.deepEqual(result.monthly.map(x=>x.value),[300000,325000,365000]);assert.equal(result.regional[0].value,400000);
 const html=await readFile(path.join(root,'index.html'),'utf8');assert.equal((html.match(/data-testid="slide"/g)||[]).length,3);assert.ok(!html.includes('__DSH_DECK_DATA__'));assert.ok(html.includes('990000'));assert.ok(html.includes('ArrowRight'));assert.ok(html.includes('data-testid="total-revenue"'));for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))new Script(script[1]);
 assert.equal((JSON.parse(await readFile(path.join(root,'report-data.json'),'utf8'))).totalRevenue,990000);
 await buildReviewDeck(root);assert.equal(await readFile(path.join(root,'index.html'),'utf8'),html);assert.equal(await readFile(path.join(root,'sales.csv'),'utf8'),csv);assert.equal(await readFile(path.join(root,'coffee.html'),'utf8'),'keep original coffee site');
 }finally{await rm(root,{recursive:true,force:true})}
});
test('invalid or missing data stops without replacing existing output',async()=>{
 assert.throws(()=>summarizeCsv('month,region,revenue\n2026-13,a,10'),/月份/);assert.throws(()=>summarizeCsv('month,region,revenue\n2026-01,a,-10'),/收入/);assert.throws(()=>summarizeCsv('month,region,revenue\n2026-01,a,'),/空值/);
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-demo-invalid-'));try{await writeFile(path.join(root,'index.html'),'keep');await assert.rejects(buildReviewDeck(root),/ENOENT/);await writeFile(path.join(root,'sales.csv'),'month,region,revenue\n2026-01,a,no');await assert.rejects(buildReviewDeck(root),/收入/);assert.equal(await readFile(path.join(root,'index.html'),'utf8'),'keep')}finally{await rm(root,{recursive:true,force:true})}
});
test('embedded data cannot close the script and linked output is not followed',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-demo-safe-'));try{await writeFile(path.join(root,'sales.csv'),'month,region,revenue\n2026-01,</script><script>bad(),1');await buildReviewDeck(root);const html=await readFile(path.join(root,'index.html'),'utf8');assert.ok(!html.includes('</script><script>bad()'));await writeFile(path.join(root,'outside'),'untouched');await rm(path.join(root,'index.html'));await symlink(path.join(root,'outside'),path.join(root,'index.html'));await assert.rejects(buildReviewDeck(root),/不是普通文件/);assert.equal(await readFile(path.join(root,'outside'),'utf8'),'untouched')}finally{await rm(root,{recursive:true,force:true})}
});
test('Agent generates HTML then runs real browser checks in a prepared environment',async()=>{
 const page=await readFile(new URL('../src/page.js',import.meta.url),'utf8'),check=await readFile(new URL('../src/browser-check.js',import.meta.url),'utf8'),docker=await readFile(new URL('../Dockerfile',import.meta.url),'utf8');
 assert.match(page,/data-demo="web-deck-v1"/);assert.match(page,/写入该目录的 index.html/);assert.match(page,/允许整体更新本次 index.html/);assert.match(page,/发现功能问题就修复并复查/);assert.doesNotMatch(page,/node \/app\/build-review-deck.mjs review-deck|不做深度分析|不从零编写|旧运行环境若仍是咖啡网站检查约定/);assert.match(page,/node \/app\/site-check.mjs review-deck/);assert.match(page,/通过 Cloudflare Browser Run 真实检查翻页/);assert.ok(check.includes('[3,5].includes(slides().length)'));assert.match(docker,/COPY container\/demo-environment.mjs/);assert.match(page,/id="demo-prepare"/);assert.match(page,/id="refresh-image"/);
});
