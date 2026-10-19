import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectAuthDirectory } from '../auth-directory.mjs';
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'kero-auth-test-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }
test('logout confirmado permite QR novo sem apagar credenciais ou CRM',t=>{
 const root=fixture(t); fs.writeFileSync(path.join(root,'creds.json'),JSON.stringify({registered:true})); fs.writeFileSync(path.join(root,'crm-state.json'),'preserved');
 const dir=selectAuthDirectory(root,{freshPairing:true,loggedOut:true});
 assert.notEqual(dir,root); assert.equal(fs.readFileSync(path.join(root,'creds.json'),'utf8'),'{"registered":true}'); assert.equal(fs.readFileSync(path.join(root,'crm-state.json'),'utf8'),'preserved');
 assert.equal(selectAuthDirectory(root),dir);
});
test('sessao registrada sem logout continua protegida',t=>{const root=fixture(t);fs.writeFileSync(path.join(root,'creds.json'),'{"registered":true}');assert.throws(()=>selectAuthDirectory(root,{freshPairing:true}),/existing_session_data_protected/);});
test('QR pendente pode ser renovado sem apagar arquivos',t=>{const root=fixture(t);fs.writeFileSync(path.join(root,'creds.json'),'{"registered":false}');assert.equal(selectAuthDirectory(root,{freshPairing:true}),root);assert.ok(fs.existsSync(path.join(root,'creds.json')));});
test('ponteiro fora do diretorio falha fechado',t=>{const root=fixture(t);fs.writeFileSync(path.join(root,'active-auth.json'),JSON.stringify({directory:'../../outside'}));assert.throws(()=>selectAuthDirectory(root),/invalid_auth_pointer/);});
test('sessao nova registrada continua protegida apos reinicio',t=>{const root=fixture(t);const next=selectAuthDirectory(root,{freshPairing:true,loggedOut:true});fs.writeFileSync(path.join(next,'creds.json'),'{"registered":true}');assert.equal(selectAuthDirectory(root),next);assert.throws(()=>selectAuthDirectory(root,{freshPairing:true}),/existing_session_data_protected/);});
test('QR pendente retoma a mesma pasta apos reinicio',t=>{const root=fixture(t);const next=selectAuthDirectory(root,{freshPairing:true,loggedOut:true});fs.writeFileSync(path.join(next,'creds.json'),'{"registered":false}');assert.equal(selectAuthDirectory(root,{freshPairing:true}),next);});
