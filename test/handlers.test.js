import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawHandler, createRevealHandler, createPurgeHandler } from '../lib/handlers.js';

const ENV = { GMAIL_USER: 'organizador@gmail.com', GMAIL_APP_PASSWORD: 'abcd efgh ijkl mnop', ORGANIZER_PASSWORD: 'segredo-do-organizador', TOKEN_SECRET: 'chave-dos-links' };

function fakeTransport({ failVerify = false, failTo = [], flaky = {} } = {}) {
  const outbox = [];
  const tries = {};
  return {
    outbox, tries,
    make: () => ({
      verify: async () => { if (failVerify) throw new Error('535 auth'); },
      sendMail: async (m) => {
        const a = m.to.address;
        tries[a] = (tries[a] || 0) + 1;
        if (failTo.includes(a)) throw Object.assign(new Error('550 mailbox unavailable'), { responseCode: 550, response: '550 mailbox unavailable' });
        if (tries[a] <= (flaky[a] || 0)) throw Object.assign(new Error('421 try again later'), { responseCode: 421 });
        outbox.push(m);
      },
      close() {},
    }),
  };
}

function call(handler, body, method = 'POST') {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(s) { resolve({ status: this.statusCode, body: JSON.parse(s), headers: this.headers }); },
    };
    handler({ method, body, headers: { host: 'papelzinho.vercel.app', 'x-forwarded-proto': 'https' } }, res);
  });
}

const group = [
  { name: 'Ana Souza', email: 'ana@exemplo.com', tip: 'Planta' },
  { name: 'Bruno Lima', email: 'bruno@exemplo.com', tip: '' },
  { name: 'Carla Dias', email: 'carla@exemplo.com', tip: 'Café especial' },
  { name: 'Diego Rocha', email: 'diego@exemplo.com', tip: 'Livro' },
  { name: 'Elisa Prado', email: 'elisa@exemplo.com', tip: '' },
];
const body = (extra = {}) => ({ password: 'segredo-do-organizador', participants: group, exclusions: [[0, 1]], event: { name: 'Amigo da Firma', value: '100,00', date: '2026-12-19', time: '19:30', place: 'Casa da Ana', msg: 'Nada de meia' }, ...extra });

test('senha errada: 401 e nenhum e-mail', async () => {
  const t = fakeTransport();
  const h = createDrawHandler({ env: ENV, makeTransport: t.make, wrongPasswordDelay: 0 });
  const r = await call(h, body({ password: 'chute' }));
  assert.equal(r.status, 401);
  assert.equal(t.outbox.length, 0);
});

test('servidor sem configuração: diz o que falta', async () => {
  const h = createDrawHandler({ env: {}, makeTransport: fakeTransport().make });
  const r = await call(h, body());
  assert.equal(r.status, 500);
  assert.match(r.body.error, /GMAIL_USER, GMAIL_APP_PASSWORD, ORGANIZER_PASSWORD, TOKEN_SECRET/);
  assert.equal(r.body.stage, 'before');
});

test('GET é recusado', async () => {
  const h = createDrawHandler({ env: ENV, makeTransport: fakeTransport().make });
  assert.equal((await call(h, null, 'GET')).status, 405);
});

test('Gmail recusa login: 502 e nenhum e-mail', async () => {
  const t = fakeTransport({ failVerify: true });
  const h = createDrawHandler({ env: ENV, makeTransport: t.make, retryDelays: [1, 1] });
  const r = await call(h, body());
  assert.equal(r.status, 502);
  assert.equal(t.outbox.length, 0);
});

test('regras impossíveis: 422 e nenhum e-mail', async () => {
  const t = fakeTransport();
  const h = createDrawHandler({ env: ENV, makeTransport: t.make, retryDelays: [1, 1] });
  const four = group.slice(0, 4);
  const r = await call(h, body({ participants: four, exclusions: [[0, 1], [0, 2], [0, 3]] }));
  assert.equal(r.status, 422);
  assert.equal(r.body.stage, 'before');
  const r2 = await call(h, body({ participants: four, exclusions: [[0, 1], [0, 2]] }));
  assert.equal(r2.status, 422);
  assert.match(r2.body.error, /adivinhar quem .*Ana/);
  assert.equal(t.outbox.length, 0);
});

