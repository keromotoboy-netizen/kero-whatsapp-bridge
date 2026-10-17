import test from 'node:test';
import assert from 'node:assert/strict';
import { assertFreshPairingSafe } from '../pairing-safety.mjs';

test('fresh pairing is allowed only with an empty storage directory', () => {
  assert.doesNotThrow(() => assertFreshPairingSafe([]));
});

test('stored WhatsApp credentials prevent a new QR/phone pairing', () => {
  assert.throws(
    () => assertFreshPairingSafe(['creds.json']),
    /existing_session_data_protected/
  );
});

test('CRM data is protected even if credentials are missing', () => {
  assert.throws(
    () => assertFreshPairingSafe(['crm-state.json']),
    /existing_session_data_protected/
  );
});

test('unknown/non-array directory state fails closed', () => {
  assert.throws(
    () => assertFreshPairingSafe(undefined),
    /existing_session_data_protected/
  );
});
