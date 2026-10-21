import test from 'node:test';
import assert from 'node:assert/strict';
import {createCrmArchivedCleanup} from '../archived-cleanup-service.mjs';
test('production wiring never falls back to stale CRM on missing remote snapshot',async()=>{
 const calls=[],state={chats:{'100-1@g.us':{id:'100-1@g.us',archived:true}}};
 const socket={query:async()=>({}),authState:{keys:{get:async()=>({})}},groupFetchAllParticipating:async()=>({'100-1@g.us':{}}),chatModify:async(...a)=>calls.push(a)};
 const sdk={extractSyncdPatches:async()=>({regular_low:{patches:[],hasMorePatches:false}})};
 const api=createCrmArchivedCleanup({getConnection:()=>socket,readState:()=>state,sdk});
 await assert.rejects(api.preview({}),e=>e.code==='STATE_REFRESH_FAILED'&&e.archiveReason==='SNAPSHOT_MISSING');
 assert.equal(calls.length,0);assert.equal(state.chats['100-1@g.us'].archived,true);
});
