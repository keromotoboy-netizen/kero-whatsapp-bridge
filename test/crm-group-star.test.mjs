import test from 'node:test';
import assert from 'node:assert/strict';
import { mountCrmGroupStar } from '../crm-group-star.mjs';
const a='1234567890-0123456789@g.us', b='1234567890-0123456790@g.us';
const idA='3EB0ONE123456789', idB='3EB0TWO123456789';
function setup({fail=false, disconnected=false, saveError=false, own=true, persistedMessages=null}={}) {
  const routes=new Map(),calls=[];
  const app={post:(path,auth,callback)=>routes.set(path,callback)};
  const mA={id:idA,fromMe:own,deleted:false}, mB={id:idB,fromMe:true,deleted:false};
  const crm={state:{messages:persistedMessages || {[a]:[mA],[b]:[mB]}},saveNow:()=>{if(saveError)throw Error('disk full')}};
  const sock={chatModify:async (...args)=>{calls.push(args); if(fail) throw Error('socket fail')}};
  mountCrmGroupStar(app,()=>{}, {getSocket:()=>sock,isConnected:()=>!disconnected,crm});
  async function req(path,body){let code=200,data;const res={status(n){code=n;return this},json(x){data=x;return this}};await routes.get(path)({body},res);return {code,data};}
  return {req,calls,mA,mB,messages:crm.state.messages};
}
test('star each sent group message, individually and only once',async()=>{
  const t=setup();const r1=await t.req('/crm/star',{jid:a,id:idA});const r2=await t.req('/crm/star',{jid:b,id:idB});
  assert.equal(r1.code,202);assert.equal(r2.code,202);
  assert.equal(r1.data.confirmed,false);assert.equal(r2.data.confirmed,false);
  assert.equal(r1.data.accepted,true);assert.equal(r1.data.outcome,'PENDING');
  assert.deepEqual(t.calls[0],[{star:{messages:[{id:idA,fromMe:true}],star:true}},a]);
  assert.deepEqual(t.calls[1],[{star:{messages:[{id:idB,fromMe:true}],star:true}},b]);
  await t.req('/crm/star',{jid:a,id:idA});assert.equal(t.calls.length,2);
});
test('status is read-only and scoped to target message',async()=>{
  const t=setup();const s=await t.req('/crm/star-status',{jid:a,id:idA});
  assert.equal(s.data.confirmed,false);assert.equal(t.calls.length,0);
  await t.req('/crm/star',{jid:a,id:idA});
  assert.equal((await t.req('/crm/star-status',{jid:a,id:idA})).data.starred,false);
});
test('reject private JID, malformed ID and messages not sent by Kero',async()=>{
  const t=setup({own:false}); assert.equal((await t.req('/crm/star',{jid:a,id:idA})).code,404);
  assert.equal((await t.req('/crm/star',{jid:'123@s.whatsapp.net',id:idB})).code,400);
  assert.equal((await t.req('/crm/star',{jid:b,id:'broken'})).code,400);
  assert.equal(t.calls.length,0);
});
test('offline never stars',async()=>{const t=setup({disconnected:true});assert.equal((await t.req('/crm/star',{jid:a,id:idA})).code,409);assert.equal(t.calls.length,0)});
test('storage failure blocks outgoing star',async()=>{const t=setup({saveError:true});assert.equal((await t.req('/crm/star',{jid:a,id:idA})).code,503);assert.equal(t.calls.length,0)});
test('ambiguous socket outcome is not automatically retried',async()=>{
 const t=setup({fail:true});assert.equal((await t.req('/crm/star',{jid:a,id:idA})).code,502);
 const again=await t.req('/crm/star',{jid:a,id:idA});assert.equal(again.code,202);assert.equal(again.data.confirmed,false);assert.equal(t.calls.length,1);
});

test('confirmed star needs a durable event, not a resolved chatModify',async()=>{
 const t=setup();await t.req('/crm/star',{jid:a,id:idA});
 t.mA.starred=true;
 assert.equal((await t.req('/crm/star-status',{jid:a,id:idA})).data.confirmed,false);
 t.mA.starObservedAt=Date.now();
 assert.equal((await t.req('/crm/star-status',{jid:a,id:idA})).data.confirmed,false);
 t.mA.starReceiptDurable=true;
 const status=await t.req('/crm/star-status',{jid:a,id:idA});
 assert.equal(status.data.confirmed,true);assert.equal(status.data.confirmationSource,'messages.update:starred');
 assert.equal((await t.req('/crm/star',{jid:a,id:idA})).code,200);
 assert.equal(t.calls.length,1);
});
test('persisted pending star after restart never repeats chatModify',async()=>{
 const t=setup();await t.req('/crm/star',{jid:a,id:idA});
 const afterRestart=setup({persistedMessages:t.messages});
 const r=await afterRestart.req('/crm/star',{jid:a,id:idA});
 assert.equal(r.code,202);assert.equal(r.data.confirmed,false);
 assert.equal(afterRestart.calls.length,0);
});
test('previous starred flag without durable evidence is fail closed',async()=>{
 const t=setup();t.mA.starred=true;
 const r=await t.req('/crm/star',{jid:a,id:idA});
 assert.equal(r.code,202);assert.equal(r.data.confirmed,false);
 assert.equal(t.calls.length,0);
});
test('deleted own group message cannot be starred',async()=>{
 const t=setup();t.mA.deleted=true;
 const r=await t.req('/crm/star',{jid:a,id:idA});
 assert.equal(r.code,409);assert.equal(t.calls.length,0);
});