test('ponta a ponta: e-mails, links e sigilo', async () => {
  for (let run = 0; run < 50; run++) {
    const t = fakeTransport();
    const draw = createDrawHandler({ env: ENV, makeTransport: t.make, retryDelays: [1, 1] });
    const reveal = createRevealHandler({ env: ENV });
    const r = await call(draw, body());
    assert.equal(r.status, 200);
    assert.equal(r.body.sent.length, group.length);
    assert.ok(r.body.sent.every((s) => s.ok));

    // sigilo: a resposta ao organizador não tem token nem par
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes('/r#'));
    assert.deepEqual(Object.keys(r.body).sort(), ['copies', 'groupDeleted', 'groupLeftovers', 'sent', 'stamp']);
    assert.deepEqual(Object.keys(r.body.sent[0]).sort(), ['email', 'name', 'ok']);
    assert.equal(r.body.copies.length, group.length);
    assert.deepEqual(new Set(r.body.copies), new Set(t.outbox.map((m) => m.messageId)));

    assert.equal(t.outbox.length, group.length);
    const receivers = new Set();
    for (const m of t.outbox) {
      const giver = group.find((g) => g.email === m.to.address);
      assert.ok(giver);
      const link = m.html.match(/href="(https:\/\/papelzinho\.vercel\.app\/r#[A-Za-z0-9_-]+)"/)[1];
      assert.ok(m.text.includes(link));
      // o nome sorteado não vem escrito no e-mail
      const token = link.split('#')[1];
      const rv = await call(reveal, { t: token });
      assert.equal(rv.status, 200);
      assert.equal(rv.body.giver, giver.name);
      assert.notEqual(rv.body.receiver, giver.name);
      for (const other of group) if (other.name === rv.body.receiver) assert.ok(!m.html.includes(other.name) && !m.text.includes(other.name));
      const receiver = group.find((g) => g.name === rv.body.receiver);
      assert.equal(rv.body.tip, receiver.tip);
      assert.equal(rv.body.event.when, 'sáb, 19/12 · 19:30');
      assert.equal(rv.body.event.value, 'R$ 100,00');
      receivers.add(rv.body.receiver);
      // separação Ana ⇄ Bruno respeitada
      if (giver.name === 'Ana Souza') assert.notEqual(rv.body.receiver, 'Bruno Lima');
      if (giver.name === 'Bruno Lima') assert.notEqual(rv.body.receiver, 'Ana Souza');
      assert.equal(m.from.address, ENV.GMAIL_USER);
      assert.equal(m.subject, 'Seu papelzinho do Amigo da Firma chegou');
    }
    assert.equal(receivers.size, group.length);
  }
});

test('falha de envio parcial: aparece por pessoa, o resto segue', async () => {
  const t = fakeTransport({ failTo: ['carla@exemplo.com'] });
  const h = createDrawHandler({ env: ENV, makeTransport: t.make, retryDelays: [1, 1] });
  const r = await call(h, body());
  assert.equal(r.status, 200);
  const carla = r.body.sent.find((s) => s.email === 'carla@exemplo.com');
  assert.equal(carla.ok, false);
  assert.match(carla.reason, /550/);
  assert.equal(t.outbox.length, group.length - 1);
});

test('HTML do e-mail escapa o que o organizador digita', async () => {
  const t = fakeTransport();
  const h = createDrawHandler({ env: ENV, makeTransport: t.make, retryDelays: [1, 1] });
  const evil = group.map((g, i) => (i === 0 ? { ...g, name: '<img src=x onerror=alert(1)>' } : g));
  const r = await call(h, body({ participants: evil, event: { name: '<script>x</script>', msg: '"><b>oi' } }));
  assert.equal(r.status, 200);
  for (const m of t.outbox) {
    assert.ok(!m.html.includes('<script>x'));
    assert.ok(!m.html.includes('<img src=x'));
    assert.ok(!m.html.includes('"><b>'));
  }
});

