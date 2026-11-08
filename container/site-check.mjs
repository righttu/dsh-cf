// Agent-run self-check client. The browser runs in Cloudflare Browser Run, not here.
// Website contract: data-testid=filter-coffee, filter-all, add-item, cart-count,
// reset-cart; menu cards: data-testid=menu-card and data-category=coffee for coffee.
// cart-count must contain only its numeric quantity. Agent must repair failures and rerun.
import path from 'node:path';
import { realpath, writeFile } from 'node:fs/promises';
const workspace=await realpath('/data/workspace');
const root=await realpath(path.resolve(workspace,process.argv[2]||'coffee-site'));
if(root===workspace||!root.startsWith(workspace+path.sep))throw Error('Check a website subdirectory only');
const relative=path.relative(workspace,root);
const reportPath=path.join(root,'selfcheck-report.json');
try{
 const response=await fetch('https://dsh-selfcheck.internal/check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({root:relative}),signal:AbortSignal.timeout(180000)});
 const result=await response.json();if(!response.ok)throw Error(result.error||'Self-check HTTP '+response.status);
 const {report,images}=result;if(!report||report.engine!=='Cloudflare Browser Run'||!Array.isArray(report.checks))throw Error('Invalid browser report');
 report.root=root;
 for(const file of report.screenshots||[]){if(!['selfcheck-desktop.png','selfcheck-mobile.png'].includes(file))throw Error('Unexpected screenshot name');const encoded=images?.[file];if(typeof encoded!=='string'||encoded.length>7*1024*1024)throw Error('Invalid screenshot');const bytes=Buffer.from(encoded,'base64');if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Not a PNG screenshot');await writeFile(path.join(root,file),bytes)}
 await writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
}catch(e){const report={engine:'Cloudflare Browser Run',root,finishedAt:Date.now(),passed:false,screenshots:[],checks:[{name:'托管浏览器自检',passed:false,error:String(e.message).slice(0,1600)}]};await writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));process.exitCode=1}
