// Real managed Chrome checks. Browser requests can read only one active static preview.
const HOST = 'dsh-site.test';
export function sessionOptions(site) {
  return { keepAlive: 60000, guardrails: { allowedDomains: [HOST] }, outboundByHost: { [HOST]: site } };
}
export function createCdp(socket) {
  let next=0;const pending=new Map();const listeners=new Set();
  const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Browser connection closed'))}pending.clear()};
  socket.addEventListener('close',fail);socket.addEventListener('error',fail);
  socket.addEventListener('message',event=>{let m;try{m=JSON.parse(event.data)}catch{return}
    if(m.id){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}
    else for(const fn of listeners)fn(m);
  });
  return {on:fn=>listeners.add(fn),send(method,params={}){return new Promise((resolve,reject)=>{const id=++next;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Browser command timed out: '+method))},15000);pending.set(id,{resolve,reject,timer});try{socket.send(JSON.stringify({id,method,params}))}catch(e){clearTimeout(timer);pending.delete(id);reject(e)}})}};
}
export async function checkWebsite(binding,site) {
 const report={startedAt:Date.now(),engine:'Cloudflare Browser Run',checks:[],errors:[],screenshots:[]};const images={};let session,socket;
 const check=async(name,fn)=>{try{await fn();report.checks.push({name,passed:true})}catch(e){report.checks.push({name,passed:false,error:String(e.message).slice(0,1200)})}};
 try{
  session=await binding.launch(sessionOptions(site));
  const response=await session.webSocket.fetch('https://browser-binding.invalid',{headers:{Upgrade:'websocket'}});
  socket=response.webSocket;if(!socket)throw Error('Browser Run did not return a WebSocket');socket.accept();
  const cdp=createCdp(socket);
  cdp.on(m=>{if(report.errors.length>=30)return;if(m.method==='Runtime.exceptionThrown')report.errors.push({kind:'script',message:m.params.exceptionDetails.text});if(m.method==='Network.responseReceived'&&m.params.response.status>=400)report.errors.push({kind:'http',url:m.params.response.url,status:m.params.response.status});if(m.method==='Network.loadingFailed'&&!m.params.canceled)report.errors.push({kind:'network',error:m.params.errorText})});
  const evaluate=async expression=>{const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value};
  const testJs=async body=>{const result=await evaluate('(async()=>{'+body+';return true})()');if(result!==true)throw Error('Browser assertion did not pass')};
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
  await check('入口加载',async()=>{const r=await cdp.send('Page.navigate',{url:'http://'+HOST+'/index.html'});if(r.errorText)throw Error(r.errorText);let ready=false;for(let i=0;i<40;i++){try{ready=await evaluate('location.hostname === "'+HOST+'" && document.readyState === "complete" && !!document.title')}catch{}if(ready)break;await new Promise(r=>setTimeout(r,200))}if(!ready)throw Error('Page not ready or missing title')});
  const helpers='const find=id=>{const el=[...document.querySelectorAll("[data-testid]")].find(e=>e.dataset.testid===id&&e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden");if(!el)throw Error("Missing visible element: "+id);return el};const tick=()=>new Promise(r=>setTimeout(r,150));';
  await check('咖啡分类筛选',()=>testJs(helpers+'find("filter-coffee").click();await tick();const cards=[...document.querySelectorAll("[data-testid=menu-card]")].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden");if(!cards.length||cards.some(e=>e.dataset.category!=="coffee"))throw Error("Coffee filter assertion failed")'));
  await check('加入购物清单',()=>testJs(helpers+'find("add-item").click();await tick();const n=Number(find("cart-count").textContent);if(!Number.isFinite(n)||n<1)throw Error("Cart count did not increase")'));
  await check('重置购物清单',()=>testJs(helpers+'find("reset-cart").click();await tick();if(Number(find("cart-count").textContent)!==0)throw Error("Cart count did not reset")'));
  await check('恢复完整菜单',()=>testJs(helpers+'find("filter-all").click();await tick()'));
  for(const [name,width,height,mobile] of [['selfcheck-desktop.png',1280,900,false],['selfcheck-mobile.png',390,844,true]])await check(name,async()=>{
   await cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile});await new Promise(r=>setTimeout(r,200));
   const metrics=await cdp.send('Page.getLayoutMetrics');const size=metrics.cssContentSize||metrics.contentSize;
   const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width:Math.min(size.width,1600),height:Math.min(size.height,6000),scale:1}});
   if(!shot.data||shot.data.length>7*1024*1024)throw Error('Screenshot missing or too large');images[name]=shot.data;report.screenshots.push(name);
  });
  await check('无页面脚本或资源错误',async()=>{if(report.errors.length)throw Error(JSON.stringify(report.errors).slice(0,1200))});
 }catch(e){report.checks.push({name:'Browser Run 检查流程',passed:false,error:String(e.message).slice(0,1200)})}
 finally{try{socket?.close()}catch{}if(session)try{await binding.closeSession(session.sessionId)}catch{report.errors.push({kind:'cleanup',message:'Browser session close failed'})}}
 report.finishedAt=Date.now();report.passed=report.checks.length>0&&report.checks.every(c=>c.passed)&&!report.errors.length;
 return {report,images};
}
