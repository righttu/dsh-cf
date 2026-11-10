import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareDemoEnvironment} from '../container/demo-environment.mjs';
test('prepare supplies missing sample CSV and real computed data without generating HTML',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-env-'));try{const result=await prepareDemoEnvironment(root);assert.equal(result.ready,true);assert.equal(result.csvCreated,true);assert.equal(result.totalRevenue,990000);assert.equal(result.rows,9);assert.deepEqual(result.period,{from:'2026-01',to:'2026-03'});assert.equal(result.browserTestRun,false);await assert.rejects(readFile(path.join(root,'review-deck/index.html')),/ENOENT/);assert.equal(JSON.parse(await readFile(path.join(root,'review-deck/report-data.json'),'utf8')).totalRevenue,990000)}finally{await rm(root,{recursive:true,force:true})}
});
test('prepare reuses even different-quarter CSV and preserves old HTML and unrelated files',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-env-existing-'));try{const dir=path.join(root,'review-deck');await mkdir(dir);const csv='month,region,revenue\n2025-10,华南,20\n2025-11,华南,30\n';await writeFile(path.join(dir,'sales.csv'),csv);await writeFile(path.join(dir,'index.html'),'previous deck');await writeFile(path.join(root,'coffee.html'),'keep');for(let i=0;i<2;i++){const r=await prepareDemoEnvironment(root);assert.equal(r.csvReused,true);assert.equal(r.totalRevenue,50);assert.deepEqual(r.period,{from:'2025-10',to:'2025-11'})}assert.equal(await readFile(path.join(dir,'sales.csv'),'utf8'),csv);assert.equal(await readFile(path.join(dir,'index.html'),'utf8'),'previous deck');assert.equal(await readFile(path.join(root,'coffee.html'),'utf8'),'keep')}finally{await rm(root,{recursive:true,force:true})}
});
test('prepare refuses linked directories and linked data instead of modifying their targets',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-env-links-')),outside=await mkdtemp(path.join(os.tmpdir(),'dsh-env-outside-'));try{await symlink(outside,path.join(root,'review-deck'));await assert.rejects(prepareDemoEnvironment(root),/符号链接/);await rm(path.join(root,'review-deck'));await mkdir(path.join(root,'review-deck'));const csv='month,region,revenue\n2026-01,a,1\n';await writeFile(path.join(outside,'sales.csv'),csv);await symlink(path.join(outside,'sales.csv'),path.join(root,'review-deck/sales.csv'));await assert.rejects(prepareDemoEnvironment(root));assert.equal(await readFile(path.join(outside,'sales.csv'),'utf8'),csv)}finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true})}
});
