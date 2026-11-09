import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { Script, createContext } from 'node:vm';

// Extract the actual Bridge send function and run it with an offline transport.
// No server boot, Railway, WhatsApp connection, or real message send.
const server = fs.readFileSync(new URL('../server.mjs', import.meta.url),'utf8');
const start = server.indexOf('async function sendCrmText(jid, text, dispatchKey = null) {');
const end = server.indexOf('\nconst AI = createAiEngine(', start);
assert.ok(start >= 0 && end > start, 'existing sendCrmText must be found');
const fn = server.slice(start, end) + '\nthis.sendCrmText = sendCrmText;';
const a = '1234567890-123456789@g.us', b='1234567890-123456790@g.us';
function fixture(responseFor = jid => ({key:{id:jid===a?'3EB0AAAA12345678':'3EB0BBBB12345678',remoteJid:jid,fromMe:true},messageTimestamp:10,message:{conversation:'synthetic'}}),opts={}){
 const calls = [], saves = [];
 const state = opts.preloadedState || { messages:{} };
 const messages = state.messages;
 let persisted = {};
 const sock = {sendMessage:async (jid,payload) => {calls.push({jid,payload});return responseFor(jid)}};
 const CRM = {
   state,
   upsertMessage: sent => {
     if (opts.skipStore) return;
     if (sent?.key?.id) {
       const jid=sent.key.remoteJid;
       (messages[jid] ||= []).push({id:sent.key.id,jid,fromMe:sent.key.fromMe === true});
     }
   },
   saveNow: strict => {
     saves.push(strict);
     if (opts.failSave) throw Error('synthetic disk failed');
     persisted = JSON.parse(JSON.stringify(state));
   }
 };
 const sandbox = {sock,status:'open',CRM,createHash,resolveOutboundJid:async x=>x,marcarOrigem:()=>{}};
 createContext(sandbox);
 new Script(fn).runInContext(sandbox);
 return {send:sandbox.sendCrmText,calls,messages,saves,state,get persisted(){return persisted}};
}
test('one outgoing send yields one group-specific ID, not a global shared receipt', async()=>{
 const f=fixture();
 const r1=await f.send(a,'synthetic text'),r2=await f.send(b,'synthetic text');
 assert.equal(r1.messageId,'3EB0AAAA12345678');
 assert.equal(r2.messageId,'3EB0BBBB12345678');
 assert.equal(r1.ok,true); assert.equal(r2.ok,true);
 assert.deepEqual(f.calls.map(x=>x.jid),[a,b]);
 assert.deepEqual(Object.keys(f.messages).sort(),[a,b].sort());
 assert.equal(f.messages[a][0].jid,a);
 assert.equal(f.messages[b][0].jid,b);
 assert.deepEqual(f.saves,[true,true]);
 assert.equal(f.persisted.messages[a][0].id,r1.messageId);
 assert.equal(f.persisted.messages[b][0].id,r2.messageId);
});
test('missing Baileys message ID is nullable, never a delivery or revoke receipt',async()=>{
 const f=fixture(jid=>({key:{remoteJid:jid,fromMe:true}}));
 const r=await f.send(a,'synthetic');
 assert.equal(r.messageId,null);
 assert.equal(r.ok,false);assert.equal(r.outcome,'UNKNOWN');assert.equal(r.retry,false);
 assert.equal(f.calls.length,1);
 assert.equal(Object.keys(f.messages).length,0);
});
test('transport timeout is not reattempted by the Bridge send helper',async()=>{
 const f=fixture(()=>{throw Error('synthetic timeout')});
 const r=await f.send(a,'synthetic');
 assert.equal(r.ok,false);assert.equal(r.outcome,'UNKNOWN');assert.equal(r.retry,false);
 assert.equal(f.calls.length,1);
});
test('different groups with identical returned message ID still retain per-group keys',async()=>{
 const f=fixture(jid=>({key:{remoteJid:jid,id:'3EB0SAME12345678',fromMe:true},messageTimestamp:10}));
 await f.send(a,'synthetic');await f.send(b,'synthetic');
 assert.equal(f.messages[a][0].jid,a);
 assert.equal(f.messages[b][0].jid,b);
 assert.equal(f.persisted.messages[a][0].id,f.persisted.messages[b][0].id);
 assert.equal(f.calls.length,2);
});

