import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {chatModificationToAppPatch} from 'baileys';
import {createArchivedGroupCleanup,mountArchivedGroupCleanup} from '../archived-group-cleanup.mjs';

test('installed Baileys maps clear to bounded clearChat action, never deleteChat or labels',()=>{
 const patch=chatModificationToAppPatch({clear:true,lastMessages:{lastMessageTimestamp:1999999999,lastSystemMessageTimestamp:1999999999}},'100-1@g.us');
 assert.deepEqual(patch.index,['clearChat','100-1@g.us','1','0']);
 assert.deepEqual(Object.keys(patch.syncAction).filter(k=>k!=='timestamp'),['clearChatAction']);
 assert.deepEqual(patch.syncAction.clearChatAction.messageRange,{lastMessageTimestamp:1999999999,lastSystemMessageTimestamp:1999999999});
});

test('HTTP requires authentication, preview and exact confirmation; status is aggregate only',async()=>{
 const calls=[],state={chats:{'100-1@g.us':{id:'100-1@g.us',archived:true},'100@s.whatsapp.net':{id:'100@s.whatsapp.net',archived:true}}};
 const socket={chatModify:async(mod,jid)=>calls.push({mod,jid})};
 const cleanup=createArchivedGroupCleanup({getConnection:()=>socket,readState:()=>state,refresh:async()=>({members:new Set(['100-1@g.us']),archived:new Set(['100-1@g.us'])}),wait:async()=>{}});
 const app=express();app.use(express.json());
 mountArchivedGroupCleanup(app,(req,res,next)=>req.get('x-fixture-auth')==='allowed'?next():res.sendStatus(401),cleanup);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/crm/archived-groups/clear`;
 const headers={'content-type':'application/json','x-fixture-auth':'allowed'};
 try{
  assert.equal((await fetch(base+'/preview',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  assert.equal(calls.length,0);
  assert.equal((await fetch(base+'/execute',{method:'POST',headers,body:JSON.stringify({planId:'unknown',confirm:'CLEAR_ARCHIVED_GROUP_MESSAGES_ONLY'})})).status,412);
  const p=await fetch(base+'/preview',{method:'POST',headers,body:'{}'}).then(r=>r.json());assert.equal(p.eligibleGroups,1);assert.equal(calls.length,0);
  assert.equal((await fetch(base+'/execute',{method:'POST',headers,body:JSON.stringify({planId:p.planId,confirm:'wrong'})})).status,400);
  const r=await fetch(base+'/execute',{method:'POST',headers,body:JSON.stringify({planId:p.planId,confirm:'CLEAR_ARCHIVED_GROUP_MESSAGES_ONLY'})});assert.equal(r.status,202);
  await new Promise(r=>setImmediate(r));
  const status=await fetch(base+'/status',{headers}).then(r=>r.json());assert.equal(status.acceptedGroups,1);assert.equal(status.running,false);
  assert.equal(JSON.stringify(status).includes('@g.us'),false);assert.equal(calls.length,1);
  assert.equal((await fetch(base+'/execute',{method:'POST',headers,body:JSON.stringify({planId:p.planId,confirm:'CLEAR_ARCHIVED_GROUP_MESSAGES_ONLY'})})).status,412);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
