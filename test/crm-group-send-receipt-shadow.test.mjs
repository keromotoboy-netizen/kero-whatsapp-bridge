import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Script, createContext } from 'node:vm';

// Extract the actual Bridge send function and run it with an offline transport.
// No server boot, Railway, WhatsApp connection, or real message send.
const server = fs.readFileSync(new URL('../server.mjs', import.meta.url),'utf8');
const start = server.indexOf('async function sendCrmText(jid, text) {');
const end = server.indexOf('\nconst AI = createAiEngine(', start);
assert.ok(start >= 0 && end > start, 'existing sendCrmText must be found');
const fn = server.slice(start, end) + '\nthis.sendCrmText = sendCrmText;';
const a = '1234567890-123456789@g.us', b='1234567890-123456790@g.us';
function fixture(responseFor = jid => ({key:{id:jid===a?'3EB0AAAA12345678':'3EB0BBBB12345678',remoteJid:jid,fromMe:true},messageTimestamp:10,message:{conversation:'synthetic'}}),opts={}){
 const calls = [], messages = {}, saves = [];
 let persisted = {};
 const sock = {sendMessage:async (jid,payload) => {calls.push({jid,payload});return responseFor(jid)}};
 const CRM = {
   state:{messages},
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
     persisted = JSON.parse(JSON.stringify(messages));
   }
 };
 const sandbox = {sock,status:'open',CRM,resolveOutboundJid:async x=>x};
 createContext(sandbox);
 new Script(fn).runInContext(sandbox);
 return {send:sandbox.sendCrmText,calls,messages,saves,get persisted(){return persisted}};
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
 assert.equal(f.persisted[a][0].id,r1.messageId);
 assert.equal(f.persisted[b][0].id,r2.messageId);
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
 assert.equal(f.persisted[a][0].id,f.persisted[b][0].id);
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
 assert.deepEqual(f.saves,[true]);assert.equal(f.persisted[a][0].id,r.messageId);
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
