const normalize = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

const money = value => {
  const m = normalize(value).match(/(?:min(?:imo)?\s*(?:de)?\s*)?(?:r\$\s*)?(\d+(?:[.,]\d+)?)/);
  return m ? Number(m[1].replace(',', '.')) : null;
};

export function inferGroupPolicy({ name = '', description = '', labels = [], manual = null } = {}) {
  if (manual?.type) return { ...manual, source: 'manual', confidence: 1 };

  const n = normalize(name);
  const d = normalize(description);
  const text = n + ' ' + d;
  const ls = labels.map(normalize);

  const result = {
    type: 'unknown',
    vehicleTypes: [],
    serviceModes: [],
    minPayment: null,
    perKm: null,
    minKm: null,
    maxKm: null,
    dailyReset: false,
    paymentQueue: false,
    monthlyBilledClients: false,
    rulesText: description || '',
    source: 'inferred',
    confidence: 0.45
  };

  if (n.includes('clientes faturados') || ls.some(x => x.includes('faturad'))) {
    result.type = 'clients';
    result.monthlyBilledClients = true;
    result.confidence = 0.98;
    return result;
  }

  if (n.includes('cliente do dia')) {
    result.type = 'couriers';
    result.dailyReset = true;
    result.confidence = 0.95;
  }

  if (n.includes('pagamento de motoboy') || n.includes('pagamento motoboy') || n.includes('pagamento motorista')) {
    result.type = 'couriers';
    result.paymentQueue = true;
    result.dailyReset = true;
    result.confidence = 0.99;
  }

  const courierSignals = [
    /grupo.*1[,.]50.*km/,
    /grupo.*2[,.]00.*km/,
    /min(?:imo)?\s*(?:de)?\s*\d+/,
    /encaixe.*70\s*km/,
    /carros?\s*&?\s*utilitarios?/,
    /r1\s*utilitarios?/
  ];

  if (courierSignals.some(re => re.test(text))) {
    result.type = 'couriers';
    result.confidence = Math.max(result.confidence, 0.92);
  }

  if (/1[,.]50\s*(?:o\s*)?km|1[,.]50\s*\/\s*km/.test(text)) result.perKm = 1.5;
  if (/2[,.]00\s*(?:o\s*)?km|2[,.]00\s*\/\s*km/.test(text)) result.perKm = 2;

  const minMatch = text.match(/min(?:imo)?\s*(?:de)?\s*(?:r\$\s*)?(\d+(?:[.,]\d+)?)/);
  if (minMatch) result.minPayment = Number(minMatch[1].replace(',', '.'));

  const upToKm = text.match(/ate\s*(\d+(?:[.,]\d+)?)\s*km/);
  if (upToKm) result.maxKm = Number(upToKm[1].replace(',', '.'));

  const aboveKm = text.match(/(?:acima|maior|mais)\s*(?:de)?\s*(\d+(?:[.,]\d+)?)\s*km/);
  if (aboveKm) result.minKm = Number(aboveKm[1].replace(',', '.'));

  if (text.includes('encaixe') || text.includes('fracionado')) {
    result.serviceModes.push('split');
  }

  if (text.includes('carro')) result.vehicleTypes.push('car');
  if (text.includes('utilitario') || text.includes('fiorino') || text.includes('van')) result.vehicleTypes.push('utility');
  if (text.includes('caminhao')) result.vehicleTypes.push('truck');

  if (!result.vehicleTypes.length && result.type === 'couriers') {
    result.vehicleTypes.push('motorcycle');
  }

  return result;
}

export function canPostServiceToGroup(policy, service, fallbackUtilityPolicy = null) {
  if (!policy || policy.type !== 'couriers') return { allowed: false, reason: 'not_courier_group' };

  const km = Number(service?.km || 0);
  const payout = Number(service?.courierPayout || 0);
  const mode = service?.mode || 'non_urgent';
  const vehicle = service?.vehicle || 'motorcycle';

  if (policy.minKm != null && km < policy.minKm) return { allowed: false, reason: 'below_min_km' };
  if (policy.maxKm != null && km > policy.maxKm) return { allowed: false, reason: 'above_max_km' };
  if (policy.minPayment != null && payout < policy.minPayment) return { allowed: false, reason: 'below_min_payment' };
  if (policy.perKm != null && km > 0 && payout / km < policy.perKm) return { allowed: false, reason: 'below_group_per_km' };
  if (policy.serviceModes.length && !policy.serviceModes.includes(mode)) return { allowed: false, reason: 'mode_not_allowed' };
  if (policy.vehicleTypes.length && !policy.vehicleTypes.includes(vehicle)) return { allowed: false, reason: 'vehicle_not_allowed' };

  if ((vehicle === 'car' || vehicle === 'utility' || vehicle === 'van' || vehicle === 'truck') &&
      policy.minPayment == null && policy.perKm == null && fallbackUtilityPolicy) {
    return canPostServiceToGroup(fallbackUtilityPolicy, service, null);
  }

  return { allowed: true, reason: 'rules_satisfied' };
}
