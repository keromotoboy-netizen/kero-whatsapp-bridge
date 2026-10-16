import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const manual = source.match(/if \((!dryRun && process\.env\.CRM_ALLOW_DESTRUCTIVE_MAINTENANCE !== '1')\) throw new Error\('destructive_maintenance_disabled'\)/);
const nightly = source.match(/if\((process\.env\.CRM_ALLOW_DESTRUCTIVE_MAINTENANCE === '1' && process\.env\.CRM_NIGHTLY_MAINTENANCE === '1' && parts\.hour==='00' && Number\(parts\.minute\)<10 && maintenanceState\.lastDate!==date && status==='open')\)\{/);

test('source has exactly one explicit guard before any mutation', () => {
  assert.ok(manual, 'manual mutating maintenance must be guarded');
  const functionStart = source.indexOf('async function runKeroMaintenance');
  assert.ok(functionStart >= 0);
  assert.ok(source.indexOf('destructive_maintenance_disabled', functionStart) < source.indexOf('ensureClientGroupLabel(dryRun)', functionStart));
});
test('manual maintenance is off by default; dry run remains available', () => {
  assert.ok(manual);
  const enabled = new Function('dryRun','process','return !(' + manual[1] + ')');
  assert.equal(enabled(false, { env: {} }), false);
  assert.equal(enabled(false, { env: { CRM_ALLOW_DESTRUCTIVE_MAINTENANCE:'true' }}), false);
  assert.equal(enabled(false, { env: { CRM_ALLOW_DESTRUCTIVE_MAINTENANCE:'1' }}), true);
  assert.equal(enabled(true, { env: {} }), true);
});
test('nightly destructive maintenance requires two exact opt-in flags', () => {
  assert.ok(nightly, 'nightly scheduler must have explicit flags');
  const decision = new Function('process','parts','maintenanceState','date','status', 'return (' + nightly[1] + ')');
  const parts={hour:'00',minute:'01'}, state={lastDate:'2026-10-15'}, date='2026-10-16';
  const run=env=>decision({env},parts,state,date,'open');
  assert.equal(run({}), false);
  assert.equal(run({CRM_ALLOW_DESTRUCTIVE_MAINTENANCE:'1'}), false);
  assert.equal(run({CRM_NIGHTLY_MAINTENANCE:'1'}), false);
  assert.equal(run({CRM_ALLOW_DESTRUCTIVE_MAINTENANCE:'1',CRM_NIGHTLY_MAINTENANCE:'true'}), false);
  assert.equal(run({CRM_ALLOW_DESTRUCTIVE_MAINTENANCE:'1',CRM_NIGHTLY_MAINTENANCE:'1'}), true);
});
test('nightly run additionally requires expected time, open socket and no prior completion',()=>{
  assert.ok(nightly);
  const d = new Function('process','parts','maintenanceState','date','status','return ('+nightly[1]+')');
  const env={CRM_ALLOW_DESTRUCTIVE_MAINTENANCE:'1',CRM_NIGHTLY_MAINTENANCE:'1'};
  assert.equal(d({env},{hour:'08',minute:'00'},{lastDate:'2026-10-15'},'2026-10-16','open'),false);
  assert.equal(d({env},{hour:'00',minute:'01'},{lastDate:'2026-10-16'},'2026-10-16','open'),false);
  assert.equal(d({env},{hour:'00',minute:'01'},{lastDate:'2026-10-15'},'2026-10-16','close'),false);
});
