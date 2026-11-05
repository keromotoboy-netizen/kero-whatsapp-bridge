import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Script, createContext } from 'node:vm';

// Actual CRM file-store, mocked offline WhatsApp socket. No network or message send.
const storeSource=fs.readFileSync(new URL('../crm-store.mjs',import.meta.url),'utf8')
  .replace("import { WAMessageStubType } from 'baileys';","const WAMessageStubType = { REVOKE: 68 };");
const {createCrmStore}=await import('data:text/javascript;base64,'+Buffer.from(storeSource).toString('base64'));
const source=fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function sendCrmText(jid, text) {');
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
 const sandbox={sock,status:'open',CRM:crm,resolveOutboundJid:async x=>x};
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
