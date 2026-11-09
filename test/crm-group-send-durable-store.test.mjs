import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Script, createContext } from 'node:vm';

// Actual CRM file-store, mocked offline WhatsApp socket. No network or message send.
const storeSource=fs.readFileSync(new URL('../crm-store.mjs',import.meta.url),'utf8')
  .replace("import { WAMessageStubType } from 'baileys';","const WAMessageStubType = { REVOKE: 68 };");
const {createCrmStore}=await import('data:text/javascript;base64,'+Buffer.from(storeSource).toString('base64'));
const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function sendCrmText(jid, text, dispatchKey = null) {');
const end=source.indexOf('\nconst AI = createAiEngine(',start);
assert.ok(start>=0&&end>start);
const sendSource=source.slice(start,end)+'\nthis.send=sendCrmText;';
const jid='1234567890-123456789@g.us',id='3EB0DURABLE1234567';
test('group message id is on disk before /crm/send helper responds; survives CRM process restart',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kero-bridge-send-persist-'));
 const dataDir=path.join(root,'auth');
 fs.mkdirSync(dataDir);
 const crm=createCrmStore(dataDir);
 const calls=[];
 const sock={sendMessage:async(target,{text})=>{
  calls.push(target);
  return {key:{id,remoteJid:target,fromMe:true},messageTimestamp:Math.floor(Date.now()/1000),message:{conversation:text}};
 }};
 const sandbox={sock,status:'open',CRM:crm,createHash,resolveOutboundJid:async x=>x,marcarOrigem:()=>{}};
 createContext(sandbox);
 new Script(sendSource).runInContext(sandbox);
 try{
  const response=await sandbox.send(jid,'Somente teste local');
  assert.equal(calls.length,1);
  assert.equal(response.ok,true);
  assert.equal(response.messageId,id);
  assert.equal(response.receiptPersisted,true);
  const disk=JSON.parse(fs.readFileSync(path.join(root,'crm-state.json'),'utf8'));
  const saved=disk.messages[jid].find(m=>m.id===id&&m.fromMe===true);
  assert.ok(saved,'group id must be on disk before response');
  const afterRestart=createCrmStore(dataDir);
  assert.ok(afterRestart.state.messages[jid].some(m=>m.id===id&&m.fromMe===true));
 }finally{
  await new Promise(resolve=>setTimeout(resolve,320));
  fs.rmSync(root,{recursive:true,force:true});
 }
});

function launchOfflineSender(crm,sendMessage) {
 const sandbox={sock:{sendMessage},status:'open',CRM:crm,createHash,resolveOutboundJid:async x=>x,marcarOrigem:()=>{}};
 createContext(sandbox);
 new Script(sendSource).runInContext(sandbox);
 return sandbox.send;
}
test('pre-send reservation remains durable after ACK loss and reboot; no second send',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kero-bridge-reservation-'));
 const dataDir=path.join(root,'auth');fs.mkdirSync(dataDir);
 const key='job:bridge-restart-001',calls=[];
 const store=createCrmStore(dataDir);
 const send=launchOfflineSender(store,async(target,payload)=>{
  calls.push({target,payload});throw Error('synthetic ACK lost');
 });
 try{
  const result=await send(jid,'synthetic group message',key);
  assert.equal(result.outcome,'UNKNOWN');
  assert.equal(calls.length,1);
  const hash=createHash('sha256').update(JSON.stringify([jid,key])).digest('hex');
  const saved=JSON.parse(fs.readFileSync(path.join(root,'crm-state.json'),'utf8'));
  assert.equal(saved.groupSendReservations[hash].phase,'RESERVED');
  const restarted=createCrmStore(dataDir);
  let unexpected=0;
  const repeat=launchOfflineSender(restarted,async()=>{unexpected++;throw Error('MUST_NOT_SEND')});
  const second=await repeat(jid,'synthetic group message',key);
  assert.equal(second.outcome,'UNKNOWN');assert.equal(second.retry,false);
  assert.equal(second.duplicateSuppressed,true);
  assert.equal(unexpected,0);
 }finally{await new Promise(r=>setTimeout(r,350));fs.rmSync(root,{recursive:true,force:true})}
});
test('durably persisted group receipt returns from disk on repeated command without send',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kero-bridge-idempotency-'));
 const dataDir=path.join(root,'auth');fs.mkdirSync(dataDir);
 const key='job:bridge-persisted-001';
 const store=createCrmStore(dataDir);
 let calls=0;
 const send=launchOfflineSender(store,async(target,{text})=>{
  calls++;
  return {key:{id,remoteJid:target,fromMe:true},messageTimestamp:Math.floor(Date.now()/1000),message:{conversation:text}};
 });
 try{
  const first=await send(jid,'synthetic group text',key);
  assert.equal(first.ok,true);assert.equal(calls,1);
  const newStore=createCrmStore(dataDir);
  const repeat=launchOfflineSender(newStore,async()=>{calls++;throw Error('MUST_NOT_SEND')});
  const second=await repeat(jid,'synthetic group text',key);
  assert.equal(second.ok,true);
  assert.equal(second.messageId,id);
  assert.equal(second.duplicateSuppressed,true);
  assert.equal(calls,1);
 }finally{await new Promise(r=>setTimeout(r,350));fs.rmSync(root,{recursive:true,force:true})}
});
