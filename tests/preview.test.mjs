import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { previewServer, previewHeaders } from '../src/preview.js';

test('static preview authenticates, confines reads, rejects hidden/symlink/large files and closes', async () => {
  const files = new Map([
    ['/data/workspace', { dir: true }],
    ['/data/workspace/site', { dir: true }],
    ['/data/workspace/site/index.html', { text: '<h1>Preview</h1>' }],
    ['/data/workspace/site/app.js', { text: 'document.title="OK"' }],
    ['/data/workspace/site/.env', { text: 'secret' }],
    ['/data/state.json', { text: 'private' }],
    ['/data/workspace/site/big.png', { size: 6000000 }]
  ]);
  let handler;
  const missing = () => { const e = new Error('missing'); e.code = 'ENOENT'; throw e; };
  const context = vm.createContext({
    URL, Buffer, process: { env: { DSH_PREVIEW_SECRET: 'test-capability' } },
    http: { createServer(fn) { handler = fn; return { listen() {} }; } }, path,
    async realpath(name) { if (name === '/data/workspace/site/out.html') return '/data/state.json'; if (!files.has(name)) missing(); return name; },
    async stat(name) { const f = files.get(name); if (!f) missing(); return { isDirectory: () => !!f.dir, isFile: () => !f.dir, size: f.size || (f.text || '').length }; },
    async readFile(name) { const f = files.get(name); if (!f) missing(); return Buffer.from(f.text || ''); }
  });
  vm.runInContext(previewServer.replace(/^import .*;\n/gm, ''), context);
  async function request(url, { method = 'GET', secret = 'test-capability', body } = {}) {
    let status, text;
    const req = { method, url, headers: { 'x-dsh-preview': secret }, async *[Symbol.asyncIterator]() { if (body) yield JSON.stringify(body); } };
    const res = { writeHead(code) { status = code; }, end(bytes) { text = String(bytes); } };
    await handler(req, res); return { status, text };
  }
  assert.equal((await request('/_health', { secret: 'wrong' })).status, 403);
  assert.equal((await request('/index.html')).status, 404);
  assert.equal((await request('/_configure', { method: 'POST', body: { root: '../' } })).status, 400);
  assert.equal((await request('/_configure', { method: 'POST', body: { root: 'site' } })).status, 200);
  assert.equal((await request('/index.html')).text, '<h1>Preview</h1>');
  assert.equal((await request('/app.js')).status, 200);
  assert.equal((await request('/.env')).status, 403);
  assert.equal((await request('/out.html')).status, 403);
  assert.equal((await request('/big.png')).status, 413);
  assert.equal((await request('/missing.html')).status, 404);
  assert.equal((await request('/index.html', { method: 'POST' })).status, 404);
  await request('/_configure', { method: 'POST', body: { root: null } });
  assert.equal((await request('/index.html')).status, 404);
});

test('preview stays opaque and cannot reach network, forms or nested frames', () => {
  const headers = previewHeaders();
  const csp = headers['content-security-policy'];
  assert.match(csp, /sandbox allow-scripts;/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-forms|allow-top-navigation/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.equal(headers['cache-control'], 'no-store');
});

test('preview panel uses a sandboxed iframe, not generated HTML in the console DOM', async () => {
  const source = await readFile(new URL('../src/page.js', import.meta.url), 'utf8');
  assert.match(source, /sandbox="allow-scripts"/);
  assert.match(source, /api\('preview\/open'/);
  assert.match(source, /api\('preview\/close'/);
});

test('website automatically self-checks and presents evidence in the agent response', async () => {
 const source=await readFile(new URL('../src/page.js',import.meta.url),'utf8');
 assert.match(source,/通过 Cloudflare Browser Run 真实检查翻页/);
 assert.match(source,/node \/app\/site-check.mjs review-deck/);
 assert.ok(source.indexOf('id="evidence-desktop"')>source.indexOf('id="output"'));
 assert.doesNotMatch(source,/id="demo-check"|class="advanced card"/);
 assert.match(source,/allowed-once/);
 assert.match(source,/approvals\/decide/);
});
