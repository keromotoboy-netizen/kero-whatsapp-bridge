import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCrmGroupStar } from '../crm-group-star.mjs';
import { mountCrmGroupDelete } from '../crm-group-delete.mjs';

// F4/Xiaomi shadow fixture. Never connects to WhatsApp and never sends a message.
const groupA = '1234567890-111111111@g.us';
const groupB = '1234567890-222222222@g.us';
const id = '3EB0SAMEID123456789';
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function fixture() {
  const routes = new Map();
  const messages = {
    [groupA]: [{ id, fromMe: true, deleted: false }],
    [groupB]: [{ id, fromMe: true, deleted: false }]
  };
  const starCalls = [], deleteCalls = [], waits = [];
  const app = { post: (path, secure, handle) => routes.set(path, handle) };
  const crm = { state: { messages }, saveNow: async () => {} };
  const socket = {
    chatModify: async (payload, jid) => { starCalls.push({ jid, payload }); const d = deferred(); waits.push(d); return d.promise; },
    sendMessage: async (jid, payload) => { deleteCalls.push({ jid, payload }); const d = deferred(); waits.push(d); return d.promise; }
  };
  mountCrmGroupStar(app, () => {}, { getSocket: () => socket, isConnected: () => true, crm });
  mountCrmGroupDelete(app, () => {}, { getSocket: () => socket, isConnected: () => true, crm });
  const req = async (route, body) => {
    let code = 200, data;
    const res = { status: n => { code = n; return res; }, json: x => { data = x; return res; } };
    await routes.get(route)({ body }, res);
    return { code, data };
  };
  return { req, messages, starCalls, deleteCalls, waits };
}
test('same messageId in two distinct groups remains isolated for star and returns individual reference', async () => {
  const f = fixture();
  const a = f.req('/crm/star', { jid: groupA, id });
  const b = f.req('/crm/star', { jid: groupB, id });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.starCalls.length, 2);
  assert.equal(f.starCalls[0].jid, groupA);
  assert.equal(f.starCalls[1].jid, groupB);
  assert.deepEqual((await f.req('/crm/star-status', { jid: groupA, id })).data.messageRef, { jid: groupA, id });
  assert.deepEqual((await f.req('/crm/star-status', { jid: groupB, id })).data.messageRef, { jid: groupB, id });
  assert.equal((await f.req('/crm/star-status', { jid: groupA, id })).data.outcome, 'IN_FLIGHT');
  f.waits.forEach(d => d.resolve());
  const responses = await Promise.all([a,b]);
  assert.deepEqual(responses.map(r => r.data.outcome), ['PENDING','PENDING']);
  assert.deepEqual(responses.map(r => r.data.confirmed), [false,false]);
});
test('same messageId in two distinct groups remains isolated for delete-for-everyone', async () => {
  const f = fixture();
  const a = f.req('/crm/delete', { jid: groupA, id });
  const b = f.req('/crm/delete', { jid: groupB, id });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.deleteCalls.length, 2);
  for (const call of f.deleteCalls) assert.equal(call.payload.delete.remoteJid, call.jid);
  assert.deepEqual((await f.req('/crm/delete-status', { jid: groupB, id })).data.messageRef, {jid: groupB,id});
  assert.equal((await f.req('/crm/delete-status', { jid: groupB, id })).data.outcome, 'IN_FLIGHT');
  f.waits.forEach(d => d.resolve({ key: {id:'REVOKE_ACK_NOT_PROOF'} }));
  const responses = await Promise.all([a,b]);
  assert.deepEqual(responses.map(r => r.data.outcome), ['PENDING','PENDING']);
  assert.equal(f.messages[groupA][0].deletedForEveryone, undefined);
});
test('duplicate request during IN_FLIGHT never calls external socket twice', async () => {
  const f=fixture();
  const first=f.req('/crm/star',{jid:groupA,id});
  await Promise.resolve(); await Promise.resolve();
  const repeat=await f.req('/crm/star',{jid:groupA,id});
  assert.equal(repeat.code,202);
  assert.equal(repeat.data.outcome,'IN_FLIGHT');
  assert.equal(f.starCalls.length,1);
  f.waits[0].resolve();
  assert.equal((await first).code,202);
});
test('wrong group, missing id and private JID never produce an effect',async()=>{
  const f=fixture();
  const wrong=await f.req('/crm/delete',{jid:groupA,id:'3EB0UNKNOWN12345678'});
  assert.equal(wrong.code,404);
  assert.equal((await f.req('/crm/star',{jid:'123@s.whatsapp.net',id})).code,400);
  assert.equal((await f.req('/crm/delete',{jid:groupA,id:''})).code,400);
  assert.equal(f.deleteCalls.length+f.starCalls.length,0);
});
test('orphaned durable reservation without ACK after restart is UNKNOWN and never retries',async()=>{
  const f=fixture();
  const a=f.messages[groupA][0];
  a.starRequestedAt=Date.now();
  a.deleteRequestedAt=Date.now();
  const star=await f.req('/crm/star-status',{jid:groupA,id});
  const del=await f.req('/crm/delete-status',{jid:groupA,id});
  assert.equal(star.data.outcome,'UNKNOWN');
  assert.equal(del.data.outcome,'UNKNOWN');
  assert.equal((await f.req('/crm/delete',{jid:groupA,id})).code,202);
  assert.equal((await f.req('/crm/star',{jid:groupA,id})).code,409);
  assert.equal(f.deleteCalls.length+f.starCalls.length,0);
});
test('observed status in one group never confirms the other with identical id',async()=>{
  const f=fixture();
  f.messages[groupA][0].starred=true;
  f.messages[groupA][0].starObservedAt=Date.now();
  f.messages[groupA][0].starReceiptDurable=true;
  const a=await f.req('/crm/star-status',{jid:groupA,id});
  const b=await f.req('/crm/star-status',{jid:groupB,id});
  assert.equal(a.data.outcome,'CONFIRMED');
  assert.equal(b.data.outcome,'NOT_REQUESTED');
});
test('revoke receipt in one group never confirms the other with identical id',async()=>{
  const f=fixture();
  Object.assign(f.messages[groupB][0],{deletedForEveryone:true,deleteConfirmedAt:Date.now(),deleteReceiptDurable:true});
  assert.equal((await f.req('/crm/delete-status',{jid:groupA,id})).data.confirmed,false);
  assert.equal((await f.req('/crm/delete-status',{jid:groupB,id})).data.outcome,'CONFIRMED');
});
test('status endpoints remain read-only with no transport effects',async()=>{
  const f=fixture();
  await f.req('/crm/star-status',{jid:groupA,id});
  await f.req('/crm/delete-status',{jid:groupB,id});
  assert.equal(f.starCalls.length,0);assert.equal(f.deleteCalls.length,0);
});