test('group ACK is not success when synchronous save fails after send',async()=>{
 const f=fixture(undefined,{failSave:true});
 const r=await f.send(a,'synthetic');
 assert.equal(f.calls.length,1);
 assert.equal(r.ok,false);assert.equal(r.outcome,'UNKNOWN');assert.equal(r.retry,false);
 assert.equal(r.error,'group_send_receipt_not_persisted');
 assert.equal(r.messageId,'3EB0AAAA12345678');
 assert.deepEqual(f.saves,[true]);
});
test('group ACK is UNKNOWN if upsert did not record the exact message',async()=>{
 const f=fixture(undefined,{skipStore:true});
 const r=await f.send(a,'synthetic');
 assert.equal(r.ok,false);assert.equal(r.outcome,'UNKNOWN');assert.equal(r.retry,false);
 assert.equal(r.error,'group_send_receipt_not_persisted');
 assert.equal(f.saves.length,0);
});
test('cross-group Baileys key is rejected even with a plausible messageId',async()=>{
 const f=fixture(jid=>({key:{id:'3EB0OTHER12345678',remoteJid:b,fromMe:true},messageTimestamp:10}));
 const r=await f.send(a,'synthetic');
 assert.equal(r.ok,false);assert.equal(r.outcome,'UNKNOWN');assert.equal(r.error,'group_send_reference_unknown');
 assert.equal(f.calls.length,1);assert.equal(f.saves.length,0);
});
test('incoming message response cannot become an outgoing group receipt',async()=>{
 const f=fixture(jid=>({key:{id:'3EB0INCOMING123456',remoteJid:jid,fromMe:false}}));
 const r=await f.send(a,'synthetic');
 assert.equal(r.ok,false);assert.equal(r.retry,false);assert.equal(f.saves.length,0);
});
test('private messages retain legacy behavior, without strict group persistence',async()=>{
 const personal='5511999999999@s.whatsapp.net';
 const f=fixture(jid=>({key:{id:'3EB0PRIVATE1234567',remoteJid:jid,fromMe:true},messageTimestamp:10,message:{conversation:'safe'}}),{failSave:true});
 const r=await f.send(personal,'synthetic');
 assert.equal(r.ok,true);assert.equal(r.messageId,'3EB0PRIVATE1234567');
 assert.equal(f.calls.length,1);assert.deepEqual(f.saves,[]);
});
test('group receipt is marked persisted only after strict save',async()=>{
 const f=fixture();
 const r=await f.send(a,'synthetic');
 assert.equal(r.ok,true);assert.equal(r.receiptPersisted,true);
 assert.deepEqual(f.saves,[true]);assert.equal(f.persisted.messages[a][0].id,r.messageId);
});

const routeStart=server.indexOf("app.post('/crm/send', secure,");
const routeEnd=server.indexOf('\n// Manual favorites:',routeStart);
assert.ok(routeStart>=0 && routeEnd>routeStart,'Bridge /crm/send handler must be found');
function routeFixture(response){
 const handlers=new Map(), calls=[];
 const app={post:(name,secure,fn)=>handlers.set(name,fn)};
 const sandbox={app,secure:()=>{},sendCrmText:async (...args)=>{calls.push(args);return response},console};
 createContext(sandbox);
 new Script(server.slice(routeStart,routeEnd)).runInContext(sandbox);
 const invoke=async body=>{
  let code=200,data;const res={status(n){code=n;return this},json(x){data=x;return this}};
  await handlers.get('/crm/send')({body},res);
  return {code,data};
 };
 return {invoke,calls};
}
test('HTTP 202 on UNKNOWN group receipt; no implied delivery or retry',async()=>{
 const f=routeFixture({ok:false,outcome:'UNKNOWN',retry:false,messageId:'3EB0UNSAVED123456',error:'group_send_receipt_not_persisted'});
 const r=await f.invoke({jid:a,text:'synthetic'});
 assert.equal(r.code,202);assert.equal(r.data.ok,false);assert.equal(r.data.outcome,'UNKNOWN');
 assert.equal(r.data.retry,false);assert.equal(f.calls.length,1);
});
test('HTTP 200 only for successful helper return, never adds delivery confirmation',async()=>{
 const f=routeFixture({ok:true,messageId:'3EB0SAVED1234567',receiptPersisted:true,resolved:false});
 const r=await f.invoke({jid:a,text:'synthetic'});
 assert.equal(r.code,200);assert.equal(r.data.messageId,'3EB0SAVED1234567');
 assert.equal(r.data.deliveryConfirmed,undefined);assert.equal(f.calls.length,1);
});
test('invalid group send body remains 400 and has no external effect',async()=>{
 const f=routeFixture({ok:true,messageId:'3EB0SAVED1234567'});
 const r=await f.invoke({jid:a,text:'   '});
 assert.equal(r.code,400);assert.equal(f.calls.length,0);
});