test('revelação: token inválido e servidor sem chave', async () => {
  const reveal = createRevealHandler({ env: ENV });
  assert.equal((await call(reveal, { t: 'A'.repeat(80) })).status, 400);
  assert.equal((await call(reveal, {})).status, 400);
  assert.equal((await call(createRevealHandler({ env: {} }), { t: 'x' })).status, 500);
});

test('PUBLIC_URL tem prioridade sobre o host do pedido', async () => {
  const t = fakeTransport();
  const h = createDrawHandler({ env: { ...ENV, PUBLIC_URL: 'https://papelzinho.exemplo.com/' }, makeTransport: t.make });
  await call(h, body());
  assert.ok(t.outbox[0].html.includes('href="https://papelzinho.exemplo.com/r#'));
});

test('erro temporário do Gmail: tenta de novo e entrega', async () => {
  const t = fakeTransport({ flaky: { 'diego@exemplo.com': 2 } });
  const h = createDrawHandler({ env: ENV, makeTransport: t.make, retryDelays: [1, 1] });
  const r = await call(h, body());
  assert.ok(r.body.sent.every((s) => s.ok));
  assert.equal(t.tries['diego@exemplo.com'], 3);
});

test('erro definitivo (5xx) não fica tentando', async () => {
  const t = fakeTransport({ failTo: ['carla@exemplo.com'] });
  const h = createDrawHandler({ env: ENV, makeTransport: t.make, retryDelays: [1, 1] });
  await call(h, body());
  assert.equal(t.tries['carla@exemplo.com'], 1);
});

test('cópia do próprio dono do Gmail não entra na faxina', async () => {
  const t = fakeTransport();
  const h = createDrawHandler({ env: { ...ENV, GMAIL_USER: 'Ana@Exemplo.com' }, makeTransport: t.make });
  const r = await call(h, body());
  assert.equal(r.body.copies.length, group.length - 1);
  const anaId = t.outbox.find((m) => m.to.address === 'ana@exemplo.com').messageId;
  assert.ok(!r.body.copies.includes(anaId));
});

test('ORGANIZER_PASSWORD curta é recusada', async () => {
  const h = createDrawHandler({ env: { ...ENV, ORGANIZER_PASSWORD: 'curta' }, makeTransport: fakeTransport().make });
  const r = await call(h, body({ password: 'curta' }));
  assert.equal(r.status, 500);
  assert.match(r.body.error, /curta demais/);
});

test('faxina de Enviados: exige senha e só aceita ids do próprio app', async () => {
  const calls = [];
  const h = createPurgeHandler({ env: ENV, wrongPasswordDelay: 0, purge: async (_e, ids) => { calls.push(ids); return { total: ids.length, removed: ids.length }; } });
  const id = '<pz-0123456789abcdef-3@papelzinho>';
  assert.equal((await call(h, { password: 'x', copies: [id] })).status, 401);
  assert.equal((await call(h, { password: 'segredo-do-organizador', copies: ['<qualquer@gmail.com>'] })).status, 400);
  const ok = await call(h, { password: 'segredo-do-organizador', copies: [id] });
  assert.deepEqual(ok.body, { total: 1, removed: 1 });
  assert.deepEqual(calls, [[id]]);
  const broken = createPurgeHandler({ env: ENV, purge: async () => { throw new Error('IMAP fora'); } });
  assert.equal((await call(broken, { password: 'segredo-do-organizador', copies: [id] })).status, 502);
});

test('revelação devolve o carimbo do sorteio', async () => {
  const t = fakeTransport();
  const h = createDrawHandler({ env: ENV, makeTransport: t.make });
  const r = await call(h, body());
  const token = t.outbox[0].html.match(/\/r#([A-Za-z0-9_-]+)/)[1];
  const rv = await call(createRevealHandler({ env: ENV }), { t: token });
  assert.equal(rv.body.stamp, r.body.stamp);
  assert.ok(t.outbox[0].text.includes(`Sorteio de ${r.body.stamp}`));
});
