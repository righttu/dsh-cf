export class ApprovalQueue {
 constructor(records,persist,ttl=300000){this.records=records;this.persist=persist;this.ttl=ttl;this.waiters=new Map()}
 view(){return this.records.slice(-30)}
 async request(params,taskId){
  const record={id:crypto.randomUUID(),taskId,sessionId:params.sessionId,toolName:String(params.toolName||'unknown').slice(0,200),callId:params.callId,reason:String(params.reason||'SDK 未提供申请原因或完整命令；不确定时请拒绝。').slice(0,8000),status:'pending',at:Date.now(),expiresAt:Date.now()+this.ttl};
  this.records.push(record);if(this.records.length>100)this.records.splice(0,this.records.length-100);
  let settle;const answer=new Promise(resolve=>{settle=resolve});
  const timer=setTimeout(()=>{void this.decide(record.id,'cancelled').catch(()=>{})},this.ttl);
  this.waiters.set(record.id,{settle,timer});
  try{await this.persist()}catch(e){clearTimeout(timer);this.waiters.delete(record.id);record.status='cancelled';throw e}
  return answer;
 }
 async decide(id,outcome){
  if(!['allowed-once','rejected','cancelled'].includes(outcome))throw Error('Invalid approval outcome');
  const record=this.records.find(a=>a.id===id),waiter=this.waiters.get(id);
  if(!record||record.status!=='pending'||!waiter)throw Error('权限申请已处理或已失效');
  if(Date.now()>=record.expiresAt)outcome='cancelled';
  record.status=outcome;record.finishedAt=Date.now();
  try{await this.persist()}catch(e){record.status='pending';delete record.finishedAt;throw e}
  clearTimeout(waiter.timer);this.waiters.delete(id);waiter.settle({outcome});return {id,outcome};
 }
 async cancelAll(){for(const id of [...this.waiters.keys()])await this.decide(id,'cancelled')}
}
