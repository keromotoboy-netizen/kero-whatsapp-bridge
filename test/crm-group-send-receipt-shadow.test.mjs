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
function fixture(responseFor = jid => ({key:{id:jid===a?'3EB0AAAA12345678':'3EB0BBBB12345678',remoteJid:jid,fromMe:true},messageTimestamp:10,message:{conversation:'synthetic'}})){
 const calls = [], messages = {};
 const sock = {sendMessage:async (jid,payload) => {calls.push({jid,payload});return responseFor(jid)}};
 const CRM = {upsertMessage: sent => { if(sent?.key?.id){const jid=sent.key.remoteJid; (messages[jid] ||= []).push(sent);}}};
 const sandbox = {sock,status:'open',CRM,resolveOutboundJid:async x=>x};
 createContext(sandbox);
 new Script(fn).runInContext(sandbox);
 return {send:sandbox.sendCrmText,calls,messages};
}
test('one outgoing send yields one group-specific ID, not a global shared receipt', async()=>{
 const f=fixture();
 const r1=await f.send(a,'synthetic text'),r2=await f.send(b,'synthetic text');
 assert.equal(r1.messageId,'3EB0AAAA12345678');
 assert.equal(r2.messageId,'3EB0BBBB12345678');
 assert.equal(r1.ok,true); assert.equal(r2.ok,true);
 assert.deepEqual(f.calls.map(x=>x.jid),[a,b]);
 assert.deepEqual(Object.keys(f.messages).sort(),[a,b].sort());
 assert.equal(f.messages[a][0].key.remoteJid,a);
 assert.equal(f.messages[b][0].key.remoteJid,b);
});
test('missing Baileys message ID is nullable, never a delivery or revoke receipt',async()=>{
 const f=fixture(jid=>({key:{remoteJid:jid,fromMe:true}}));
 const r=await f.send(a,'synthetic');
 assert.equal(r.messageId,null);
 assert.equal(f.calls.length,1);
 assert.equal(Object.keys(f.messages).length,0);
});
test('transport timeout is not reattempted by the Bridge send helper',async()=>{
 const f=fixture(()=>{throw Error('synthetic timeout')});
 await assert.rejects(f.send(a,'synthetic'),/synthetic timeout/);
 assert.equal(f.calls.length,1);
});
test('different groups with identical returned message ID still retain per-group keys',async()=>{
 const f=fixture(jid=>({key:{remoteJid:jid,id:'3EB0SAME12345678',fromMe:true},messageTimestamp:10}));
 await f.send(a,'synthetic');await f.send(b,'synthetic');
 assert.equal(f.messages[a][0].key.remoteJid,a);
 assert.equal(f.messages[b][0].key.remoteJid,b);
 assert.equal(f.calls.length,2);
});
