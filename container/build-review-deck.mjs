// Deterministic demo renderer: reuse CSV; never ask the model to rewrite a whole deck.
import {readFile,writeFile,rename,unlink,realpath,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
export function summarizeCsv(text){
 const rows=text.trim().split(/\r?\n/).map(s=>s.split(',').map(v=>v.trim()));const header=rows.shift()||[];const columns=['month','region','revenue'].map(c=>header.indexOf(c));
 if(columns.some(i=>i<0)||!rows.length)throw Error('sales.csv 需包含 month,region,revenue 和至少一行数据');
 const monthly=new Map(),regional=new Map();let totalRevenue=0;
 for(const row of rows){if(row.length!==header.length||columns.some(i=>!row[i]))throw Error('CSV 存在空值或不支持的引号/逗号格式');const [month,region,raw]=columns.map(i=>row[i]);const value=Number(raw);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!Number.isFinite(value)||value<0)throw Error('月份需 YYYY-MM，收入需非负有限数字');totalRevenue+=value;monthly.set(month,(monthly.get(month)||0)+value);regional.set(region,(regional.get(region)||0)+value);}
 if(!Number.isFinite(totalRevenue))throw Error('收入总额超出范围');
 if(monthly.size>6||regional.size>5)throw Error('快速演示支持最多 6 个月、5 个区域，请先选择数据范围');
 return {totalRevenue,monthly:[...monthly].sort(([a],[b])=>a.localeCompare(b)).map(([label,value])=>({label,value})),regional:[...regional].sort((a,b)=>b[1]-a[1]).map(([label,value])=>({label,value})),rowCount:rows.length};
}
async function atomicWrite(file,text){const tmp=file+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,text,{flag:'wx',mode:0o600});await rename(tmp,file)}finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e})}}
export async function buildReviewDeck(root){
 root=await realpath(root);const csvPath=path.join(root,'sales.csv');const handle=await open(csvPath,constants.O_RDONLY|constants.O_NOFOLLOW);let csv;try{const st=await handle.stat();if(!st.isFile()||st.size>1024*1024)throw Error('CSV 需是小于 1 MiB 的普通文件');csv=await handle.readFile('utf8')}finally{await handle.close()}
 const data=summarizeCsv(csv);const template=await readFile(new URL('./deck-template.html',import.meta.url),'utf8');
 for(const name of ['index.html','report-data.json']){try{const st=await lstat(path.join(root,name));if(!st.isFile()||st.isSymbolicLink())throw Error(name+' 不是普通文件，拒绝覆盖')}catch(e){if(e.code!=='ENOENT')throw e}}
 const json=JSON.stringify(data).replace(/</g,'\\u003c');const html=template.replace('__DSH_DECK_DATA__',()=>json);
 await atomicWrite(path.join(root,'report-data.json'),JSON.stringify(data,null,2));await atomicWrite(path.join(root,'index.html'),html);
 return {root,slides:3,...data,updated:['index.html','report-data.json'],csvReused:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const workspace=await realpath('/data/workspace'),root=await realpath(path.resolve(workspace,process.argv[2]||'review-deck'));if(root===workspace||!root.startsWith(workspace+path.sep))throw Error('仅允许工作区内的演示稿子目录');console.log(JSON.stringify(await buildReviewDeck(root)))}catch(e){console.error(e.message);process.exitCode=1}
}
