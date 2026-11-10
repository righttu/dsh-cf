// Explicit, deterministic preparation before entering the DSH model loop.
import {mkdir,realpath,lstat,copyFile,open,readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {summarizeCsv} from './build-review-deck.mjs';
export async function prepareDemoEnvironment(workspace='/data/workspace'){
 const check=await readFile(new URL('./site-check.mjs',import.meta.url),'utf8');if(!check.includes('dsh-selfcheck.internal'))throw Error('浏览器检查客户端未就绪');
 workspace=await realpath(workspace);const expected=path.join(workspace,'review-deck');await mkdir(expected,{recursive:true});const root=await realpath(expected);if(root!==expected)throw Error('演示目录不能是符号链接');
 const csvPath=path.join(root,'sales.csv');let csvCreated=false;
 try{await copyFile(new URL('./demo-sales.csv',import.meta.url),csvPath,constants.COPYFILE_EXCL);csvCreated=true}catch(e){if(e.code!=='EEXIST')throw e}
 const csvInfo=await lstat(csvPath);if(!csvInfo.isFile())throw Error('CSV 必须为普通文件，不能是符号链接或管道');
 const handle=await open(csvPath,constants.O_RDONLY|constants.O_NOFOLLOW);let csv;try{const st=await handle.stat();if(!st.isFile()||st.size>1024*1024)throw Error('CSV 必须为不超过 1 MiB 的普通文件');csv=await handle.readFile('utf8')}finally{await handle.close()}
 const data=summarizeCsv(csv),output=path.join(root,'report-data.json');try{const st=await lstat(output);if(!st.isFile())throw Error('report-data.json 不是普通文件，未覆盖')}catch(e){if(e.code!=='ENOENT')throw e}
 const tmp=output+'.'+randomUUID()+'.tmp';try{await writeFile(tmp,JSON.stringify(data,null,2),{flag:'wx',mode:0o600});await rename(tmp,output)}finally{await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e})}
 return {ready:true,environmentVersion:1,root,csvCreated,csvReused:!csvCreated,totalRevenue:data.totalRevenue,period:{from:data.monthly[0].label,to:data.monthly.at(-1).label},rows:data.rowCount,browserClientReady:true,browserTestRun:false};
}
