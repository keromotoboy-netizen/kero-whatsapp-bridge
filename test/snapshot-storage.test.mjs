import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSnapshot, writeSnapshot } from '../snapshot-storage.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'kero-snapshot-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'crm-state.json');}
test('leitura de JSON legado preserva conteudo',t=>{const p=fixture(t);fs.writeFileSync(p,'{"version":1,"value":"original"}');assert.equal(readSnapshot(p).value,'original');});
test('gzip novo preserva dados e arquivo legado byte a byte',t=>{const p=fixture(t);const before='{"version":1,"value":"original"}';fs.writeFileSync(p,before);const state={version:1,value:'preservado'.repeat(50000)};writeSnapshot(p,state);assert.deepEqual(readSnapshot(p),state);assert.equal(fs.readFileSync(p,'utf8'),before);assert.ok(fs.statSync(p+'.gz').size<10000);});
test('temporario incompleto pode ser reusado sem tocar legado',t=>{const p=fixture(t);fs.writeFileSync(p,'{"ok":true}');fs.writeFileSync(p+'.tmp','partial');writeSnapshot(p,{ok:true,newData:1});assert.equal(readSnapshot(p).newData,1);assert.equal(fs.readFileSync(p,'utf8'),'{"ok":true}');});
test('falha ENOSPC mantem ultimo snapshot e legado',t=>{const p=fixture(t);fs.writeFileSync(p,'{"legacy":true}');writeSnapshot(p,{value:1});const io={...fs,writeFileSync(){throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}};assert.throws(()=>writeSnapshot(p,{value:2},io),{code:'ENOSPC'});assert.equal(readSnapshot(p).value,1);assert.equal(fs.readFileSync(p,'utf8'),'{"legacy":true}');});
test('gzip corrompido falha sem voltar silenciosamente a dados antigos',t=>{const p=fixture(t);fs.writeFileSync(p,'{"legacy":true}');fs.writeFileSync(p+'.gz','broken');assert.throws(()=>readSnapshot(p));});
