import assert from 'node:assert/strict';
import { inferGroupPolicy, canPostServiceToGroup } from './group-policy.mjs';
import { calculateVictoriaPoints } from './victoria-points.mjs';

let p = inferGroupPolicy({ name:'Grupo 2,00 o km', description:'Mín de 20$ até 6 km. Serviços somente pagando 2,00 o km.' });
assert.equal(p.type,'couriers');
assert.equal(p.perKm,2);
assert.equal(p.minPayment,20);
assert.equal(p.maxKm,6);

p = inferGroupPolicy({ name:'Encaixe acima de 70km', description:'Somente encaixe/fracionado acima de 70 km' });
assert.equal(p.type,'couriers');
assert.equal(p.minKm,70);
assert.ok(p.serviceModes.includes('split'));

p = inferGroupPolicy({ name:'Clientes Faturados', labels:['Clientes Faturados'] });
assert.equal(p.type,'clients');
assert.equal(p.monthlyBilledClients,true);

const g = inferGroupPolicy({ name:'Carros & Utilitários', description:'Pode jogar serviços de carros e utilitários' });
assert.equal(g.type,'couriers');
assert.ok(g.vehicleTypes.includes('car'));
assert.ok(g.vehicleTypes.includes('utility'));

assert.deepEqual(
  canPostServiceToGroup(
    inferGroupPolicy({ name:'Min de 20 ate 6 km', description:'Minimo de 20 até 6 km' }),
    { km:5, courierPayout:20, mode:'non_urgent', vehicle:'motorcycle' }
  ).allowed,
  true
);

assert.equal(calculateVictoriaPoints({
  closer:'Victoria',
  allocator:'Victoria',
  closingLabel:'S/Urgencia Normal',
  allocationLabel:'Alocação S/Urgência'
}).points,3);

assert.equal(calculateVictoriaPoints({
  closer:'Victor',
  allocator:'Victoria',
  closingLabel:'Urgente Normal',
  allocationLabel:'Alocação Urgente'
}).points,2);

assert.equal(calculateVictoriaPoints({
  closer:'Victoria',
  allocator:'Victor',
  closingLabel:'Fechar Encaixe',
  allocationLabel:'Victor'
}).points,7);

assert.equal(calculateVictoriaPoints({
  closer:'Ailla',
  allocator:'Ailla',
  closingLabel:'Urgente Normal',
  allocationLabel:'Alocação Urgente'
}).points,0);

console.log('group policy + victoria points tests passed');
