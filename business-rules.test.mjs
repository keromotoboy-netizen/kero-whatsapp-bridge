import assert from 'node:assert/strict';
import { paymentProofDecision, classifyContactSignals, invoiceRequestPlan } from './kero-business-rules.mjs';

assert.equal(paymentProofDecision({
  direction:'client_to_kero',
  contactType:'client',
  clientBillingType:'prepaid',
  serviceMode:'urgent'
}).allocationPriority,'immediate');

assert.equal(paymentProofDecision({
  direction:'kero_to_courier',
  contactType:'courier'
}).syncSheetPaid,true);

assert.equal(classifyContactSignals({
  courierGroupMatch:true,
  approvedCourier:true
}).type,'courier');

assert.equal(classifyContactSignals({
  requestedQuote:true
}).type,'client');

assert.equal(invoiceRequestPlan({
  client:{legalName:'Empresa X',document:'123',billingAddress:'Rua A'},
  invoice:{serviceDescription:'Entrega',amount:'100'}
}).ready,true);

console.log('business rules tests passed');
