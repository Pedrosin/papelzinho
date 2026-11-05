import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGroupsHandler, createJoinHandler } from '../lib/groups.js';
import { createDrawHandler, storeLimiter } from '../lib/handlers.js';
import { memoryStore, createStore } from '../lib/store.js';
import { asSession } from './auth.js';

const ENV = { GMAIL_USER: 'org@gmail.com', GMAIL_APP_PASSWORD: 'x', ORGANIZER_PASSWORD: 'senha-certa-123', TOKEN_SECRET: 'k' };
const PW = 'senha-certa-123';

function call(handler, body, ip = '1.1.1.1') {
  return new Promise((resolve) => {
    const res = { statusCode: 0, setHeader() {}, end(s) { resolve({ status: this.statusCode, body: JSON.parse(s) }); } };
    const a = asSession(ENV, body);
    handler({ method: 'POST', body: a.body, headers: { host: 'h', 'x-real-ip': ip, ...a.headers } }, res);
  });
}

function setup() {
  const store = memoryStore();
  const limiter = storeLimiter(store);
  return {
    store,
    org: createGroupsHandler({ env: ENV, store, limiter, wrongPasswordDelay: 0 }),
    join: createJoinHandler({ env: ENV, store }),
  };
}

test('fluxo: criar turma, inscrever pelo link, organizador vê e importa', async () => {
  const { org, join } = setup();
  const c = await call(org, { password: PW, action: 'create', name: 'Família 2026' });
  assert.equal(c.status, 200);
  const code = c.body.group.code;
  assert.match(code, /^[a-z2-9]{10}$/);

  const info = await call(join, { code, action: 'info' });
  assert.deepEqual(info.body, { name: 'Família 2026', closed: false, count: 0, names: [] });

  for (const [name, email] of [['Ana Souza', 'ANA@exemplo.com'], ['Bruno', 'bruno@exemplo.com']]) {
    const r = await call(join, { code, action: 'join', name, email, tip: 'Café' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const info2 = await call(join, { code, action: 'info' });
  assert.deepEqual(info2.body.names, ['Ana', 'Bruno']);
  // participante não vê e-mail nem dica de ninguém
  assert.ok(!JSON.stringify(info2.body).includes('@'));
  assert.ok(!JSON.stringify(info2.body).includes('Café'));

  const people = await call(org, { password: PW, action: 'people', code });
  assert.deepEqual(people.body.people.map((p) => p.email), ['ana@exemplo.com', 'bruno@exemplo.com']);

  const list = await call(org, { password: PW, action: 'list' });
  assert.equal(list.body.groups[0].count, 2);
});

test('inscrição: duplicado, encerrada, link no nome, código inválido', async () => {
  const { org, join } = setup();
  const code = (await call(org, { password: PW, action: 'create', name: 'Firma' })).body.group.code;
  await call(join, { code, action: 'join', name: 'Ana', email: 'ana@exemplo.com' });
  assert.equal((await call(join, { code, action: 'join', name: 'Outra', email: 'ana@exemplo.com' })).status, 409);
  assert.equal((await call(join, { code, action: 'join', name: 'ana', email: 'ana2@exemplo.com' })).status, 409);
  assert.equal((await call(join, { code, action: 'join', name: 'Clique em golpe.com', email: 'x@exemplo.com' })).status, 400);
  assert.equal((await call(join, { code, action: 'join', name: 'Sem Email', email: 'nada' })).status, 400);
  assert.equal((await call(join, { code: 'naoexiste2', action: 'info' })).status, 404);
  assert.equal((await call(join, { code: '../etc', action: 'info' })).status, 404);
  await call(org, { password: PW, action: 'close', code, closed: true });
  const closed = await call(join, { code, action: 'join', name: 'Carla', email: 'carla@exemplo.com' });
  assert.equal(closed.status, 409);
  assert.equal((await call(join, { code, action: 'info' })).body.closed, true);
});

test('inscrição: organizador remove e apaga turma', async () => {
  const { org, join } = setup();
  const code = (await call(org, { password: PW, action: 'create', name: 'Firma' })).body.group.code;
  await call(join, { code, action: 'join', name: 'Ana', email: 'ana@exemplo.com' });
  await call(org, { password: PW, action: 'remove', code, email: 'ana@exemplo.com' });
  assert.equal((await call(org, { password: PW, action: 'people', code })).body.people.length, 0);
  await call(org, { password: PW, action: 'delete', code });
  assert.equal((await call(join, { code, action: 'info' })).status, 404);
  assert.equal((await call(org, { password: PW, action: 'list' })).body.groups.length, 0);
});

test('turmas: tudo do organizador exige senha', async () => {
  const { org } = setup();
  for (const action of ['list', 'create', 'people', 'delete']) {
    assert.equal((await call(org, { password: 'errada', action, name: 'x', code: 'abcdefghjk' })).status, 401);
  }
});

test('inscrição: limite por IP conta só inscrições; abrir a página não gasta', async () => {
  const store = memoryStore();
  const org = createGroupsHandler({ env: ENV, store, limiter: storeLimiter(store) });
  const join = createJoinHandler({ env: ENV, store, joinsPerHour: 3 });
  const code = (await call(org, { password: PW, action: 'create', name: 'Firma' })).body.group.code;
  for (let i = 0; i < 10; i++) assert.equal((await call(join, { code, action: 'info' })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await call(join, { code, action: 'join', name: 'P' + i, email: `p${i}@exemplo.com` })).status, 200);
  assert.equal((await call(join, { code, action: 'join', name: 'P9', email: 'p9@exemplo.com' })).status, 429);
  assert.equal((await call(join, { code, action: 'join', name: 'P9', email: 'p9@exemplo.com' }, '2.2.2.2')).status, 200);
});

test('inscrição: barreira em memória segura rajada antes de tocar no banco', async () => {
  let calls = 0;
  const base = memoryStore();
  const counted = { cmd: (...a) => { calls++; return base.cmd(...a); }, pipe: (c) => { calls++; return base.pipe(c); } };
  const join = createJoinHandler({ env: ENV, store: counted, memLimit: 5 });
  for (let i = 0; i < 50; i++) await call(join, { code: 'abcdefghjk', action: 'info' });
  assert.ok(calls <= 5, `banco chamado ${calls}x`);
});

test('inscrição: 60 no máximo mesmo com inscrições simultâneas', async () => {
  const { org, store } = setup();
  const code = (await call(org, { password: PW, action: 'create', name: 'Firma' })).body.group.code;
  const join = createJoinHandler({ env: ENV, store, joinsPerHour: 1000, memLimit: 1000 });
  const rs = await Promise.all(Array.from({ length: 90 }, (_, i) => call(join, { code, action: 'join', name: 'Pessoa ' + i, email: `p${i}@exemplo.com` }, '10.0.' + Math.floor(i / 50) + '.' + (i % 50))));
  assert.equal(rs.filter((r) => r.status === 200).length, 60);
  assert.equal(Number(await store.cmd('HLEN', `pz:g:${code}:p`)), 60);
});

test('inscrição: dica com link é recusada; duplicado não diz se foi nome ou e-mail', async () => {
  const { org, join } = setup();
  const code = (await call(org, { password: PW, action: 'create', name: 'Firma' })).body.group.code;
  assert.equal((await call(join, { code, action: 'join', name: 'Ana', email: 'ana@exemplo.com', tip: 'resgate em golpe.com' })).status, 400);
  await call(join, { code, action: 'join', name: 'Ana', email: 'ana@exemplo.com' });
  const a = await call(join, { code, action: 'join', name: 'Ana', email: 'outra@exemplo.com' });
  const b = await call(join, { code, action: 'join', name: 'Beto', email: 'ana@exemplo.com' });
  assert.equal(a.body.error, b.body.error);
});

test('prazo: turma e inscritos vencem juntos e nada renova', async () => {
  const { org, join, store } = setup();
  const code = (await call(org, { password: PW, action: 'create', name: 'Firma' })).body.group.code;
  await call(join, { code, action: 'join', name: 'Ana', email: 'ana@exemplo.com' });
  await call(org, { password: PW, action: 'close', code, closed: true });
  const t1 = Number(await store.cmd('TTL', `pz:g:${code}`));
  const t2 = Number(await store.cmd('TTL', `pz:g:${code}:p`));
  assert.ok(Math.abs(t1 - t2) <= 1 && t1 <= 60 * 24 * 3600, `${t1} x ${t2}`);
});

test('apagar turma vencida leva junto a lista de inscritos', async () => {
  const { org, store } = setup();
  const code = (await call(org, { password: PW, action: 'create', name: 'Firma' })).body.group.code;
  await store.cmd('HSET', `pz:g:${code}:p`, 'x@exemplo.com', '{}');
  await store.cmd('DEL', `pz:g:${code}`); // dados da turma venceram
  assert.equal((await call(org, { password: PW, action: 'delete', code })).status, 200);
  assert.equal(Number(await store.cmd('HLEN', `pz:g:${code}:p`)), 0);
});

test('trazer inscritos encerra a inscrição', async () => {
  const { org, join } = setup();
  const code = (await call(org, { password: PW, action: 'create', name: 'Firma' })).body.group.code;
  await call(join, { code, action: 'join', name: 'Ana', email: 'ana@exemplo.com' });
  await call(org, { password: PW, action: 'people', code, closeAfter: true });
  assert.equal((await call(join, { code, action: 'join', name: 'Beto', email: 'beto@exemplo.com' })).status, 409);
});

test('sem banco configurado: avisa que falta ligar', async () => {
  const org = createGroupsHandler({ env: ENV, store: null, limiter: storeLimiter(memoryStore()) });
  const r = await call(org, { password: PW, action: 'list' });
  assert.equal(r.status, 503);
  assert.equal(r.body.needsStore, true);
  assert.equal((await call(createJoinHandler({ env: ENV, store: null }), { code: 'abcdefghjk', action: 'info' })).status, 503);
});

test('sorteio com turma: tudo enviado apaga a lista; falha parcial mantém', async () => {
  const transport = (failTo) => () => ({ verify: async () => {}, sendMail: async (m) => { if (m.to.address === failTo) throw Object.assign(new Error('550'), { responseCode: 550 }); }, close() {} });
  const people = Array.from({ length: 4 }, (_, i) => ({ name: `P ${i}`, email: `p${i}@exemplo.com`, tip: '' }));
  for (const [failTo, expectDeleted] of [[null, true], ['p1@exemplo.com', false]]) {
    const { store, org } = setup();
    const code = (await call(org, { password: PW, action: 'create', name: 'Firma' })).body.group.code;
    const draw = createDrawHandler({ env: ENV, store, limiter: storeLimiter(store), makeTransport: transport(failTo), retryDelays: [] });
    const join = createJoinHandler({ env: ENV, store });
    for (const p of people) await call(join, { code, action: 'join', ...p });
    const r = await call(draw, { password: PW, participants: people, group: code });
    assert.equal(r.body.groupDeleted, expectDeleted);
    assert.equal((await call(org, { password: PW, action: 'list' })).body.groups.length, expectDeleted ? 0 : 1);
  }
});

test('cliente do Upstash: monta a chamada REST certa', async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    const body = url.endsWith('/pipeline') ? [{ result: 1 }, { result: 1 }] : { result: 'OK' };
    return { ok: true, status: 200, json: async () => body };
  };
  const store = createStore({ KV_REST_API_URL: 'https://x.upstash.io/', KV_REST_API_TOKEN: 'tok' }, fake);
  assert.equal(await store.cmd('SET', 'k', 1, 'EX', 60), 'OK');
  assert.deepEqual(await store.pipe([['INCR', 'a'], ['EXPIRE', 'a', 60, 'NX']]), [1, 1]);
  assert.deepEqual(calls[0], { url: 'https://x.upstash.io', auth: 'Bearer tok', body: ['SET', 'k', '1', 'EX', '60'] });
  assert.equal(calls[1].url, 'https://x.upstash.io/pipeline');
  assert.equal(createStore({}), null);
});

test('sorteio não apaga turma se tem inscrito que ficou de fora', async () => {
  const { store, org } = setup();
  const code = (await call(org, { password: PW, action: 'create', name: 'Firma' })).body.group.code;
  const join = createJoinHandler({ env: ENV, store });
  const people = Array.from({ length: 4 }, (_, i) => ({ name: `P ${i}`, email: `p${i}@exemplo.com`, tip: '' }));
  for (const p of people) await call(join, { code, action: 'join', ...p });
  await call(join, { code, action: 'join', name: 'Atrasado', email: 'tarde@exemplo.com' });
  const transport = () => ({ verify: async () => {}, sendMail: async () => {}, close() {} });
  const draw = createDrawHandler({ env: ENV, store, limiter: storeLimiter(store), makeTransport: transport });
  const r = await call(draw, { password: PW, participants: people, group: code });
  assert.equal(r.body.groupDeleted, false);
  assert.equal(r.body.groupLeftovers, 1);
});

test('banco: acha as variáveis com ou sem prefixo, nunca o token só-leitura', async () => {
  const { storeConfig } = await import('../lib/store.js');
  assert.deepEqual(storeConfig({ KV_REST_API_URL: 'https://a.upstash.io', KV_REST_API_TOKEN: 't' }), { url: 'https://a.upstash.io', token: 't' });
  assert.deepEqual(storeConfig({ STORAGE_KV_REST_API_URL: 'https://b.upstash.io/', STORAGE_KV_REST_API_TOKEN: 'u', STORAGE_KV_REST_API_READ_ONLY_TOKEN: 'ro' }), { url: 'https://b.upstash.io', token: 'u' });
  assert.deepEqual(storeConfig({ UPSTASH_REDIS_REST_URL: 'https://c.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'v' }), { url: 'https://c.upstash.io', token: 'v' });
  assert.equal(storeConfig({ KV_URL: 'rediss://x', REDIS_URL: 'rediss://y' }), null);
});
