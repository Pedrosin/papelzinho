import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createDrawHandler, storeLimiter, ipBucket } from '../lib/handlers.js';
import { memoryStore } from '../lib/store.js';
import { validateDraw } from '../lib/core.js';

const ENV = { GMAIL_USER: 'org@gmail.com', GMAIL_APP_PASSWORD: 'x', ORGANIZER_PASSWORD: 'senha-certa-123', TOKEN_SECRET: 'k' };
const PW = 'senha-certa-123';
const people = (n) => Array.from({ length: n }, (_, i) => ({ name: `Pessoa ${i}`, email: `p${i}@exemplo.com`, tip: '' }));

function call(handler, body, ip = '1.1.1.1') {
  return new Promise((resolve) => {
    const res = { statusCode: 0, setHeader() {}, end(s) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } };
    handler({ method: 'POST', body, headers: { host: 'h', 'x-real-ip': ip } }, res);
  });
}

test('limitador: 5 erros travam o IP, inclusive para a senha certa', async () => {
  let t = 0;
  const limiter = createLimiter({ now: () => t });
  const transport = () => ({ verify: async () => {}, sendMail: async () => {}, close() {} });
  const h = createDrawHandler({ env: ENV, makeTransport: transport, wrongPasswordDelay: 0, limiter });
  for (let i = 0; i < 5; i++) assert.equal((await call(h, { password: 'chute' + i })).status, 401);
  assert.equal((await call(h, { password: 'senha-certa-123', participants: people(4) })).status, 429);
  // outro IP segue normal
  assert.equal((await call(h, { password: 'senha-certa-123', participants: people(4) }, '2.2.2.2')).status, 200);
  // passou a janela: destrava
  t += 15 * 60 * 1000 + 1;
  assert.equal((await call(h, { password: 'senha-certa-123', participants: people(4) })).status, 200);
});

test('limitador: rajada em paralelo não passa (tentativa reservada antes de comparar)', async () => {
  const store = memoryStore();
  const transport = () => ({ verify: async () => {}, sendMail: async () => {}, close() {} });
  const h = createDrawHandler({ env: ENV, makeTransport: transport, wrongPasswordDelay: 0, limiter: storeLimiter(store) });
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => call(h, { password: 'chute' + i })));
  assert.equal(rs.filter((r) => r.status === 401).length, 5);
  assert.equal(rs.filter((r) => r.status === 429).length, 45);
});

test('limitador: senha certa devolve a tentativa e não há trava geral', async () => {
  const store = memoryStore();
  const transport = () => ({ verify: async () => {}, sendMail: async () => {}, close() {} });
  const h = createDrawHandler({ env: ENV, makeTransport: transport, wrongPasswordDelay: 0, limiter: storeLimiter(store) });
  for (let i = 0; i < 20; i++) assert.equal((await call(h, { password: PW, participants: people(4) })).status, 200);
  // 40 IPs diferentes errando não trancam o organizador
  for (let i = 0; i < 40; i++) await call(h, { password: 'x' }, '10.0.0.' + i);
  assert.equal((await call(h, { password: PW, participants: people(4) }, '8.8.8.8')).status, 200);
});

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
