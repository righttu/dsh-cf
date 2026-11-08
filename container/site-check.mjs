// Agent invokes this real browser check after creating the website; no synthetic screenshots.
import http from 'node:http';
import path from 'node:path';
import { realpath, readFile, writeFile, stat } from 'node:fs/promises';
import { chromium } from 'playwright-core';
const workspace=await realpath('/data/workspace');
const root=await realpath(path.resolve(workspace,process.argv[2]||'coffee-site'));
const within=(base,file)=>file===base||file.startsWith(base+path.sep);
if(root===workspace||!within(workspace,root))throw Error('Check a website subdirectory only');
const types={'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.woff2':'font/woff2'};
const server=http.createServer(async(req,res)=>{try{
 if(req.method!=='GET'){res.writeHead(405);return res.end()}
 const name=decodeURIComponent(new URL(req.url,'http://local').pathname);
 if(name.split(/[\\/]/).some(s=>s.startsWith('.')))throw Error('Hidden path');
 let file=await realpath(path.join(root,name));if(!within(root,file))throw Error('Outside site');
 if((await stat(file)).isDirectory())file=await realpath(path.join(file,'index.html'));
 if(!within(root,file))throw Error('Outside site');
 const bytes=await readFile(file);res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','content-security-policy':"sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"});res.end(bytes);
}catch{res.writeHead(404);res.end('Not found')}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const report={startedAt:Date.now(),root,checks:[],errors:[],screenshots:[]};let browser;
const check=async(name,fn)=>{try{await fn();report.checks.push({name,passed:true})}catch(e){report.checks.push({name,passed:false,error:String(e.message).slice(0,1500)})}};
try{
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);
 page.on('pageerror',e=>report.errors.push({kind:'pageerror',message:e.message}));
 page.on('requestfailed',r=>report.errors.push({kind:'requestfailed',url:r.url(),error:r.failure()?.errorText}));
 page.on('response',r=>{if(r.status()>=400)report.errors.push({kind:'http',url:r.url(),status:r.status()})});
 await check('入口加载',async()=>{const r=await page.goto('http://127.0.0.1:'+server.address().port+'/index.html',{waitUntil:'networkidle',timeout:20000});if(r.status()!==200)throw Error('HTTP '+r.status());if(!(await page.title()))throw Error('Missing document title')});
 await check('咖啡分类筛选',async()=>{await page.getByTestId('filter-coffee').click();const cards=page.locator('[data-testid="menu-card"]:visible');if(await cards.count()===0)throw Error('No visible coffee cards');for(const card of await cards.all()){if(await card.getAttribute('data-category')!=='coffee')throw Error('Non-coffee item remains visible')}});
 await check('加入购物清单',async()=>{await page.getByTestId('add-item').filter({visible:true}).first().click();if(Number(await page.getByTestId('cart-count').textContent())<1)throw Error('Cart count did not increase')});
 await check('重置购物清单',async()=>{await page.getByTestId('reset-cart').click();if(Number(await page.getByTestId('cart-count').textContent())!==0)throw Error('Cart count not reset')});
 await check('恢复完整菜单',async()=>{await page.getByTestId('filter-all').click()});
 for(const [name,width,height] of [['selfcheck-desktop.png',1280,900],['selfcheck-mobile.png',390,844]]){
  await page.setViewportSize({width,height});await page.screenshot({path:path.join(root,name),fullPage:true,timeout:15000});report.screenshots.push(name);
 }
 await check('无页面脚本或资源错误',async()=>{if(report.errors.length)throw Error(JSON.stringify(report.errors).slice(0,1500))});
}catch(e){report.checks.push({name:'浏览器检查流程',passed:false,error:String(e.message)})}
finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));report.finishedAt=Date.now();report.passed=report.checks.length>0&&report.checks.every(c=>c.passed);await writeFile(path.join(root,'selfcheck-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1}
