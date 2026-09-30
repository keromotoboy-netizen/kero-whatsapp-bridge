const normalize = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/\s+/g, ' ')
  .trim();

export const CURRENT_POINT_ELIGIBLE_STAFF = Object.freeze(['victoria']);

export const CLOSING_POINTS = Object.freeze({
  'sem_urgencia_desconto': 1,
  'sem_urgencia_normal': 2,
  'sem_urgencia_mais_caro': 3,
  'urgencia_desconto': 2,
  'urgencia_normal': 4,
  'urgencia_mais_caro': 6,
  'encaixe': 7,
  'avaliacao': 0.5,
  'fechamento_mensal': 2,
  'sabado_feriado_bonus': 5
});

export const ALLOCATION_POINTS = Object.freeze({
  'sem_urgencia_normal': 1,
  'sem_urgencia_mais_caro': 0.5,
  'urgencia_normal': 2,
  'urgencia_mais_caro': 1,
  'encaixe_normal': 3,
  'encaixe_pago_exclusivo': 0,
  'avaliacao': 0.5
});

export function closingRuleKey(value) {
  const t = normalize(value);
  if (!t) return null;
  if (t === 'victor' || t === 'ailla') return null;
  if (t.includes('avaliacao')) return 'avaliacao';
  if (t.includes('fechamento mensal')) return 'fechamento_mensal';
  if (t.includes('encaixe')) return 'encaixe';
  if ((t.includes('s/urg') || t.includes('sem urg')) && t.includes('desconto')) return 'sem_urgencia_desconto';
  if ((t.includes('s/urg') || t.includes('sem urg')) && (t.includes('+ caro') || t.includes('mais caro') || t.includes('e + caro'))) return 'sem_urgencia_mais_caro';
  if (t.includes('s/urg') || t.includes('sem urg')) return 'sem_urgencia_normal';
  if ((t.includes('urgenc') || t.includes('urgent')) && t.includes('desconto')) return 'urgencia_desconto';
  if ((t.includes('urgenc') || t.includes('urgent')) && (t.includes('+ caro') || t.includes('mais caro') || t.includes('e + caro'))) return 'urgencia_mais_caro';
  if ((t.includes('urgenc') || t.includes('urgent'))) return 'urgencia_normal';
  return null;
}

export function allocationRuleKey(value) {
  const t = normalize(value);
  if (!t) return null;
  if (t === 'victor' || t === 'ailla') return null;
  if (t.includes('avaliacao')) return 'avaliacao';
  if (t.includes('encaixe') && (t.includes('exclusivo') || t.includes('mais caro') || t.includes('+ caro'))) return 'encaixe_pago_exclusivo';
  if (t.includes('encaixe')) return 'encaixe_normal';
  if ((t.includes('s/urg') || t.includes('sem urg')) && (t.includes('+ caro') || t.includes('mais caro'))) return 'sem_urgencia_mais_caro';
  if (t.includes('s/urg') || t.includes('sem urg')) return 'sem_urgencia_normal';
  if ((t.includes('urgenc') || t.includes('urgent')) && (t.includes('+ caro') || t.includes('mais caro'))) return 'urgencia_mais_caro';
  if ((t.includes('urgenc') || t.includes('urgent'))) return 'urgencia_normal';
  return null;
}

export function calculateVictoriaPoints({
  closer = null,
  allocator = null,
  closingLabel = '',
  allocationLabel = '',
  isSaturdayOrHoliday = false
} = {}) {
  let points = 0;
  const details = [];

  if (normalize(closer) === 'victoria') {
    const key = closingRuleKey(closingLabel);
    if (key && CLOSING_POINTS[key] != null) {
      points += CLOSING_POINTS[key];
      details.push({ type: 'closing', key, points: CLOSING_POINTS[key] });
    }
  }

  if (normalize(allocator) === 'victoria') {
    const key = allocationRuleKey(allocationLabel);
    if (key && ALLOCATION_POINTS[key] != null) {
      points += ALLOCATION_POINTS[key];
      details.push({ type: 'allocation', key, points: ALLOCATION_POINTS[key] });
    }
  }

  if (isSaturdayOrHoliday && (normalize(closer) === 'victoria' || normalize(allocator) === 'victoria')) {
    points = points * 2 + CLOSING_POINTS.sabado_feriado_bonus;
    details.push({ type: 'bonus', key: 'sabado_feriado', points: CLOSING_POINTS.sabado_feriado_bonus, multiplier: 2 });
  }

  return { staff: 'victoria', points, details };
}
