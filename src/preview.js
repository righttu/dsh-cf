// A small static preview server, installed via exec even when resuming an old image.
// No shell interpolation, package downloads, deployment credentials or new egress.
export const previewServer = String.raw`
import http from 'node:http';
import { realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
const secret=process.env.DSH_PREVIEW_SECRET;
let root=null;
const mime={'.csv':'text/csv; charset=utf-8','.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2'};
const within=(base,file)=>file===base||file.startsWith(base+path.sep);
http.createServer(async(req,res)=>{
 const end=(code,text)=>{res.writeHead(code,{'content-type':'text/plain; charset=utf-8'});res.end(text)};
 if(req.headers['x-dsh-preview']!==secret)return end(403,'Forbidden');
 try{
  if(req.method==='GET'&&req.url==='/_health')return end(200,'dsh-static-preview-v1');
  if(req.method==='POST'&&req.url==='/_configure'){
   let text='';for await(const chunk of req){text+=chunk;if(text.length>2048)return end(413,'Too large')}
   const body=JSON.parse(text);
   if(body.root===null){root=null;return end(200,'Closed')}
   if(typeof body.root!=='string'||body.root.split(/[\\/]/).some(x=>x==='..'||x.startsWith('.')))return end(400,'Invalid directory');
   const workspace=await realpath('/data/workspace');
   const next=await realpath(path.resolve(workspace,body.root));
   if(!within(workspace,next)||!(await stat(next)).isDirectory())return end(403,'Directory outside workspace');
   const index=await realpath(path.join(next,'index.html'));
   if(!within(next,index))return end(403,'Invalid index.html');
   root=next;return end(200,'Ready');
  }
  if(req.method!=='GET'||!root)return end(404,'Preview not open');
  const pathname=decodeURIComponent(new URL(req.url,'http://preview').pathname);
  if(pathname.split(/[\\/]/).some(x=>x==='..'||x.startsWith('.')))return end(403,'Hidden files are not previewable');
  let file=await realpath(path.join(root,pathname));
  if(!within(root,file))return end(403,'Outside preview directory');
  let info=await stat(file);
  if(info.isDirectory()){file=await realpath(path.join(file,'index.html'));if(!within(root,file))return end(403,'Outside preview directory');info=await stat(file)}
  const type=mime[path.extname(file).toLowerCase()];
  if(!type||!info.isFile())return end(403,'Unsupported preview file');
  if(info.size>5*1024*1024)return end(413,'Preview file exceeds 5 MiB');
  const bytes=await readFile(file);res.writeHead(200,{'content-type':type});res.end(bytes);
 }catch(e){end(e.code==='ENOENT'?404:400,e.code==='ENOENT'?'File or index.html not found':'Cannot read preview file')}
}).listen(8090,'0.0.0.0');
`;

export function previewHeaders() {
  return {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    // Opaque origin: preview JavaScript cannot read the console or issue API calls.
    'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
  };
}
