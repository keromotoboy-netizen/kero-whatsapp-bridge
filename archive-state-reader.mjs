// Read a fresh full app-state snapshot into ephemeral memory. Never reset or
// write the live auth store or publish app-state mutations while selecting chats.
export async function readArchivedGroupState(socket,sdk,{maxPages=4}={}){
 const name='regular_low',archived=new Set();let state;
 const reject=()=>{throw new Error('ARCHIVE_SNAPSHOT_UNVERIFIED');};
 const logger={trace(){},debug(){},info(){},warn:reject,error:reject};
 const keyCache=new Map();
 const getKey=async id=>{
  if(!keyCache.has(id))keyCache.set(id,(await socket.authState.keys.get('app-state-sync-key',[id]))[id]);
  return keyCache.get(id);
 };
 const apply=mutations=>{
  for(const mutation of Object.values(mutations)){
   const index=mutation?.index,action=mutation?.syncAction?.value?.archiveChatAction;
   if(!Array.isArray(index) || index[0]!=='archive')continue;
   if(typeof index[1]!=='string' || typeof action?.archived!=='boolean')reject();
   if(action.archived===true)archived.add(index[1]);else archived.delete(index[1]);
  }
 };
 for(let page=0;page<maxPages;page++){
  const response=await socket.query({tag:'iq',attrs:{to:'s.whatsapp.net',xmlns:'w:sync:app:state',type:'set'},content:[{tag:'sync',attrs:{},content:[{tag:'collection',attrs:{name,version:state?String(state.version):'0',return_snapshot:state?'false':'true'}}]}]},20000);
  const data=(await sdk.extractSyncdPatches(response,{}))[name];
  if(!data || !Array.isArray(data.patches) || typeof data.hasMorePatches!=='boolean')reject();
  if(!state && !data.snapshot)reject();
  if(data.snapshot){
   if(state)reject();
   const decoded=await sdk.decodeSyncdSnapshot(name,data.snapshot,getKey,undefined,true,logger);
   state=decoded.state;apply(decoded.mutationMap);
  }
  if(!state || !Number.isSafeInteger(Number(state.version)) || Number(state.version)<=0)reject();
  if(data.patches.length){
   // REMOVE carries the old value. Reject the whole read rather than mistake it
   // for a positive archive action. Do not silently use a partial selection.
   for(const patch of data.patches){
    if(patch.externalMutations)reject();
    if(!Array.isArray(patch.mutations) || patch.mutations.some(m=>m.operation!==sdk.proto.SyncdMutation.SyncdOperation.SET))reject();
   }
   const decoded=await sdk.decodePatches(name,data.patches,state,getKey,{},undefined,logger,true);
   state=decoded.state;apply(decoded.mutationMap);
  }
  if(!data.hasMorePatches){
   const groups=await socket.groupFetchAllParticipating();
   if(!groups || typeof groups!=='object' || Array.isArray(groups))reject();
   return {members:new Set(Object.keys(groups)),archived};
  }
 }
 reject();
}
