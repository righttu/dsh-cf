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
