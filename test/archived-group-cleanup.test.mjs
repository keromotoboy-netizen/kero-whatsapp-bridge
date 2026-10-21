import test from 'node:test';
import assert from 'node:assert/strict';
import {createArchivedGroupCleanup} from '../archived-group-cleanup.mjs';

// These tests catch widening the destructive scope, replay and stale-state races.
function fixture(){
 const state={chats:{'100-1@g.us':{id:'100-1@g.us',archived:true},'100-2@g.us':{id:'100-2@g.us',archived:false},'100-3@g.us':{id:'100-3@g.us',archived:'true'},'100-4@g.us':{id:'100-4@g.us'},'100@s.whatsapp.net':{id:'100@s.whatsapp.net',archived:true}},labels:{keep:true}};
 const calls=[];let time=2000000000000;
 const socket={chatModify:async(mod,jid)=>calls.push({mod,jid}),sendMessage:()=>{throw Error('Forbidden send');},groupLeave:()=>{throw Error('Forbidden leave');}};
 let current=socket,refreshCount=0;
 const members=new Set(['100-1@g.us','100-2@g.us','100-3@g.us','100-4@g.us']);
 const archived=new Set(members);
 const f={state,calls,socket,members,archived,get refreshCount(){return refreshCount;},setSocket:x=>current=x,advance:n=>time+=n};
 f.api=createArchivedGroupCleanup({getConnection:()=>current,readState:()=>state,refresh:async()=>{refreshCount++;return {members,archived};},clock:()=>time,wait:async()=>{}});return f;
}
const confirm='CLEAR_ARCHIVED_GROUP_MESSAGES_ONLY';
test('a stale CRM archived true cannot authorize clearing an unarchived server chat',async()=>{
 const f=fixture();f.archived.clear();const p=await f.api.preview({});assert.equal(p.eligibleGroups,0);
 await f.api.execute({planId:p.planId,confirm});assert.equal(f.calls.length,0);
});
test('server archive changing after preview excludes the group even if CRM stays true',async()=>{
 const f=fixture(),p=await f.api.preview({});f.archived.clear();
 const r=await f.api.execute({planId:p.planId,confirm});assert.equal(r.skippedGroups,1);assert.equal(f.calls.length,0);
});
test('preview excludes private, active and unknown archive states and is nonmutating',async()=>{
 const f=fixture(),before=JSON.stringify(f.state),p=await f.api.preview({});
 assert.equal(p.eligibleGroups,1);assert.equal(f.calls.length,0);assert.equal(JSON.stringify(f.state),before);
 assert.equal(/100-|whatsapp|keep/.test(JSON.stringify(p)),false);
});
test('clear works with an empty CRM cache and emits only clear with a bounded timestamp',async()=>{
 const f=fixture(),before=JSON.stringify(f.state),p=await f.api.preview({});
 const r=await f.api.execute({planId:p.planId,confirm});
 assert.equal(r.acceptedGroups,1);assert.equal(r.failedGroups,0);
 assert.deepEqual(f.calls,[{jid:'100-1@g.us',mod:{clear:true,lastMessages:{lastMessageTimestamp:1999999999,lastSystemMessageTimestamp:1999999999}}}]);
 assert.equal(JSON.stringify(f.state),before);assert.equal(f.refreshCount,2);
});
test('unarchived after preview is skipped without clear',async()=>{
 const f=fixture(),p=await f.api.preview({});f.state.chats['100-1@g.us'].archived=false;
 const r=await f.api.execute({planId:p.planId,confirm});assert.equal(r.skippedGroups,1);assert.equal(f.calls.length,0);
});
test('groups newly archived after preview are never added to the operation',async()=>{
 const f=fixture(),p=await f.api.preview({});f.state.chats['100-2@g.us'].archived=true;
 await f.api.execute({planId:p.planId,confirm});assert.deepEqual(f.calls.map(x=>x.jid),['100-1@g.us']);
});
test('groups no longer participating are skipped',async()=>{
 const f=fixture(),p=await f.api.preview({});f.members.delete('100-1@g.us');
 const r=await f.api.execute({planId:p.planId,confirm});assert.equal(r.skippedGroups,1);assert.equal(f.calls.length,0);
});
test('each group requires its own fresh remote archive read',async()=>{
 const f=fixture();f.state.chats['100-2@g.us'].archived=true;
 const p=await f.api.preview({});await f.api.execute({planId:p.planId,confirm});
 assert.equal(f.refreshCount,3);assert.equal(f.calls.length,2);
});
test('expired plans cannot delete',async()=>{
 const f=fixture(),p=await f.api.preview({});f.advance(300001);
 await assert.rejects(f.api.execute({planId:p.planId,confirm}),/PLAN_EXPIRED/);assert.equal(f.calls.length,0);
});
test('consumed plans cannot be replayed',async()=>{
 const f=fixture(),p=await f.api.preview({});await f.api.execute({planId:p.planId,confirm});
 await assert.rejects(f.api.execute({planId:p.planId,confirm}),/PLAN_UNAVAILABLE/);assert.equal(f.calls.length,1);
});
test('caller-supplied chat selection and extra fields are rejected',async()=>{
 const f=fixture();await assert.rejects(f.api.preview({jid:'100-2@g.us'}),/INVALID_REQUEST/);
 const p=await f.api.preview({});await assert.rejects(f.api.execute({planId:p.planId,confirm,jid:'100-2@g.us'}),/INVALID_REQUEST/);
 assert.equal(f.calls.length,0);
});
test('missing exact confirmation is rejected',async()=>{
 const f=fixture(),p=await f.api.preview({});await assert.rejects(f.api.execute({planId:p.planId,confirm:true}),/INVALID_REQUEST/);assert.equal(f.calls.length,0);
});
test('connection changes invalidate plans',async()=>{
 const f=fixture(),p=await f.api.preview({});f.setSocket({...f.socket});
 await assert.rejects(f.api.execute({planId:p.planId,confirm}),/CONNECTION_CHANGED/);assert.equal(f.calls.length,0);
});
test('partial failures stop before the next group and leak no raw errors',async()=>{
 const f=fixture();f.state.chats['100-2@g.us'].archived=true;
 f.socket.chatModify=async()=>{throw Error('secret identifier 100-1@g.us');};
 const p=await f.api.preview({}),r=await f.api.execute({planId:p.planId,confirm});
 assert.equal(r.failedGroups,1);assert.equal(r.acceptedGroups,0);assert.equal(r.unattemptedGroups,1);
 assert.equal(JSON.stringify(r).includes('100-1'),false);await assert.rejects(f.api.execute({planId:p.planId,confirm}),/PLAN_UNAVAILABLE/);
});
test('socket closed or refresh failure causes zero changes',async()=>{
 const f=fixture();f.setSocket(null);await assert.rejects(f.api.preview({}),/WHATSAPP_NOT_CONNECTED/);
 const api=createArchivedGroupCleanup({getConnection:()=>f.socket,readState:()=>f.state,refresh:async()=>{throw Error('private');}});
 await assert.rejects(api.preview({}),/STATE_REFRESH_FAILED/);assert.equal(f.calls.length,0);
});
test('concurrent execution is rejected and archive is rechecked after inter-group wait',async()=>{
 const f=fixture();f.state.chats['100-2@g.us'].archived=true;
 let release,started;const ready=new Promise(r=>started=r);
 f.socket.chatModify=async(mod,jid)=>{f.calls.push({mod,jid});started();await new Promise(r=>release=r);};
 const p=await f.api.preview({}),run=f.api.execute({planId:p.planId,confirm});await ready;
 await assert.rejects(f.api.execute({planId:p.planId,confirm}),/OPERATION_BUSY/);
 f.state.chats['100-2@g.us'].archived=false;release();const r=await run;assert.equal(r.skippedGroups,1);assert.equal(f.calls.length,1);
});

test('clear uses the last known message key when available',async()=>{
 const state={chats:{'100-1@g.us':{id:'100-1@g.us',archived:true}}},calls=[],members=new Set(['100-1@g.us']);
 const socket={chatModify:async(mod,jid)=>calls.push({mod,jid})};
 const last={key:{id:'ABC',remoteJid:'100-1@g.us',fromMe:false,participant:'5511@s.whatsapp.net'},messageTimestamp:1999999000};
 const api=createArchivedGroupCleanup({getConnection:()=>socket,readState:()=>state,refresh:async()=>({members,archived:members}),lastMessage:j=>j==='100-1@g.us'?last:null,clock:()=>2000000000000,wait:async()=>{}});
 const p=await api.preview({});const r=await api.execute({planId:p.planId,confirm:'CLEAR_ARCHIVED_GROUP_MESSAGES_ONLY'});
 assert.equal(r.acceptedGroups,1);assert.deepEqual(calls,[{jid:'100-1@g.us',mod:{clear:true,lastMessages:[last]}}]);
});
