const SERVICE_MODES = Object.freeze({
  URGENT: 'urgent',
  NON_URGENT: 'non_urgent',
  SPLIT: 'split'
});

const CONTACT_TYPES = Object.freeze({
  CLIENT: 'client',
  COURIER: 'courier',
  MIXED: 'mixed',
  INTERNAL: 'internal',
  SUPPLIER: 'supplier',
  UNKNOWN: 'unknown'
});

const GROUP_TYPES = Object.freeze({
  COURIERS: 'couriers',
  CLIENTS: 'clients',
  INTERNAL: 'internal',
  MIXED: 'mixed',
  IGNORE: 'ignore',
  UNKNOWN: 'unknown'
});

export function paymentProofDecision({
  direction,
  contactType,
  clientBillingType = 'prepaid',
  serviceMode = SERVICE_MODES.NON_URGENT
} = {}) {
  if (direction === 'client_to_kero' && contactType === CONTACT_TYPES.CLIENT) {
    if (clientBillingType === 'invoiced') {
      return {
        action: 'attach_only',
        markClientPaid: false,
        releaseAllocation: true,
        reason: 'invoiced_client_does_not_require_per_service_payment'
      };
    }

    const priority =
      serviceMode === SERVICE_MODES.URGENT ? 'immediate' :
      serviceMode === SERVICE_MODES.SPLIT ? 'split_queue' :
      'normal_sla';

    return {
      action: 'client_payment_confirmed_by_proof',
      markClientPaid: true,
      releaseAllocation: true,
      allocationPriority: priority
    };
  }

  if (direction === 'kero_to_courier' && contactType === CONTACT_TYPES.COURIER) {
    return {
      action: 'courier_payout_confirmed',
      markCourierPaid: true,
      syncSheetPaid: true
    };
  }

  return {
    action: 'manual_review',
    markClientPaid: false,
    markCourierPaid: false,
    releaseAllocation: false
  };
}

export function classifyContactSignals({
  approvedCourier = false,
  courierGroupMatch = false,
  clientGroupMatch = false,
  labels = [],
  requestedQuote = false,
  manualType = null
} = {}) {
  if (manualType) return { type: manualType, confidence: 1, reason: 'manual_override' };

  const normalized = labels.map(x => String(x || '').toLowerCase());
  const courierLabel = normalized.some(x => x.includes('motoboy') || x.includes('moto boy'));
  const clientLabel = normalized.some(x => x.includes('cliente') || x.includes('faturad'));

  const courierScore = (approvedCourier ? 5 : 0) + (courierGroupMatch ? 4 : 0) + (courierLabel ? 3 : 0);
  const clientScore = (requestedQuote ? 4 : 0) + (clientGroupMatch ? 3 : 0) + (clientLabel ? 3 : 0);

  if (courierScore >= 5 && clientScore >= 5) {
    return { type: CONTACT_TYPES.MIXED, confidence: 0.9, reason: 'strong_signals_both_roles' };
  }
  if (courierScore >= 5) {
    return { type: CONTACT_TYPES.COURIER, confidence: Math.min(0.99, 0.6 + courierScore / 20), reason: 'courier_signals' };
  }
  if (clientScore >= 4) {
    return { type: CONTACT_TYPES.CLIENT, confidence: Math.min(0.99, 0.6 + clientScore / 20), reason: 'client_signals' };
  }

  return { type: CONTACT_TYPES.UNKNOWN, confidence: 0.25, reason: 'insufficient_signals' };
}

export function invoiceRequestPlan({ client = {}, invoice = {} } = {}) {
  const required = ['legalName', 'document', 'billingAddress', 'serviceDescription', 'amount'];
  const merged = { ...client, ...invoice };
  const missing = required.filter(k => !String(merged[k] ?? '').trim());

  if (missing.length) {
    return {
      ready: false,
      missing,
      nextAction: 'ask_missing_invoice_fields'
    };
  }

  return {
    ready: true,
    missing: [],
    nextAction: 'delegate_to_finance_invoice_agent',
    customerMessage: 'Maravilha, já passei para o financeiro emitir. Assim que estiver pronta eu te envio por aqui.'
  };
}

export { SERVICE_MODES, CONTACT_TYPES, GROUP_TYPES };
