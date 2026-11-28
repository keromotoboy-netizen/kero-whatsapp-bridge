// Read a fresh full app-state snapshot into ephemeral memory. Never reset or
// write the live auth store or publish app-state mutations while selecting chats.
const unverified=(reason='INCOMPLETE_STATE')=>{throw Object.assign(new Error('ARCHIVE_SNAPSHOT_UNVERIFIED'),{archiveReason:reason});};

// Verified read of one app-state collection: snapshot + every patch (MAC/hash checked).
// apply(mutations, operation) receives each decoded mutation; it may call reject(reason).
async function readCollection(socket,sdk,name,apply,{maxPages=4}={}){
 let state;
 const reject=unverified;
 const logger={trace(){},debug(){},info(){},warn:()=>reject('MAC_OR_PATCH_VALIDATION_FAILED'),error:()=>reject('MAC_OR_PATCH_VALIDATION_FAILED')};
 const keyCache=new Map();
 const getKey=async id=>{
  if(!keyCache.has(id))keyCache.set(id,(await socket.authState.keys.get('app-state-sync-key',[id]))[id]);
  return keyCache.get(id);
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
  if(!data.hasMorePatches)return;
 }
 reject('PAGINATION_LIMIT');
}

export async function readArchivedGroupState(socket,sdk,{maxPages=4}={}){
 const archived=new Set(),reject=unverified;
 await readCollection(socket,sdk,'regular_low',(mutations,operation=sdk.proto?.SyncdMutation?.SyncdOperation?.SET)=>{
  for(const mutation of Object.values(mutations)){
   const index=mutation?.index,action=mutation?.syncAction?.value?.archiveChatAction;
   if(!Array.isArray(index) || index[0]!=='archive')continue;
   if(typeof index[1]!=='string')reject('INVALID_ARCHIVE_ACTION');
   if(operation===sdk.proto.SyncdMutation.SyncdOperation.REMOVE){archived.delete(index[1]);continue;}
   if(typeof action?.archived!=='boolean')reject('INVALID_ARCHIVE_ACTION');
   if(action.archived===true)archived.add(index[1]);else archived.delete(index[1]);
  }
 },{maxPages});
 const groups=await socket.groupFetchAllParticipating();
 if(!groups || typeof groups!=='object' || Array.isArray(groups))reject();
 return {members:new Set(Object.keys(groups)),archived};
}

// CEO 22/10/2026: ler (somente leitura) as respostas rapidas salvas e as mensagens favoritas (estrela).
// Cada colecao e lida a parte: se uma falhar na verificacao, as outras seguem e o erro volta no resultado.
export async function readSavedState(socket,sdk,{maxPages=8,collections=['regular','regular_high','regular_low']}={}){
 const quick=new Map(),starred=new Map(),errors={},tipos={},listas=new Map(),membros=new Map(); // CEO 25/10: Listas (etiquetas) tambem
 const REMOVE=sdk.proto?.SyncdMutation?.SyncdOperation?.REMOVE;
 for(const name of collections){
  try{
   await readCollection(socket,sdk,name,(mutations,operation)=>{
    for(const mutation of Object.values(mutations)){
     const index=mutation?.index,value=mutation?.syncAction?.value||{};
     if(!Array.isArray(index))continue;
     tipos[index[0]]=(tipos[index[0]]||0)+1;
     if(index[0]==='label_edit' && index[1]!=null){const l=value.labelEditAction||{};if(operation===REMOVE||l.deleted)listas.delete(String(index[1]));else listas.set(String(index[1]),{id:String(index[1]),name:String(l.name||''),color:l.color??null,type:l.type??null,listId:l.listId??null});}
     else if(index[0]==='label_jid' && index[1]!=null && typeof index[2]==='string'){const k=String(index[1])+'|'+index[2];if(operation===REMOVE||value.labelAssociationAction?.labeled===false)membros.delete(k);else membros.set(k,{labelId:String(index[1]),jid:index[2]});}
     if(index[0]==='quick_reply' && typeof index[1]==='string'){
      const q=value.quickReplyAction;
      if(operation===REMOVE || !q || q.deleted)quick.delete(index[1]);
      else quick.set(index[1],{id:index[1],shortcut:String(q.shortcut||''),message:String(q.message||''),keywords:(q.keywords||[]).map(String),count:Number(q.count||0)});
     }else if(index[0]==='star' && typeof index[1]==='string' && typeof index[2]==='string'){
      const key=index.slice(1,4).join('|');
      if(operation===REMOVE || value.starAction?.starred!==true)starred.delete(key);
      else starred.set(key,{jid:index[1],id:index[2],fromMe:index[3]==='1',participant:index[4]&&index[4]!=='0'?index[4]:null,timestamp:Number(value.timestamp||0)});
     }
    }
   },{maxPages});
  }catch(error){errors[name]=error?.archiveReason||String(error?.message||error).slice(0,80);}
 }
 return {quickReplies:[...quick.values()],starred:[...starred.values()],errors,tipos,listas:[...listas.values()],membros:[...membros.values()]};
}
