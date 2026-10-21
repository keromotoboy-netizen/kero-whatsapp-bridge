import {randomUUID} from 'node:crypto';

const CONFIRM='CLEAR_ARCHIVED_GROUP_MESSAGES_ONLY';
const groupId=jid=>typeof jid==='string' && /^\d+(?:-\d+)?@g\.us$/.test(jid);
const failure=code=>Object.assign(new Error(code),{code});
function exactObject(value,keys){
 return value && typeof value==='object' && !Array.isArray(value) &&
 Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
}

// Capabilities are deliberately limited: the only remote mutation is chatModify(clear).
// Plans live in memory, have a fixed message cutoff and are consumed before any I/O.
export function createArchivedGroupCleanup({getConnection,readState,refresh,lastMessage=()=>null,
 clock=Date.now,wait=ms=>new Promise(r=>setTimeout(r,ms)),ttlMs=300000,spacingMs=1000}){
 let plan=null,busy=false,active=null,last={running:false,acceptedGroups:0};
 const eligible=(jid,current)=>groupId(jid) && current.members.has(jid) && current.archived.has(jid) &&
 readState()?.chats?.[jid]?.id===jid && readState().chats[jid].archived===true;
 function connection(){const s=getConnection();if(!s)throw failure('WHATSAPP_NOT_CONNECTED');return s;}
 async function fresh(s){
  try{const current=await refresh(s);if(!(current?.members instanceof Set) || !(current?.archived instanceof Set))throw Error();
   if(connection()!==s)throw failure('CONNECTION_CHANGED');return current;
  }catch(error){if(error?.code==='CONNECTION_CHANGED')throw error;throw failure('STATE_REFRESH_FAILED');}
 }
 async function preview(body={}){
  if(!exactObject(body,[]))throw failure('INVALID_REQUEST');
  if(busy)throw failure('OPERATION_BUSY');
  // Reserve before awaiting: two simultaneous previews must never race an execution.
  busy=true;
  try{
   const socket=connection(),members=await fresh(socket),at=clock();
   const ids=Object.keys(readState()?.chats||{}).filter(jid=>eligible(jid,members)).sort();
   plan={id:randomUUID(),socket,ids,expires:at+ttlMs,cutoff:Math.floor(at/1000)-1};
   return {planId:plan.id,eligibleGroups:ids.length,cutoff:plan.cutoff,expiresAt:new Date(plan.expires).toISOString(),scope:'archived_groups_only',dryRun:true};
  }finally{busy=false;}
 }
 function start(body){
  if(!exactObject(body,['planId','confirm']) || typeof body.planId!=='string' || body.confirm!==CONFIRM)throw failure('INVALID_REQUEST');
  if(busy)throw failure('OPERATION_BUSY');
  if(!plan || plan.id!==body.planId)throw failure('PLAN_UNAVAILABLE');
  const p=plan;plan=null;
  if(clock()>=p.expires)throw failure('PLAN_EXPIRED');
  if(connection()!==p.socket)throw failure('CONNECTION_CHANGED');
  busy=true;
  last={running:true,eligibleGroups:p.ids.length,acceptedGroups:0,skippedGroups:0,failedGroups:0,unattemptedGroups:p.ids.length,
   cutoff:p.cutoff,scope:'archived_groups_only',verification:'server_ack_only',startedAt:new Date(clock()).toISOString()};
  active=(async()=>{
   try{
    for(let i=0;i<p.ids.length;i++){
     if(i)await wait(spacingMs);
     const members=await fresh(p.socket);
     if(getConnection()!==p.socket)throw failure('CONNECTION_CHANGED');
     const jid=p.ids[i];
     if(!eligible(jid,members)){last.skippedGroups++;last.unattemptedGroups--;continue;}
     try{
      const lm=lastMessage(jid);
      await p.socket.chatModify({clear:true,lastMessages:lm?[lm]:{lastMessageTimestamp:p.cutoff,lastSystemMessageTimestamp:p.cutoff}},jid);
      last.acceptedGroups++;last.unattemptedGroups--;
     }catch{last.failedGroups++;last.unattemptedGroups--;last.error='CLEAR_FAILED';break;}
    }
    return {...last,running:false};
   }catch(error){last.error=['CONNECTION_CHANGED','STATE_REFRESH_FAILED'].includes(error?.code)?error.code:'OPERATION_FAILED';throw failure(last.error);}
   finally{busy=false;last.running=false;last.finishedAt=new Date(clock()).toISOString();}
  })();
  // HTTP callers may disconnect; the operation is not retried or cancelled by that.
  active.catch(()=>{});
  return {accepted:true,...last};
 }
 async function execute(body){start(body);return await active;}
 return {preview,start,execute,status:()=>({...last})};
}

export function mountArchivedGroupCleanup(app,secure,cleanup){
 const error=(res,e)=>res.status(e?.code==='INVALID_REQUEST'?400:e?.code==='OPERATION_BUSY'?409:412).json({error:e?.code||'CLEANUP_UNAVAILABLE'});
 app.post('/crm/archived-groups/clear/preview',secure,async(req,res)=>{
  try{res.json({ok:true,...await cleanup.preview(req.body??{})});}catch(e){error(res,e);}
 });
 app.post('/crm/archived-groups/clear/execute',secure,(req,res)=>{
  try{res.status(202).json({ok:true,...cleanup.start(req.body)});}catch(e){error(res,e);}
 });
 app.get('/crm/archived-groups/clear/status',secure,(_req,res)=>res.json({ok:true,...cleanup.status()}));
}
