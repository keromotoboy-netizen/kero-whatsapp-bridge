import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCrmGroupDelete } from '../crm-group-delete.mjs';
const jid1='1234567890-123456789@g.us',jid2='1234567890-123456790@g.us';
const id1='3EB0AAA123456789',id2='3EB0BBB987654321';
function fixture({own=true,connected=true,storageFails=false,socketFails=false,persistedMessages=null}={}) {
 const callbacks=new Map(),calls=[],messages={
  [jid1]:[{id:id1,fromMe:own,deleted:false}],
  [jid2]:[{id:id2,fromMe:true,deleted:false}]
 };
 const crm={state:{messages:persistedMessages || messages},saveNow:async()=>{if(storageFails)throw Error('disk inaccessible')}};
 const socket={sendMessage:async(jid,content)=>{calls.push([jid,content]);if(socketFails)throw Error('timeout');return {key:{id:'REVOKEACK00000001'}}}};
 const app={post:(path,_auth,fn)=>callbacks.set(path,fn)};
 mountCrmGroupDelete(app,()=>{}, {getSocket:()=>socket,isConnected:()=>connected,crm});
 async function invoke(path,body){let code=200,bodyOut;const res={status(n){code=n;return this},json(x){bodyOut=x;return this}};await callbacks.get(path)({body},res);return {code,data:bodyOut};}
 return {invoke,calls,messages:crm.state.messages};
}
test('delete each own group message with correct Baileys revoke key',async()=>{
 const f=fixture();
 const a=await f.invoke('/crm/delete',{jid:jid1,id:id1}),b=await f.invoke('/crm/delete',{jid:jid2,id:id2});
 assert.equal(a.code,202);assert.equal(b.code,202);
 assert.equal(a.data.requested,true);assert.equal(a.data.deleted,false);
 assert.equal(f.calls.length,2);
 assert.deepEqual(f.calls[0],[jid1,{delete:{remoteJid:jid1,id:id1,fromMe:true}}]);
 assert.deepEqual(f.calls[1],[jid2,{delete:{remoteJid:jid2,id:id2,fromMe:true}}]);
});
test('outgoing revoke is not confirmation of delete for everyone',async()=>{
 const f=fixture();
 await f.invoke('/crm/delete',{jid:jid1,id:id1});
 assert.equal((await f.invoke('/crm/delete-status',{jid:jid1,id:id1})).data.deleted,false);
 f.messages[jid1][0].deletedForEveryone=true;f.messages[jid1][0].deleted=true;
 f.messages[jid1][0].deleteConfirmedAt=Date.now();f.messages[jid1][0].deleteReceiptDurable=true;
 const status=await f.invoke('/crm/delete-status',{jid:jid1,id:id1});
 assert.equal(status.data.confirmed,true);assert.equal(status.data.deleted,true);
 assert.equal((await f.invoke('/crm/delete',{jid:jid1,id:id1})).code,200);
 assert.equal(f.calls.length,1);
});
test('pending/uncertain response never generates second deletion',async()=>{
 const f=fixture({socketFails:true});
 assert.equal((await f.invoke('/crm/delete',{jid:jid1,id:id1})).code,502);
 assert.equal((await f.invoke('/crm/delete',{jid:jid1,id:id1})).code,202);
 assert.equal(f.calls.length,1);
});
test('strict persistent reservation error blocks external action',async()=>{
 const f=fixture({storageFails:true});
 assert.equal((await f.invoke('/crm/delete',{jid:jid1,id:id1})).code,503);
 assert.equal(f.calls.length,0);
 assert.equal(f.messages[jid1][0].deleteRequestedAt,undefined);
});
test('offline socket cannot delete and cannot reserve',async()=>{
 const f=fixture({connected:false});
 assert.equal((await f.invoke('/crm/delete',{jid:jid1,id:id1})).code,409);
 assert.equal(f.calls.length,0);
 assert.equal(f.messages[jid1][0].deleteRequestedAt,undefined);
});
test('incoming, private, malformed and wrong-group messages denied',async()=>{
 const f=fixture({own:false});
 assert.equal((await f.invoke('/crm/delete',{jid:jid1,id:id1})).code,404);
 assert.equal((await f.invoke('/crm/delete',{jid:jid2,id:id1})).code,404);
 assert.equal((await f.invoke('/crm/delete',{jid:'551199999999@s.whatsapp.net',id:id2})).code,400);
 assert.equal((await f.invoke('/crm/delete',{jid:jid2,id:'short'})).code,400);
 assert.equal(f.calls.length,0);
});
test('deleted locally but not for everyone is a fail-closed state',async()=>{
 const f=fixture();f.messages[jid1][0].deleted=true;
 assert.equal((await f.invoke('/crm/delete',{jid:jid1,id:id1})).code,409);
 assert.equal(f.calls.length,0);
});
test('status queries have zero external effects',async()=>{
 const f=fixture();
 assert.equal((await f.invoke('/crm/delete-status',{jid:jid1,id:id1})).data.requested,false);
 assert.equal(f.calls.length,0);
});

test('delete ACK is pending, not a successful revoke',async()=>{
 const f=fixture();const r=await f.invoke('/crm/delete',{jid:jid1,id:id1});
 assert.equal(r.code,202);assert.equal(r.data.accepted,true);
 assert.equal(r.data.deleted,false);assert.equal(r.data.outcome,'PENDING');
 assert.equal((await f.invoke('/crm/delete-status',{jid:jid1,id:id1})).data.confirmed,false);
});
test('delete recovery suppresses second effect after restart',async()=>{
 const f=fixture();await f.invoke('/crm/delete',{jid:jid1,id:id1});
 const resumed=fixture({persistedMessages:f.messages});
 const r=await resumed.invoke('/crm/delete',{jid:jid1,id:id1});
 assert.equal(r.code,202);assert.equal(r.data.deleted,false);assert.equal(resumed.calls.length,0);
});
test('revoke observed but not durably written cannot be reported confirmed',async()=>{
 const f=fixture();await f.invoke('/crm/delete',{jid:jid1,id:id1});
 f.messages[jid1][0].deletedForEveryone=true;f.messages[jid1][0].deleteConfirmedAt=Date.now();
 const r=await f.invoke('/crm/delete-status',{jid:jid1,id:id1});
 assert.equal(r.data.confirmed,false);assert.equal(r.data.deleted,false);
});
test('concurrent identical deletions dispatch only once',async()=>{
 const f=fixture();
 const [a,b]=await Promise.all([f.invoke('/crm/delete',{jid:jid1,id:id1}),f.invoke('/crm/delete',{jid:jid1,id:id1})]);
 assert.equal(f.calls.length,1);
 assert.equal([a.code,b.code].every(c=>c===202),true);
});
