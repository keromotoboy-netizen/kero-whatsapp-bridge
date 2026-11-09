// KERO 05/11/2026: rotas restauradas da ponte de 31/10 e protecoes da pausa do CEO.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const rota = (m, r) => new RegExp(`app\\.${m}\\('${r.replace(/[/]/g, '\\/')}', secure`).test(src);

test('rotas de apagar, favoritar, contato, Pix, midia e etiquetas existem uma vez', () => {
  for (const [m, r] of [['post', '/crm/delete'], ['post', '/crm/star'], ['get', '/crm/contact'], ['post', '/crm/save-contact'], ['post', '/crm/send-pix'], ['get', '/crm/media/raw'], ['post', '/crm/labels/chat']]) {
    assert.ok(rota(m, r), `${m} ${r}`);
    assert.equal(src.split(`app.${m}('${r}'`).length - 1, 1, `${r} duplicada`);
  }
});

test('cartao Pix (vai para cliente) fica bloqueado pela pausa sem KERO_PIX_LIBERADO=1', () => {
  const i = src.indexOf("app.post('/crm/send-pix'");
  assert.match(src.slice(i, i + 400), /KERO_PIX_LIBERADO !== '1'\) return res\.status\(423\)/);
});

test('pausa do CEO para foto e reacao continua igual', () => {
  assert.match(src, /export function ceoPauseDecision\(action, body = \{\}\)/);
  assert.match(src, /const ceoPause = ceoPauseDecision\('send-media', req\.body\);/);
  assert.match(src, /const ceoPause = ceoPauseDecision\('react', req\.body\);/);
});

test('copia das midias fica FORA do volume da sessao (DATA_DIR + "-midia")', () => {
  assert.match(src, /const MIDIA_DIR = DATA_DIR\.replace\(\/\[\\\/\]\+\$\/, ''\) \+ '-midia';/);
  assert.ok(!/MIDIA_DIR = DATA_DIR \+ '\//.test(src));
});

test('etiquetas protegidas continuam protegidas', () => {
  assert.match(src, /LABEL_PROTEGIDA\.test\(nome\)/);
});
