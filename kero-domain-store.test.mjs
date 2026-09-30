import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeroDomainStore } from './kero-domain-store.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'kero-domain-'));
const auth=path.join(root,'auth');
fs.mkdirSync(auth,{recursive:true});
const D=createKeroDomainStore(auth);

const s=D.createService({
  serviceDate:'2026-09-30',
  clientId:'cli-1',clientName:'Cliente Teste',mode:'urgent',vehicle:'motorcycle',
  km:12,clientValue:80,courierPayout:35,closer:'victoria',closingLabel:'Urgente Normal',actor:'victoria'
});
assert.ok(s.id.startsWith('KERO-20260930-'));
assert.equal(s.status,'quote');

D.markClientPaid(s.id,{proofMessageId:'msg-pay',actor:'crm_ai'});
D.assignCourier(s.id,{courierId:'m1',courierName:'João',allocator:'victoria',allocationLabel:'Alocação Urgente',actor:'victoria'});
D.setStatus(s.id,'arrived_pickup','crm',{proof:'photo'});
D.addProof(s.id,{type:'pickup_photo',messageId:'msg-photo'},'crm');
D.setStatus(s.id,'picked_up','crm');
D.setStatus(s.id,'in_delivery','crm');
D.setStatus(s.id,'completed','crm',{receiverName:'Maria'});
D.markCourierPaid(s.id,{proofMessageId:'msg-payout',actor:'victor'});
const pts=D.recordPoints(s.id,{actor:'crm'});
assert.equal(pts.points,6);

const saved=D.getService(s.id);
assert.equal(saved.clientPaymentStatus,'paid');
assert.equal(saved.courierPaymentStatus,'paid');
assert.equal(saved.courierName,'João');
assert.equal(saved.status,'completed');
assert.equal(saved.proofs.length,1);
assert.equal(D.todayServices('2026-09-30T12:00:00Z').length,1);

D.upsertClient('cli-fat',{name:'Empresa FAT',billingType:'invoiced'});
D.saveBilledDailySummary('cli-fat','2026-09-30',{requester:'Carla',serviceValue:150,extras:10,addresses:['A','B']});
assert.equal(Object.keys(D.state.billedDailySummaries).length,1);

fs.rmSync(root,{recursive:true,force:true});
console.log('kero domain store tests passed');
