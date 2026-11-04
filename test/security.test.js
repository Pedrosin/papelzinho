import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, createDrawHandler } from '../lib/handlers.js';
import { validateDraw } from '../lib/core.js';

const ENV = { GMAIL_USER: 'org@gmail.com', GMAIL_APP_PASSWORD: 'x', ORGANIZER_PASSWORD: 'senha-certa-123', TOKEN_SECRET: 'k' };
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

test('limitador: rajada vinda de muitos IPs trava geral', async () => {
  const limiter = createLimiter({ now: () => 0 });
  for (let i = 0; i < 30; i++) limiter.fail('10.0.0.' + i);
  assert.equal(limiter.blocked('9.9.9.9'), true);
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
