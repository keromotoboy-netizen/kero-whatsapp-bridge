import fs from 'node:fs';

const loadKnowledge = () => {
  try {
    return JSON.parse(fs.readFileSync(new URL('./kero-ops-knowledge.json', import.meta.url), 'utf8'));
  } catch {
    return {};
  }
};

const K = loadKnowledge();
const roundMoney = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function recommendVehicle({ weightKg = 0, lengthCm = 0, widthCm = 0, heightCm = 0, slimLight = false } = {}) {
  const w = Number(weightKg || 0);
  const l = Number(lengthCm || 0) / 100;
  const wi = Number(widthCm || 0) / 100;
  const h = Number(heightCm || 0) / 100;

  if (w <= 20 && ((lengthCm <= 50 && widthCm <= 50 && heightCm <= 50) || (slimLight && lengthCm <= 130))) {
    return { vehicle: 'motorcycle', surcharge: false, reason: 'fits_motorcycle_standard' };
  }

  if (w <= 250 && l <= 1.20 && wi <= 1.00 && h <= 0.65) {
    return { vehicle: 'car', surcharge: false, reason: 'exceeds_motorcycle_recommend_car' };
  }
  if (w <= 600 && l <= 1.80 && wi <= 1.10 && h <= 1.30) {
    return { vehicle: 'fiorino', surcharge: false, reason: 'fits_fiorino' };
  }
  if (w <= 600 && l <= 2.50 && wi <= 1.10 && h <= 1.30) {
    return { vehicle: 'strada', surcharge: false, reason: 'fits_strada' };
  }
  if (w <= 1500 && l <= 2.80 && wi <= 1.80 && h <= 1.90) {
    return { vehicle: 'van', surcharge: false, reason: 'fits_van' };
  }
  if (w <= 2000 && l <= 3.80 && wi <= 1.80 && h <= 1.90) {
    return { vehicle: 'iveco_master', surcharge: false, reason: 'fits_iveco_master' };
  }
  if (w <= 5000 && l <= 5.50 && wi <= 2.30) {
    return { vehicle: 'flatbed_truck', surcharge: false, reason: 'fits_flatbed_truck' };
  }
  return { vehicle: 'manual_review', surcharge: false, reason: 'outside_known_capacity' };
}

export function motorcycleDimensionPolicy({ weightKg = 0, lengthCm = 0, widthCm = 0, heightCm = 0, requestedVehicle = 'motorcycle' } = {}) {
  if (requestedVehicle !== 'motorcycle') return { surchargePct: 0, applies: false };
  const overWeight = Number(weightKg || 0) > 20;
  const overDimension = Math.max(Number(lengthCm||0), Number(widthCm||0), Number(heightCm||0)) > 50;
  return { applies: overWeight || overDimension, surchargePct: overWeight || overDimension ? 20 : 0 };
}

export function calculateWaitingCharge({ arrivedAt, endedAt, role = 'customer' } = {}) {
  const cfg = role === 'courier' ? K.waiting?.courier : K.waiting?.customer;
  const start = new Date(arrivedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !cfg) {
    return { valid: false, totalMinutes: 0, billableMinutes: 0, amount: 0 };
  }
  const totalMinutes = Math.max(0, Math.ceil((end - start) / 60000));
  const billableMinutes = Math.max(0, totalMinutes - Number(cfg.freeMinutes || 0));
  return {
    valid: true,
    totalMinutes,
    billableMinutes,
    amount: roundMoney(billableMinutes * Number(cfg.perMinute || 0)),
    freeMinutes: Number(cfg.freeMinutes || 0),
    perMinute: Number(cfg.perMinute || 0)
  };
}

export function quoteFollowUp({ sentAt, confirmed = false, now = Date.now() } = {}) {
  if (confirmed) return { shouldFollowUp: false, reason: 'already_confirmed' };
  const ts = new Date(sentAt).getTime();
  if (!Number.isFinite(ts)) return { shouldFollowUp: false, reason: 'invalid_sent_at' };
  const elapsedMinutes = (Number(now) - ts) / 60000;
  return { shouldFollowUp: elapsedMinutes >= 5, elapsedMinutes, message: elapsedMinutes >= 5 ? 'Vamos confirmar a corrida?' : null };
}

export function getBusinessAvailability(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const mins = d.getHours() * 60 + d.getMinutes();
  if (day === 0) return { openForCustomerService: true, courierMustBeChecked: true, canPromiseCourier: false };
  const open = 8 * 60;
  const close = day === 6 ? 16 * 60 : 20 * 60;
  const inside = mins >= open && mins < close;
  return {
    openForCustomerService: inside,
    courierMustBeChecked: !inside,
    canPromiseCourier: inside,
    opensAt: '08:00',
    closesAt: day === 6 ? '16:00' : '20:00'
  };
}

export function customerProcedure(customerKey, flags = {}) {
  const key = String(customerKey || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const map = K.specificCustomers || {};
  if (key.includes('larcon')) return map.larcon || null;
  if (key.includes('harmonia') || key.includes('lm_melo') || key.includes('lm_melo')) return map.condominium_admins || null;
  if (key.includes('fernanda') || key.includes('dframe') || key.includes('decato')) {
    return { ...(map.fernanda_dframe_decato || {}), flags };
  }
  if (key.includes('moove')) return map.moove || null;
  return null;
}

export function serviceProofEvent({ stage, eventType, receiverName = null } = {}) {
  const s = String(stage || '').toLowerCase();
  const e = String(eventType || '').toLowerCase();
  if (s === 'pickup' && e === 'arrival_photo') return { status: 'arrived_pickup', waitingStarts: true };
  if (s === 'pickup' && e === 'pickup_photo') return { status: 'picked_up', waitingStops: true };
  if (s === 'delivery' && e === 'arrival_photo') return { status: 'arrived_delivery', waitingStarts: true };
  if (s === 'delivery' && e === 'delivered' && receiverName) return { status: 'completed', waitingStops: true, receiverName };
  return { status: null };
}

export { K as KERO_OPS_KNOWLEDGE };
