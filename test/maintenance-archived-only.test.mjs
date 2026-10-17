import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src=readFileSync(new URL('../server.mjs', import.meta.url),'utf8');

function fixture(){
  const events=[];
  const messages={
    'g-archived@g.us':[{id:'m1',fromMe:false,timestamp:12},{id:'m2',fromMe:true,timestamp:13}],
    'g-active@g.us':[{id:'m3',fromMe:false,timestamp:14}],
    'g-client@g.us':[{id:'m4',fromMe:false,timestamp:15}],
    'direct@s.whatsapp.net':[{id:'m5',fromMe:true,timestamp:16}]
  };
  const CRM={state:{
    groups:{
      'g-archived@g.us':{id:'g-archived@g.us',subject:'Grupo profissional'},
      'g-active@g.us':{id:'g-active@g.us',subject:'Grupo prestador'},
      'g-client@g.us':{id:'g-client@g.us',subject:'Grupo cliente Harmonia'},
      'direct@s.whatsapp.net':{id:'direct@s.whatsapp.net',subject:'Contacto'},
    },
    chats:{
      'g-archived@g.us':{archived:true},
      'g-active@g.us':{archived:false},
      'g-client@g.us':{archived:true},
      'direct@s.whatsapp.net':{archived:true}
    },
    labels:{'41':{id:'41',name:'📌Cliente do dia',deleted:false},'42':{id:'42',name:'Pagamento de Motoboy/Motorista',deleted:false},'43':{id:'43',name:'Outros',deleted:false}},
    chatLabels:{
      'g-archived@g.us':['41','43'],
      'g-active@g.us':['42'],
      'direct@s.whatsapp.net':['41','42']
    }
  },getMessages:(jid)=>messages[jid]||[],saveNow:()=>events.push({operation:'save'})};
  const sock={chatModify:async(arg,jid)=>events.push({operation:'chatModify',arg,jid})};
  const sleep=async()=>{};
  return {CRM,sock,sleep,events};
}
function compile(sourceStart,sourceEnd,fixture,extra={}){
 const a=src.indexOf(sourceStart),b=src.indexOf(sourceEnd,a+1);
 assert.ok(a>=0&&b>a);
 return new Function('CRM','sock','sleep','TEMP_LABEL_NAMES','labelsByName','norm',src.slice(a,b)+';return {clearArchivedGroups:typeof clearArchivedGroups==="function"?clearArchivedGroups:undefined,removeTemporaryLabels:typeof removeTemporaryLabels==="function"?removeTemporaryLabels:undefined,isArchivedGroup:typeof isArchivedGroup==="function"?isArchivedGroup:undefined};')(
 fixture.CRM,fixture.sock,fixture.sleep,
 new Set(['📌Cliente do dia','Pagamento de Motoboy/Motorista']),
 ()=>new Map(Object.values(fixture.CRM.state.labels).filter(x=>!x.deleted).map(x=>[String(x.name).toLowerCase(),x.id])),
 v=>String(v||'').trim()
 );
}
test('only archived group messages are cleared; non-archived are untouched',async()=>{
 const f=fixture(),x=compile('const isArchivedGroup','async function runKeroMaintenance',f);
 assert.equal(x.isArchivedGroup(f.CRM.state.groups['g-active@g.us']),false);
 assert.equal(x.isArchivedGroup(f.CRM.state.groups['g-archived@g.us']),true);
 const data=await x.clearArchivedGroups(false);
 assert.deepEqual(data.map(z=>z.id).sort(),['g-archived@g.us','g-client@g.us']);
 const modifications=f.events.filter(z=>z.operation==='chatModify');
 assert.deepEqual(modifications.map(z=>z.jid).sort(),['g-archived@g.us','g-client@g.us']);
});
test('archived client groups are included regardless of name or labels',async()=>{
 const f=fixture(),x=compile('const isArchivedGroup','async function runKeroMaintenance',f);
 const d=await x.clearArchivedGroups(false);
 assert.ok(d.some(z=>z.id==='g-client@g.us'&&z.cleared===1));
 assert.ok(!d.some(z=>z.id==='g-active@g.us'));
});
test('cleaning messages never deletes or leaves any group and dryRun never mutates',async()=>{
 const f=fixture(),x=compile('const isArchivedGroup','async function runKeroMaintenance',f);
 const planned=await x.clearArchivedGroups(true);
 assert.equal(planned.length,2);
 assert.equal(f.events.length,0);
 await x.clearArchivedGroups(false);
 const ops=f.events.filter(z=>z.operation==='chatModify').map(z=>Object.keys(z.arg));
 assert.ok(ops.every(keys=>keys.length===1&&keys[0]==='clear'));
});
test('temporary labels are removed from contacts AND groups without deleting chats',async()=>{
 const f=fixture(),x=compile('async function removeTemporaryLabels','// CEO 16/10/2026',f);
 const before=JSON.stringify(f.CRM.state.chats);
 const proposed=await x.removeTemporaryLabels(true);
 assert.equal(proposed.length,4);
 assert.equal(f.events.length,0);
 const done=await x.removeTemporaryLabels(false);
 assert.equal(done.length,4);
 assert.equal(JSON.stringify(f.CRM.state.chats),before);
 assert.equal(f.CRM.state.chatLabels['g-archived@g.us'].includes('41'),false);
 assert.equal(f.CRM.state.chatLabels['g-active@g.us'].includes('42'),false);
 assert.deepEqual(f.CRM.state.chatLabels['direct@s.whatsapp.net'],[]);
 assert.equal(f.events.filter(z=>z.operation==='chatModify').every(z=>Object.keys(z.arg).join(',')==='removeChatLabel'),true);
});
