import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeLimiter, ipBucket } from '../lib/handlers.js';
import { validateDraw } from '../lib/core.js';

const people = (n) => Array.from({ length: n }, (_, i) => ({ name: `Pessoa ${i}`, email: `p${i}@exemplo.com`, tip: '' }));

test('limitador: banco fora do ar cai para o freio em memória (não libera geral)', async () => {
  const broken = { pipe: async () => { throw new Error('cota estourada'); }, cmd: async () => { throw new Error('cota'); } };
  const limiter = storeLimiter(broken);
  const res = [];
  for (let i = 0; i < 7; i++) res.push((await limiter.attempt('3.3.3.3')).allowed);
  assert.deepEqual(res, [true, true, true, true, true, false, false]);
});

test('IPv6 conta por /64; IPv4 mapeado vira IPv4', () => {
  assert.equal(ipBucket('2804:14c:65a1:4000:1111:2222:3333:4444'), ipBucket('2804:14c:65a1:4000:aaaa::1'));
  assert.notEqual(ipBucket('2804:14c:65a1:4000::1'), ipBucket('2804:14c:65a1:4001::1'));
  assert.equal(ipBucket('::ffff:200.1.2.3'), '200.1.2.3');
});

test('textos que vão no e-mail não aceitam link', () => {
  const bad = [
    { event: { name: 'Ganhe prêmio em http://golpe.xyz' } },
    { event: { msg: 'acesse www.golpe.com' } },
    { event: { place: 'banco-seguro.com.br/login' } },
    { event: { msg: 'responda para golpista@mail.ru' } },
  ];
  for (const b of bad) assert.equal(validateDraw({ participants: people(4), ...b }).ok, false, JSON.stringify(b));
  const p = people(4); p[0].name = 'Clique em bit.ly/x';
  assert.equal(validateDraw({ participants: p }).ok, false);
});

test('textos normais continuam passando', () => {
  const ok = validateDraw({ participants: people(4), event: { name: 'Amigo Secreto da Firma 2026', value: '100,00', place: 'Casa da Ana, Rua 7 nº 120', msg: 'Nada de meia. Capricha! Valor até R$ 100.' } });
  assert.equal(ok.ok, true, ok.error);
  const p = people(4); p[0].tip = 'Lista na amazon.com.br/wishlist';
  assert.equal(validateDraw({ participants: p }).ok, true, 'dica só aparece no papelzinho, não no e-mail');
});
