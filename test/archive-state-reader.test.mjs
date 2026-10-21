import test from 'node:test';
import assert from 'node:assert/strict';
import {readArchivedGroupState} from '../archive-state-reader.mjs';

function fixture(){
 const actions={a:{index:['archive','100-1@g.us'],syncAction:{value:{archiveChatAction:{archived:true}}}},b:{index:['archive','100-2@g.us'],syncAction:{value:{archiveChatAction:{archived:false}}}}};
 const queries=[],pages=[{snapshot:{records:[]},patches:[],hasMorePatches:false}];let n=0;
 const socket={query:async node=>{queries.push(node);return pages[n++];},authState:{keys:{get:async()=>({}),set:()=>{throw Error('Forbidden auth mutation');}}},groupFetchAllParticipating:async()=>({'100-1@g.us':{},'100-2@g.us':{}})};
 const sdk={proto:{SyncdMutation:{SyncdOperation:{SET:0,REMOVE:1}}},extractSyncdPatches:async response=>({regular_low:response}),decodeSyncdSnapshot:async()=>({state:{version:5,hash:Buffer.alloc(128),indexValueMap:{}},mutationMap:actions}),decodePatches:async(_name,_p,old)=>({state:{...old,version:old.version+1},mutationMap:{}}),decodeSyncdMutations:async(ms,old,_get,cb)=>{for(const m of ms)cb(m.decoded);return old;}};
 return {socket,sdk,queries,pages,actions};
}
test('full read ignores persisted CRM and never writes auth; excludes explicit false',async()=>{
 const f=fixture(),r=await readArchivedGroupState(f.socket,f.sdk);
 assert.deepEqual([...r.archived],['100-1@g.us']);assert.deepEqual([...r.members],['100-1@g.us','100-2@g.us']);
 assert.deepEqual(f.queries[0].content[0].content[0].attrs,{name:'regular_low',version:'0',return_snapshot:'true'});
});
test('missing snapshot, unknown completion and MAC warnings reject instead of selecting partial data',async()=>{
 for(const variant of ['snapshot','completion','mac']){
  const f=fixture();if(variant==='snapshot')delete f.pages[0].snapshot;
  if(variant==='completion')delete f.pages[0].hasMorePatches;
  if(variant==='mac')f.sdk.decodeSyncdSnapshot=async(_n,_s,_k,_v,_verify,logger)=>{logger.warn('bad mac');};
  await assert.rejects(readArchivedGroupState(f.socket,f.sdk),/UNVERIFIED/);
 }
});
test('patches can unarchive; remaining pages continue from decoded version',async()=>{
 const f=fixture();f.pages[0].hasMorePatches=true;f.pages.push({patches:[{mutations:[{operation:0,decoded:{index:['archive','100-1@g.us'],syncAction:{value:{archiveChatAction:{archived:false}}}}}]}],hasMorePatches:false});
 f.sdk.decodePatches=async(_n,_p,old)=>({state:{...old,version:6},mutationMap:{x:{index:['archive','100-1@g.us'],syncAction:{value:{archiveChatAction:{archived:false}}}}}});
 const r=await readArchivedGroupState(f.socket,f.sdk);assert.equal(r.archived.size,0);
 assert.equal(f.queries[1].content[0].content[0].attrs.version,'5');
});
test('authenticated REMOVE means no archive even when its old value was true',async()=>{
 const f=fixture();f.pages[0].patches=[{mutations:[{operation:1,decoded:f.actions.a}]}];
 const r=await readArchivedGroupState(f.socket,f.sdk);assert.equal(r.archived.size,0);
});
test('external patches and exceeded page budget reject all selection',async()=>{
 for(const variant of ['external','pages']){
  const f=fixture();f.pages[0].patches=variant==='external'?[{externalMutations:{},mutations:[]}]:[];
  if(variant==='pages')f.pages[0].hasMorePatches=true;
  await assert.rejects(readArchivedGroupState(f.socket,f.sdk,{maxPages:1}),/UNVERIFIED/);
 }
});
test('freshness errors carry a safe reason without leaking raw crypto material',async()=>{
 const f=fixture();delete f.pages[0].snapshot;
 await assert.rejects(readArchivedGroupState(f.socket,f.sdk),e=>e.archiveReason==='SNAPSHOT_MISSING');
});
