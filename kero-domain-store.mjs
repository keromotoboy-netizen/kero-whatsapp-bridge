import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { calculateVictoriaPoints } from './victoria-points.mjs';

const now = () => Date.now();
const isoDate = value => {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0,10);
  return d.toISOString().slice(0,10);
};
const idPart = () => crypto.randomBytes(3).toString('hex').toUpperCase();

export function createKeroDomainStore(dataDir) {
  const file = path.join(path.dirname(dataDir), 'kero-domain.json');
  let state = {
    version:1,
    updatedAt:now(),
    services:{},
    clients:{},
    couriers:{},
    customerProcedures:{},
    groupOverrides:{},
    billedDailySummaries:{},
    pointLedger:[],
    audit:[]
  };

  try {
    if (fs.existsSync(file)) state = { ...state, ...JSON.parse(fs.readFileSync(file,'utf8')) };
  } catch (error) {
    console.error('[domain] load failed', error?.message || error);
  }

  const save = () => {
    state.updatedAt=now();
    fs.writeFileSync(file+'.tmp',JSON.stringify(state));
    fs.renameSync(file+'.tmp',file);
  };

  const audit = (type, entityId, data={}, actor='system') => {
    state.audit.push({id:'audit_'+idPart(),at:now(),type,entityId,actor,data});
    if(state.audit.length>5000) state.audit.splice(0,state.audit.length-5000);
  };

  const createService = input => {
    const date=isoDate(input?.serviceDate);
    const id=input?.id || ('KERO-'+date.replaceAll('-','')+'-'+idPart());
    if(state.services[id]) throw new Error('service_exists');
    const service={
      id,
      createdAt:now(),
      updatedAt:now(),
      serviceDate:date,
      status:'quote',
      mode:input?.mode||null,
      vehicle:input?.vehicle||null,
      clientId:input?.clientId||null,
      clientName:input?.clientName||null,
      contactJid:input?.contactJid||null,
      courierId:null,
      courierName:null,
      km:Number(input?.km||0),
      clientValue:Number(input?.clientValue||0),
      courierPayout:Number(input?.courierPayout||0),
      extras:[],
      stops:Array.isArray(input?.stops)?input.stops:[],
      currentStop:0,
      invoiceRequired:!!input?.invoiceRequired,
      receiptRequired:!!input?.receiptRequired,
      clientPaymentStatus:input?.clientPaymentStatus||'pending',
      courierPaymentStatus:'pending',
      billingType:input?.billingType||'prepaid',
      closer:input?.closer||null,
      allocator:input?.allocator||null,
      closingLabel:input?.closingLabel||'',
      allocationLabel:input?.allocationLabel||'',
      proofs:[],
      events:[],
      source:input?.source||null,
      notes:input?.notes||null
    };
    service.events.push({at:now(),status:'quote',by:input?.actor||'system'});
    state.services[id]=service;
    audit('service_created',id,{clientName:service.clientName},input?.actor||'system');
    save();
    return service;
  };

  const updateService = (id,patch={},actor='system') => {
    const s=state.services[id];
    if(!s) return null;
    const allowed=['mode','vehicle','km','clientValue','courierPayout','invoiceRequired','receiptRequired','clientPaymentStatus','courierPaymentStatus','billingType','closer','allocator','closingLabel','allocationLabel','notes','currentStop'];
    for(const k of allowed) if(Object.prototype.hasOwnProperty.call(patch,k)) s[k]=patch[k];
    s.updatedAt=now();
    audit('service_updated',id,{fields:Object.keys(patch)},actor);
    save();
    return s;
  };

  const setStatus = (id,status,actor='system',meta={}) => {
    const s=state.services[id]; if(!s) return null;
    s.status=String(status);
    s.updatedAt=now();
    s.events.push({at:now(),status:s.status,by:actor,meta});
    audit('status_changed',id,{status:s.status,...meta},actor);
    save(); return s;
  };

  const assignCourier = (id,{courierId=null,courierName=null,allocator=null,allocationLabel='',actor='system'}={}) => {
    const s=state.services[id]; if(!s) return null;
    s.courierId=courierId; s.courierName=courierName;
    if(allocator) s.allocator=allocator;
    if(allocationLabel) s.allocationLabel=allocationLabel;
    s.status='courier_assigned'; s.updatedAt=now();
    s.events.push({at:now(),status:'courier_assigned',by:actor,courierId,courierName});
    audit('courier_assigned',id,{courierId,courierName,allocator},actor);
    save(); return s;
  };

  const addProof = (id,{type,url=null,messageId=null,stopIndex=null,meta={}}={},actor='system') => {
    const s=state.services[id]; if(!s) return null;
    const proof={id:'proof_'+idPart(),at:now(),type,url,messageId,stopIndex,meta,actor};
    s.proofs.push(proof); s.updatedAt=now();
    audit('proof_added',id,{proofId:proof.id,type},actor);
    save(); return proof;
  };

  const markClientPaid = (id,{proofMessageId=null,actor='system'}={}) => {
    const s=state.services[id]; if(!s) return null;
    s.clientPaymentStatus=s.billingType==='invoiced'?'monthly_invoiced':'paid';
    s.updatedAt=now();
    s.events.push({at:now(),status:'client_payment_confirmed',by:actor,proofMessageId});
    audit('client_paid',id,{proofMessageId},actor);
    save(); return s;
  };

  const markCourierPaid = (id,{proofMessageId=null,actor='system'}={}) => {
    const s=state.services[id]; if(!s) return null;
    s.courierPaymentStatus='paid'; s.updatedAt=now();
    s.events.push({at:now(),status:'courier_payment_confirmed',by:actor,proofMessageId});
    audit('courier_paid',id,{proofMessageId},actor);
    save(); return s;
  };

  const recordPoints = (id,{isSaturdayOrHoliday=false,actor='system'}={}) => {
    const s=state.services[id]; if(!s) return null;
    const result=calculateVictoriaPoints({
      closer:s.closer,
      allocator:s.allocator,
      closingLabel:s.closingLabel,
      allocationLabel:s.allocationLabel,
      isSaturdayOrHoliday
    });
    const ledger={
      id:'pts_'+idPart(),serviceId:id,staff:'victoria',points:result.points,
      details:result.details,at:now(),actor
    };
    state.pointLedger=state.pointLedger.filter(x=>x.serviceId!==id);
    if(result.points!==0) state.pointLedger.push(ledger);
    audit('points_calculated',id,{points:result.points},actor);
    save(); return ledger;
  };

  const upsertClient = (id,input={},actor='system') => {
    const key=String(id||input?.id||'').trim(); if(!key) throw new Error('client_id_required');
    state.clients[key]={...(state.clients[key]||{}),...input,id:key,updatedAt:now()};
    audit('client_upserted',key,{},actor); save(); return state.clients[key];
  };

  const upsertCourier = (id,input={},actor='system') => {
    const key=String(id||input?.id||'').trim(); if(!key) throw new Error('courier_id_required');
    state.couriers[key]={...(state.couriers[key]||{}),...input,id:key,updatedAt:now()};
    audit('courier_upserted',key,{},actor); save(); return state.couriers[key];
  };

  const setCustomerProcedure = (clientId,procedure={},actor='system') => {
    state.customerProcedures[clientId]={...procedure,clientId,updatedAt:now()};
    audit('customer_procedure_set',clientId,{version:procedure.version||null},actor);
    save(); return state.customerProcedures[clientId];
  };

  const setGroupOverride = (groupId,policy={},actor='system') => {
    state.groupOverrides[groupId]={...policy,groupId,updatedAt:now()};
    audit('group_override_set',groupId,{},actor); save(); return state.groupOverrides[groupId];
  };

  const saveBilledDailySummary = (clientId,date,summary={},actor='system') => {
    const key=clientId+'|'+isoDate(date);
    state.billedDailySummaries[key]={...summary,clientId,date:isoDate(date),updatedAt:now()};
    audit('billed_daily_summary_saved',key,{},actor); save(); return state.billedDailySummaries[key];
  };

  const todayServices = (date=new Date()) => {
    const d=isoDate(date);
    return Object.values(state.services)
      .filter(x=>x.serviceDate===d)
      .sort((a,b)=>a.createdAt-b.createdAt)
      .map(x=>({
        id:x.id,clientName:x.clientName,courierName:x.courierName,status:x.status,
        currentStop:x.currentStop,totalStops:x.stops?.length||0,mode:x.mode,vehicle:x.vehicle,
        clientPaymentStatus:x.clientPaymentStatus,courierPaymentStatus:x.courierPaymentStatus
      }));
  };

  const getService=id=>state.services[id]||null;
  const listServices=({date=null,status=null}={})=>Object.values(state.services)
    .filter(x=>!date||x.serviceDate===isoDate(date))
    .filter(x=>!status||x.status===status)
    .sort((a,b)=>b.createdAt-a.createdAt);

  return {
    state,save,audit,createService,updateService,setStatus,assignCourier,addProof,
    markClientPaid,markCourierPaid,recordPoints,upsertClient,upsertCourier,
    setCustomerProcedure,setGroupOverride,saveBilledDailySummary,todayServices,getService,listServices
  };
}
