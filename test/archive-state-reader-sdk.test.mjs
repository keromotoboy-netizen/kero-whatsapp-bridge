import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import * as sdk from 'baileys';
import {readArchivedGroupState} from '../archive-state-reader.mjs';

// Synthetic keys only: exercise real SDK authentication/REMOVE semantics offline.
async function fixture(operation){
 const keyId=Buffer.from('fixture-key').toString('base64'),key={keyData:randomBytes(32)};
 const getKey=async id=>id===keyId?key:undefined;
 const input={type:'regular_low',index:['archive','100-1@g.us'],syncAction:{archiveChatAction:{archived:true},timestamp:2000000000000},apiVersion:3,operation:sdk.proto.SyncdMutation.SyncdOperation.SET};
 const first=await sdk.encodeSyncdPatch(input,keyId,sdk.newLTHashState(),getKey);
 const next=await sdk.encodeSyncdPatch({...input,operation,syncAction:{...input.syncAction,archiveChatAction:{archived:operation===sdk.proto.SyncdMutation.SyncdOperation.REMOVE}}},keyId,first.state,getKey);
 next.patch.version={version:next.state.version};
 const snapshot={version:{version:first.state.version},records:first.patch.mutations.map(m=>m.record),keyId:first.patch.keyId,mac:first.patch.snapshotMac};
 const response={regular_low:{snapshot,patches:[next.patch],hasMorePatches:false}};
 const socket={query:async()=>response,authState:{keys:{get:async(_type,ids)=>Object.fromEntries(await Promise.all(ids.map(async id=>[id,await getKey(id)]))),set:()=>{throw Error('Forbidden auth write');}}},groupFetchAllParticipating:async()=>({'100-1@g.us':{}})};
 return {socket,wireSdk:{...sdk,extractSyncdPatches:async r=>r},response};
}
test('real SDK signed REMOVE removes archive membership, never applies its old true value',async()=>{
 const f=await fixture(sdk.proto.SyncdMutation.SyncdOperation.REMOVE);
 const result=await readArchivedGroupState(f.socket,f.wireSdk);assert.equal(result.archived.size,0);assert.equal(result.members.size,1);
});
test('real SDK signed SET false unarchives and preserves authenticated state continuity',async()=>{
 const f=await fixture(sdk.proto.SyncdMutation.SyncdOperation.SET);
 const result=await readArchivedGroupState(f.socket,f.wireSdk);assert.equal(result.archived.size,0);
});
test('real SDK corrupted patch MAC cannot return a partial archived selection',async()=>{
 const f=await fixture(sdk.proto.SyncdMutation.SyncdOperation.REMOVE);
 f.response.regular_low.patches[0].patchMac[0]^=1;
 await assert.rejects(readArchivedGroupState(f.socket,f.wireSdk));
});
