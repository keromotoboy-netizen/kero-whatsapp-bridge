// Read a fresh full app-state snapshot into ephemeral memory. Never reset or
// write the live auth store or publish app-state mutations while selecting chats.
export async function readArchivedGroupState(socket,sdk,{maxPages=4}={}){
 const name='regular_low',archived=new Set();let state;
 const reject=(reason='INCOMPLETE_STATE')=>{throw Object.assign(new Error('ARCHIVE_SNAPSHOT_UNVERIFIED'),{archiveReason:reason});};
 const logger={trace(){},debug(){},info(){},warn:()=>reject('MAC_OR_PATCH_VALIDATION_FAILED'),error:()=>reject('MAC_OR_PATCH_VALIDATION_FAILED')};
 const keyCache=new Map();
 const getKey=async id=>{
  if(!keyCache.has(id))keyCache.set(id,(await socket.authState.keys.get('app-state-sync-key',[id]))[id]);
  return keyCache.get(id);
 };
 const apply=(mutations,operation=sdk.proto?.SyncdMutation?.SyncdOperation?.SET)=>{
  for(const mutation of Object.values(mutations)){
   const index=mutation?.index,action=mutation?.syncAction?.value?.archiveChatAction;
   if(!Array.isArray(index) || index[0]!=='archive')continue;
   if(typeof index[1]!=='string')reject('INVALID_ARCHIVE_ACTION');
   if(operation===sdk.proto.SyncdMutation.SyncdOperation.REMOVE){archived.delete(index[1]);continue;}
   if(typeof action?.archived!=='boolean')reject('INVALID_ARCHIVE_ACTION');
   if(action.archived===true)archived.add(index[1]);else archived.delete(index[1]);
  }
 };
 for(let page=0;page<maxPages;page++){
  const response=await socket.query({tag:'iq',attrs:{to:'s.whatsapp.net',xmlns:'w:sync:app:state',type:'set'},content:[{tag:'sync',attrs:{},content:[{tag:'collection',attrs:{name,version:state?String(state.version):'0',return_snapshot:state?'false':'true'}}]}]},20000);
  const data=(await sdk.extractSyncdPatches(response,{}))[name];
  if(!data || !Array.isArray(data.patches) || typeof data.hasMorePatches!=='boolean')reject();
  if(!state && !data.snapshot)reject('SNAPSHOT_MISSING');
  if(data.snapshot){
   if(state)reject();
   const decoded=await sdk.decodeSyncdSnapshot(name,data.snapshot,getKey,undefined,true,logger);
   state=decoded.state;apply(decoded.mutationMap);
  }
  if(!state || !Number.isSafeInteger(Number(state.version)) || Number(state.version)<=0)reject();
  if(data.patches.length){
   // Validate each complete patch, then preserve each mutation's operation when
   // applying archive actions. A signed REMOVE contains the old value, not SET.
   for(const patch of data.patches){
    if(patch.externalMutations)reject('EXTERNAL_PATCH_UNSUPPORTED');
    if(!Array.isArray(patch.mutations))reject('INVALID_PATCH');
    const {SET,REMOVE}=sdk.proto.SyncdMutation.SyncdOperation;
    if(patch.mutations.some(m=>![SET,REMOVE].includes(m.operation??SET)))reject('INVALID_OPERATION');
    const copy={...patch,mutations:[...patch.mutations]};
    const verified=await sdk.decodePatches(name,[copy],state,getKey,{},undefined,logger,true);
    let interim={...state,indexValueMap:{...state.indexValueMap}};
    const changes=[];
    for(const mutation of patch.mutations){
     let count=0;
     const decoded=await sdk.decodeSyncdMutations([mutation],interim,getKey,value=>{count++;changes.push({value,operation:mutation.operation??SET});},true);
     if(count!==1)reject('MUTATION_UNVERIFIED');
     interim={...interim,hash:decoded.hash,indexValueMap:decoded.indexValueMap};
    }
    if(!Buffer.from(interim.hash).equals(Buffer.from(verified.state.hash)))reject('PATCH_STATE_MISMATCH');
    state=verified.state;
    for(const {value,operation} of changes)apply([value],operation);
   }
  }
  if(!data.hasMorePatches){
   const groups=await socket.groupFetchAllParticipating();
   if(!groups || typeof groups!=='object' || Array.isArray(groups))reject();
   return {members:new Set(Object.keys(groups)),archived};
  }
 }
 reject('PAGINATION_LIMIT');
}
