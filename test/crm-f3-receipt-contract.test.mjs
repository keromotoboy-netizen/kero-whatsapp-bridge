import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {Script,createContext} from 'node:vm';
// Real F2 candidate source, but every socket, disk write and route is in-memory.
const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const sendStart=source.indexOf('async function sendCrmText(jid, text, dispatchKey = null) {');
const sendEnd=source.indexOf('\nconst AI = createAiEngine(',sendStart);
const routeStart=source.indexOf("app.post('/crm/send', secure,");
const routeEnd=source.indexOf('\n// Manual favorites:',routeStart);
assert.ok(sendStart>=0&&sendEnd>sendStart&&routeStart>=0&&routeEnd>routeStart,'PR30 send helper/route found');
const A='1234567890-123456789@g.us',B='1234567890-123456790@g.us';
function fixture({savedState=null,failSaveNumber=0,sendError=false,wrongGroup=false}={}){
 const state=savedState?structuredClone(savedState):{messages:{}};
 const paths=new Map(),events=[];let calls=0,saves=0;
 let disk=structuredClone(state);
 const CRM={state,
  upsertMessage(m){
   const jid=m.key.remoteJid;
   (state.messages[jid]??=[]).push({id:m.key.id,jid,fromMe:m.key.fromMe===true});
  },
  saveNow(strict){
   events.push('diskSave:'+strict);saves++;
   if(saves===failSaveNumber)throw Error('QA_SYNTHETIC_DISK_FAILURE');
   disk=structuredClone(state);
  }
 };
 const sock={sendMessage:async(jid,payload)=>{
  calls++;events.push('socket');
  if(sendError)throw Error('QA_LOST_ACK');
  return {key:{remoteJid:wrongGroup?B:jid,fromMe:true,id:jid===A?'3EB0F3CONTRACTA123':'3EB0F3CONTRACTB123'},messageTimestamp:10,message:{conversation:payload.text}};
 }};
 const sandbox={sock,status:'open',CRM,createHash,resolveOutboundJid:async x=>x,marcarOrigem:()=>{}};
 createContext(sandbox);
 new Script(source.slice(sendStart,sendEnd)+'\nthis.send=sendCrmText;').runInContext(sandbox);
 const app={post:(url,secure,fn)=>paths.set(url,fn)};
 const routeScope={app,secure:()=>{},sendCrmText:sandbox.send,console};
 createContext(routeScope);
 new Script(source.slice(routeStart,routeEnd)).runInContext(routeScope);
 const invoke=async(body)=>{
  let code=200,value;
  const res={status(n){code=n;return this},json(v){value=v;return this}};
  await paths.get('/crm/send')({body},res);
  return {code,value};
 };
 return {invoke,state,events,get calls(){return calls},get saves(){return saves},get disk(){return disk}};
}
const body=(jid=A,key='cmd:approved-command-0001')=>({jid,text:'QA synthetics no real WhatsApp',dispatchKey:key});
test('F2/F3: dispatchKey is forwarded and reservation is saved before ANY external effect',async()=>{
 const f=fixture();
 const r=await f.invoke(body());
 assert.equal(r.code,200);
 assert.equal(r.value.ok,true);
 assert.equal(r.value.receiptPersisted,true);
 assert.equal(r.value.deliveryConfirmed,undefined);
 assert.equal(r.value.messageId,f.disk.messages[A][0].id);
 assert.deepEqual(f.events,['diskSave:true','socket','diskSave:true']);
 const hash=createHash('sha256').update(JSON.stringify([A,body().dispatchKey])).digest('hex');
 assert.equal(f.disk.groupSendReservations[hash].phase,'PERSISTED');
});
test('F2/F3: timeout after possible socket effect returns UNKNOWN and same key never re-sends',async()=>{
 const f=fixture({sendError:true});
 const first=await f.invoke(body());
 const again=await f.invoke(body());
 assert.equal(first.code,202);assert.equal(first.value.outcome,'UNKNOWN');assert.equal(first.value.retry,false);
 assert.equal(again.value.duplicateSuppressed,true);assert.equal(again.value.retry,false);
 assert.equal(f.calls,1);
});
test('F2/F3: UNKNOWN pre-send reservation survives process restart and blocks effect',async()=>{
 const f=fixture({sendError:true});
 await f.invoke(body());
 const next=fixture({savedState:f.disk});
 const r=await next.invoke(body());
 assert.equal(r.code,202);assert.equal(r.value.outcome,'UNKNOWN');
 assert.equal(r.value.duplicateSuppressed,true);assert.equal(next.calls,0);
});
test('F2/F3: persisted receipt survives restart and remains the SAME per-group id',async()=>{
 const f=fixture();const original=await f.invoke(body());
 const next=fixture({savedState:f.disk});
 const reread=await next.invoke(body());
 assert.equal(reread.code,200);assert.equal(reread.value.messageId,original.value.messageId);
 assert.equal(reread.value.receiptPersisted,true);assert.equal(reread.value.duplicateSuppressed,true);
 assert.equal(next.calls,0);
 const other=await next.invoke(body(B));
 assert.equal(other.code,200);assert.notEqual(other.value.messageId,original.value.messageId);
 assert.equal(next.calls,1);
});
test('F2/F3: disk failure after ACK returns 202 UNKNOWN; cannot claim CONFIRMED',async()=>{
 const f=fixture({failSaveNumber:2});
 const first=await f.invoke(body());
 const again=await f.invoke(body());
 assert.equal(first.code,202);assert.equal(first.value.ok,false);
 assert.equal(first.value.receiptPersisted,undefined);assert.equal(first.value.retry,false);
 assert.equal(again.value.duplicateSuppressed,true);
 assert.equal(f.calls,1);
});
test('F2/F3: pre-send disk failure has zero socket calls',async()=>{
 const f=fixture({failSaveNumber:1});
 const r=await f.invoke(body());
 assert.equal(r.code,202);assert.equal(r.value.ok,false);assert.equal(r.value.retry,false);
 assert.equal(f.calls,0);
});
test('F2/F3: group mismatch never yields confirmed receipt',async()=>{
 const f=fixture({wrongGroup:true});
 const r=await f.invoke(body());
 assert.equal(r.code,202);assert.equal(r.value.outcome,'UNKNOWN');
 assert.equal(r.value.receiptPersisted,undefined);assert.equal(f.calls,1);
});
test('F2/F3: invalid dispatchKey is rejected WITHOUT effect, currently HTTP202 contract gap',async()=>{
 const f=fixture();
 const r=await f.invoke(body(A,'bad'));
 assert.equal(r.code,202);assert.equal(r.value.ok,false);
 assert.equal(r.value.error,'invalid_group_dispatch_key');
 assert.equal(r.value.retry,false);assert.equal(f.calls,0);
});
