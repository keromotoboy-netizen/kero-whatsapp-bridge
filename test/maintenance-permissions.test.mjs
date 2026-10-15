import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maintenanceMutationAllowed,
  scheduledMaintenanceAllowed,
} from '../maintenance-permissions.mjs';

test('destructive maintenance is disabled by default', () => {
  assert.equal(maintenanceMutationAllowed(), false);
  assert.equal(scheduledMaintenanceAllowed(), false);
  assert.equal(maintenanceMutationAllowed({ CRM_ALLOW_DESTRUCTIVE_MAINTENANCE: 'true' }), false);
});

test('manual destructive maintenance requires exact opt-in', () => {
  assert.equal(maintenanceMutationAllowed({ CRM_ALLOW_DESTRUCTIVE_MAINTENANCE: '1' }), true);
  assert.equal(maintenanceMutationAllowed({ CRM_ALLOW_DESTRUCTIVE_MAINTENANCE: '0' }), false);
});

test('nightly maintenance additionally requires explicit scheduler opt-in', () => {
  assert.equal(scheduledMaintenanceAllowed({ CRM_ALLOW_DESTRUCTIVE_MAINTENANCE: '1' }), false);
  assert.equal(scheduledMaintenanceAllowed({
    CRM_ALLOW_DESTRUCTIVE_MAINTENANCE: '1',
    CRM_MAINTENANCE_SCHEDULED: '1',
  }), true);
  assert.equal(scheduledMaintenanceAllowed({
    CRM_ALLOW_DESTRUCTIVE_MAINTENANCE: '0',
    CRM_MAINTENANCE_SCHEDULED: '1',
  }), false);
});
