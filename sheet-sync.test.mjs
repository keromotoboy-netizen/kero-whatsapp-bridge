import assert from 'node:assert/strict';
import { serviceToSheetRow,reconcileBilledMonth } from './sheet-sync.mjs';
const row=serviceToSheetRow({
 serviceDate:'2026-09-30',clientName:'Harmonia',clientValue:100,billingType:'invoiced',
 courierName:'João',courierPayout:40,courierPaymentStatus:'paid',status:'completed',
 invoiceRequired:true,closer:'victoria',closingLabel:'S/Urgencia Normal',
 allocator:'victor',allocationLabel:'Victor'
});
assert.equal(row[1],'Harmonia');
assert.equal(row[3],'FAT MENSAL');
assert.equal(row[7],'PAGO');
assert.equal(row[9],'Sim');
assert.equal(row[10],'S/Urgencia Normal');
assert.equal(row[11],'victor');
assert.equal(reconcileBilledMonth({crmServices:[{billingType:'invoiced',clientValue:100},{billingType:'invoiced',clientValue:50}],sheetTotal:150}).ok,true);
assert.equal(reconcileBilledMonth({crmServices:[{billingType:'invoiced',clientValue:100}],sheetTotal:90}).difference,10);
console.log('sheet sync tests passed');
