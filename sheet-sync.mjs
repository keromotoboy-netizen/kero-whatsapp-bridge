const moneyBRL = value => {
  const n=Number(value||0);
  return n.toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
};
const dateBR = value => {
  const d=new Date(String(value||'')+'T12:00:00');
  return Number.isNaN(d.getTime())?'':d.toLocaleDateString('pt-BR');
};
export function serviceToSheetRow(service={}) {
  const payment = service.billingType==='invoiced'
    ? 'FAT MENSAL'
    : service.clientPaymentStatus==='paid' ? 'PAGO' : '';
  const courierPaid = service.courierPaymentStatus==='paid' ? 'PAGO' : '';
  const extras = Array.isArray(service.extras)
    ? service.extras.map(x=>typeof x==='string'?x:(x?.description||x?.type||'')).filter(Boolean).join(' | ')
    : '';
  return [
    dateBR(service.serviceDate),
    service.clientName||'',
    moneyBRL(service.clientValue),
    payment,
    '',
    service.courierName||'',
    moneyBRL(service.courierPayout),
    courierPaid,
    service.status||'',
    service.invoiceRequired?'Sim':'nao',
    service.closer==='victoria' ? (service.closingLabel||'') : (service.closer||''),
    service.allocator==='victoria' ? (service.allocationLabel||'') : (service.allocator||''),
    service.evaluation||'',
    extras
  ];
}
export function reconcileBilledMonth({crmServices=[],sheetTotal=0}={}) {
  const crmTotal=crmServices
    .filter(x=>x.billingType==='invoiced')
    .reduce((sum,x)=>sum+Number(x.clientValue||0),0);
  const expected=Math.round(crmTotal*100)/100;
  const actual=Math.round(Number(sheetTotal||0)*100)/100;
  return {ok:expected===actual,crmTotal:expected,sheetTotal:actual,difference:Math.round((expected-actual)*100)/100};
}
