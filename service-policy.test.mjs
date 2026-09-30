import assert from 'node:assert/strict';
import { recommendVehicle, motorcycleDimensionPolicy, calculateWaitingCharge, quoteFollowUp, getBusinessAvailability, serviceProofEvent } from './service-policy.mjs';

assert.equal(recommendVehicle({weightKg:10,lengthCm:40,widthCm:30,heightCm:20}).vehicle,'motorcycle');
assert.equal(recommendVehicle({weightKg:80,lengthCm:100,widthCm:70,heightCm:50}).vehicle,'car');
assert.equal(recommendVehicle({weightKg:500,lengthCm:170,widthCm:100,heightCm:120}).vehicle,'fiorino');
assert.equal(motorcycleDimensionPolicy({weightKg:21,lengthCm:40,widthCm:30,heightCm:20}).surchargePct,20);
assert.equal(motorcycleDimensionPolicy({weightKg:25,lengthCm:60,requestedVehicle:'car'}).surchargePct,0);

const wait = calculateWaitingCharge({arrivedAt:'2026-09-30T10:00:00-03:00',endedAt:'2026-09-30T10:21:00-03:00',role:'customer'});
assert.equal(wait.billableMinutes,6);
assert.equal(wait.amount,4.8);

assert.equal(quoteFollowUp({sentAt:Date.now()-6*60000}).shouldFollowUp,true);
assert.equal(getBusinessAvailability('2026-10-03T15:30:00-03:00').canPromiseCourier,true);
assert.equal(getBusinessAvailability('2026-10-03T17:00:00-03:00').canPromiseCourier,false);
assert.equal(serviceProofEvent({stage:'pickup',eventType:'arrival_photo'}).status,'arrived_pickup');
assert.equal(serviceProofEvent({stage:'delivery',eventType:'delivered',receiverName:'João'}).status,'completed');
console.log('service policy tests passed');