test('dispatchKey is reserved durably before an uncertain group send',async()=>{
 const key='cmd:job-pre-send-001';
 const f=fixture(()=>{throw Error('synthetic broken socket')});
 const r=await f.send(a,'synthetic',key);
 const hash=createHash('sha256').update(JSON.stringify([a,key])).digest('hex');
 assert.equal(f.persisted.groupSendReservations[hash].phase,'RESERVED');
 assert.equal(r.outcome,'UNKNOWN');assert.equal(r.retry,false);
 assert.equal(f.calls.length,1);
 const repeat=await f.send(a,'synthetic',key);
 assert.equal(repeat.duplicateSuppressed,true);
 assert.equal(repeat.outcome,'UNKNOWN');
 assert.equal(f.calls.length,1);
});
test('a previous reservation after process restart blocks blind resend',async()=>{
 const key='cmd:job-after-crash-001';
 const first=fixture(()=>{throw Error('lost ack')});
 await first.send(a,'synthetic',key);
 const restarted=fixture(undefined,{preloadedState:first.persisted});
 const answer=await restarted.send(a,'synthetic',key);
 assert.equal(answer.ok,false);assert.equal(answer.retry,false);
 assert.equal(answer.duplicateSuppressed,true);assert.equal(restarted.calls.length,0);
});
test('persisted receipt can be fetched with same dispatchKey without resending',async()=>{
 const key='cmd:job-success-001';
 const first=fixture();
 const original=await first.send(a,'synthetic',key);
 assert.equal(original.ok,true);assert.equal(original.receiptPersisted,true);
 assert.equal(first.calls.length,1);
 const restarted=fixture(undefined,{preloadedState:first.persisted});
 const again=await restarted.send(a,'synthetic',key);
 assert.equal(again.messageId,original.messageId);
 assert.equal(again.duplicateSuppressed,true);
 assert.equal(again.receiptPersisted,true);
 assert.equal(restarted.calls.length,0);
});
test('same dispatchKey in different groups creates independent reservations',async()=>{
 const f=fixture();
 const key='cmd:job-independent-001';
 const x=await f.send(a,'synthetic',key);
 const y=await f.send(b,'synthetic',key);
 assert.equal(x.ok,true);assert.equal(y.ok,true);
 assert.equal(f.calls.length,2);
 assert.equal(Object.keys(f.persisted.groupSendReservations).length,2);
});
test('same dispatchKey with different text fails closed and never sends again',async()=>{
 const f=fixture(),key='cmd:job-conflict-001';
 await f.send(a,'synthetic one',key);
 const second=await f.send(a,'synthetic changed',key);
 assert.equal(second.ok,false);assert.equal(second.retry,false);
 assert.equal(second.error,'group_dispatch_key_conflict');
 assert.equal(f.calls.length,1);
});
test('invalid dispatchKey cannot trigger group sends',async()=>{
 const f=fixture();
 const r=await f.send(a,'synthetic','bad');
 assert.equal(r.ok,false);assert.equal(r.error,'invalid_group_dispatch_key');
 assert.equal(f.calls.length,0);
});
test('preflight reservation save failure performs zero WhatsApp effects',async()=>{
 const f=fixture(undefined,{failSave:true});
 const r=await f.send(a,'synthetic','cmd:job-reservation-fail');
 assert.equal(r.ok,false);assert.equal(r.retry,false);
 assert.equal(r.error,'group_dispatch_reservation_not_durable');
 assert.equal(f.calls.length,0);
});
test('duplicate while first operation is in flight never invokes socket twice',async()=>{
 let release;
 const f=fixture(()=>new Promise(resolve=>{release=resolve}));
 const key='cmd:job-concurrent-001';
 const first=f.send(a,'synthetic',key);
 for(let i=0;i<4;i++)await Promise.resolve();
 const dup=await f.send(a,'synthetic',key);
 assert.equal(dup.ok,false);assert.equal(dup.outcome,'UNKNOWN');assert.equal(dup.retry,false);
 assert.equal(dup.duplicateSuppressed,true);assert.equal(f.calls.length,1);
 release({key:{id:'3EB0AAAA12345678',remoteJid:a,fromMe:true}});
 assert.equal((await first).ok,true);
});
