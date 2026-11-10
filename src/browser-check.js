// Real managed Chrome checks. Browser requests can read only one active static preview.
const HOST = 'dsh-site.test';
export function sessionOptions(site) {
  return { targets: true, keepAlive: 60000, guardrails: { allowedDomains: [HOST] }, outboundByHost: { [HOST]: site } };
}
export function createCdp(socket) {
  let next=0;const pending=new Map();const listeners=new Set();
  const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Browser connection closed'))}pending.clear()};
  socket.addEventListener('close',fail);socket.addEventListener('error',fail);
  socket.addEventListener('message',event=>{let m;try{m=JSON.parse(event.data)}catch{return}
    if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(p.method+': '+m.error.message)):p.resolve(m.result)}
    else for(const fn of listeners)fn(m);
  });
  return {on:fn=>listeners.add(fn),send(method,params={}){return new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Browser command timed out: '+method))},15000);pending.set(id,{resolve,reject,timer,method});try{socket.send(JSON.stringify({id,method,params}))}catch(e){clearTimeout(timer);pending.delete(id);reject(e)}})}};
}
export async function checkWebsite(binding,site) {
 const report={startedAt:Date.now(),engine:'Cloudflare Browser Run',checks:[],errors:[],screenshots:[]};const images={};let session,socket;let stage='launch';
 const check=async(name,fn)=>{try{await fn();report.checks.push({name,passed:true});return true}catch(e){report.checks.push({name,passed:false,error:String(e.message).slice(0,1200)});return false}};
 try{
  session=await binding.launch(sessionOptions(site));
  stage='page-target';
  let target=session.targets?.find(t=>t.type==='page');
  if(!target)target=await binding.devtools.newTarget(session.sessionId);
  if(!target?.id)throw Error('Browser Run did not return a page target');
  stage='connect-page';
  const connection=await binding.connectSession(session.sessionId,{targetId:target.id});
  const response=await connection.webSocket.fetch('https://browser-binding.invalid',{headers:{Upgrade:'websocket'}});
  socket=response.webSocket;if(!socket)throw Error('Browser Run did not return a WebSocket');socket.accept();
  const cdp=createCdp(socket);
  cdp.on(m=>{if(report.errors.length>=30)return;if(m.method==='Runtime.exceptionThrown')report.errors.push({kind:'script',message:m.params.exceptionDetails.text});if(m.method==='Network.responseReceived'&&m.params.response.status>=400)report.errors.push({kind:'http',url:m.params.response.url,status:m.params.response.status});if(m.method==='Network.loadingFailed'&&!m.params.canceled)report.errors.push({kind:'network',error:m.params.errorText})});
  const evaluate=async expression=>{const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value};
  const testJs=async body=>{const result=await evaluate('(async()=>{'+body+';return true})()');if(result!==true)throw Error('Browser assertion did not pass')};
  stage='enable-page';
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:1,mobile:false});
  stage='navigate';
  const loaded=await check('入口加载',async()=>{const r=await cdp.send('Page.navigate',{url:'http://'+HOST+'/index.html'});if(r.errorText)throw Error(r.errorText);let ready=false;for(let i=0;i<40;i++){try{ready=await evaluate('location.hostname === "'+HOST+'" && document.readyState === "complete" && !!document.title')}catch{}if(ready)break;await new Promise(r=>setTimeout(r,200))}if(!ready)throw Error('Page not ready or missing title')});
  if(!loaded){report.failureKind='navigation';throw Error('入口未成功加载，已停止功能测试和截图')}
  stage='site-checks';
  const helpers='const visible=e=>!!e&&!!e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden";const find=id=>{const el=[...document.querySelectorAll("[data-testid]")].find(e=>e.dataset.testid===id&&visible(e));if(!el)throw Error("Missing visible element: "+id);return el};const tick=()=>new Promise(r=>setTimeout(r,80));const slides=()=>[...document.querySelectorAll("[data-testid=slide]")];const current=()=>{const a=slides().filter(visible);if(a.length!==1)throw Error("Exactly one slide must be visible");return slides().indexOf(a[0])};';
  await check('演示稿结构与内容',()=>testJs(helpers+'if(![3,5].includes(slides().length))throw Error("Expected three demo slides or five full slides");if(slides().some(s=>!s.querySelector("h1,h2,h3")||s.textContent.trim().length<10))throw Error("Slide content missing");current()'));
  await check('前后翻页与页码一致',()=>testJs(helpers+'const n=slides().length;for(let i=0;i<n&&current()>0;i++){find("slide-prev").click();await tick()}if(current()!==0)throw Error("Cannot return to first slide");for(let i=0;i<n;i++){if(current()!==i||find("slide-counter").textContent.trim()!==(i+1)+" / "+n)throw Error("Slide/counter mismatch");if(i<n-1){find("slide-next").click();await tick()}}for(let i=n-1;i>0;i--){find("slide-prev").click();await tick();if(current()!==i-1)throw Error("Previous slide failed")}'));
  await check('桌面宽屏逐页布局',()=>testJs(helpers+'const n=slides().length;for(let i=0;i<n;i++){const rect=slides()[current()].getBoundingClientRect();if(rect.width<innerWidth*0.6)throw Error("Slide is too narrow for desktop presentation");if(document.documentElement.scrollWidth>innerWidth+2||document.documentElement.scrollHeight>innerHeight+2)throw Error("Desktop slide must fit viewport");if(i<n-1){find("slide-next").click();await tick()}}for(let i=n-1;i>0;i--){find("slide-prev").click();await tick()}'));
  await check('CSV、计算结果与显示指标一致',async()=>{
   const a=await site.fetch(new Request('http://'+HOST+'/sales.csv')),r=await site.fetch(new Request('http://'+HOST+'/report-data.json'));
   if(!a.ok||!r.ok)throw Error('Data files unavailable');
   const lines=(await a.text()).trim().split(/\r?\n/).map(s=>s.split(',')),header=lines.shift(),col=header.indexOf('revenue');
   if(col<0||!lines.length)throw Error('Missing revenue CSV column');
   const values=lines.map(row=>Number(row[col]));if(values.some(n=>!Number.isFinite(n)||n<0))throw Error('Invalid revenue');
   const total=values.reduce((a,b)=>a+b,0),data=await r.json();if(data.totalRevenue!==total)throw Error('Computed total differs from CSV');
   await testJs(helpers+'const shown=Number(find("total-revenue").textContent.replace(/[,\\s]/g,""));if(shown!=='+JSON.stringify(total)+')throw Error("Displayed total differs from CSV")');
  });
  for(const [name,width,height,mobile] of [['selfcheck-desktop.png',1280,720,false]])await check(name,async()=>{
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});await new Promise(r=>setTimeout(r,200));
   await testJs('if(document.documentElement.scrollWidth>innerWidth+2)throw Error("Horizontal overflow")');
   const metrics=await cdp.send('Page.getLayoutMetrics');const size=metrics.cssContentSize||metrics.contentSize;
   const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:Math.min(size.width,1600),height:Math.min(size.height,6000),scale:1}});
   if(!shot.data||shot.data.length>7*1024*1024)throw Error('Screenshot missing or too large');images[name]=shot.data;report.screenshots.push(name);
  });
  await check('无页面脚本或资源错误',async()=>{if(report.errors.length)throw Error(JSON.stringify(report.errors).slice(0,1200))});
 }catch(e){report.failureKind ||= 'infrastructure';report.failedStage=stage;report.retryable=false;report.action='停止本轮浏览器自检并报告错误；Bash 提权不会修复浏览器连接，不要通过重复授权或换命令重试。';report.checks.push({name:'Browser Run 检查流程',passed:false,error:String(e.message).slice(0,1200)})}
 finally{try{socket?.close()}catch{}if(session)try{await binding.closeSession(session.sessionId)}catch{report.errors.push({kind:'cleanup',message:'Browser session close failed'})}}
 report.finishedAt=Date.now();report.passed=report.checks.length>0&&report.checks.every(c=>c.passed)&&!report.errors.length;
 return {report,images};
}
