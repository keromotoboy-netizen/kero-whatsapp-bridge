import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const src=readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
test('midnight scope excludes permanent client label assignment',()=>{
  const start=src.indexOf('async function runKeroMaintenance(');
  const end=src.indexOf("app.get('/crm/maintenance/status'",start);
  assert.ok(start>=0&&end>start);
  const body=src.slice(start,end);
  assert.ok(body.includes("not_part_of_midnight_policy"));
  assert.equal(body.includes('await ensureClientGroupLabel('),false);
  assert.ok(body.includes('await removeTemporaryLabels(dryRun)'));
  assert.ok(body.includes('await clearArchivedGroups(dryRun)'));
});
