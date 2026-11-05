import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionHandler, createDrawHandler, createLimiter, storeLimiter } from '../lib/handlers.js';
import { createGroupsHandler } from '../lib/groups.js';
import { makeSession, readSession, cookieName } from '../lib/session.js';
import { memoryStore } from '../lib/store.js';

const ENV = { GMAIL_USER: 'org@gmail.com', GMAIL_APP_PASSWORD: 'x', ORGANIZER_PASSWORD: 'senha-certa-123', TOKEN_SECRET: 'k' };
const PW = 'senha-certa-123';
const people = (n) => Array.from({ length: n }, (_, i) => ({ name: `Pessoa ${i}`, email: `p${i}@exemplo.com`, tip: '' }));
const transport = () => ({ verify: async () => {}, sendMail: async () => {}, close() {} });

// chamada crua: nada de helper que injete sessão
function raw(handler, body, { ip = '1.1.1.1', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(s) { resolve({ status: this.statusCode, body: JSON.parse(s), headers: this.headers }); },
    };
    handler({ method: 'POST', body, headers: { host: 'papelzinho-rho.vercel.app', 'x-real-ip': ip, ...headers } }, res);
  });
}
const cookieOf = (r) => String(r.headers['set-cookie'] || '').split(';')[0];
const sessionH = (opts = {}) => createSessionHandler({ env: ENV, wrongPasswordDelay: 0, store: null, ...opts });

test('login certo: cookie HttpOnly, Secure, SameSite=Strict, __Host-, 8h; senha não volta na resposta', async () => {
  const r = await raw(sessionH(), { action: 'login', password: PW });
  assert.equal(r.status, 200);
  const c = r.headers['set-cookie'];
  assert.match(c, /^__Host-pz_s=/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(c.includes(flag), flag);
  assert.ok(!JSON.stringify(r.body).includes(PW));
  assert.ok(!c.includes(PW));
});

test('login errado: 401 e nenhum cookie', async () => {
  const r = await raw(sessionH(), { action: 'login', password: 'chute' });
  assert.equal(r.status, 401);
  assert.equal(r.headers['set-cookie'], undefined);
});

test('rotas do organizador não aceitam mais senha no corpo, só a sessão', async () => {
  const draw = createDrawHandler({ env: ENV, makeTransport: transport, store: null });
  assert.equal((await raw(draw, { password: PW, participants: people(4) })).status, 401);
  const login = await raw(sessionH(), { action: 'login', password: PW });
  assert.equal((await raw(draw, { participants: people(4) }, { headers: { cookie: cookieOf(login) } })).status, 200);
});

test('cookie adulterado, vencido ou de outra senha: 401', async () => {
  const groups = createGroupsHandler({ env: ENV, store: memoryStore() });
  const name = cookieName(ENV);
  const good = makeSession(ENV).token;
  const [sid, exp, mac] = good.split('.');
  const bad = [
    `${sid}.${Number(exp) + 99999}.${mac}`, // esticou o prazo
    `${sid[0] === 'A' ? 'B' : 'A'}${sid.slice(1)}.${exp}.${mac}`, // trocou o id
    makeSession(ENV, Date.now() - 9 * 3600 * 1000).token, // venceu
    makeSession({ ...ENV, ORGANIZER_PASSWORD: 'senha-antiga-999' }).token, // senha trocada na Vercel
    makeSession({ ...ENV, TOKEN_SECRET: 'outro' }).token,
    'lixo',
  ];
  for (const t of bad) assert.equal((await raw(groups, { action: 'list' }, { headers: { cookie: `${name}=${t}` } })).status, 401, t);
  assert.equal((await raw(groups, { action: 'list' }, { headers: { cookie: `outro=1; ${name}=${good}` } })).status, 200);
  assert.equal(readSession(good, ENV, Date.now() + 8 * 3600 * 1000 + 1000), null);
});

test('Sair revoga a sessão no servidor (cookie copiado antes não serve mais)', async () => {
  const store = memoryStore();
  const s = sessionH({ store });
  const groups = createGroupsHandler({ env: ENV, store });
  const cookie = cookieOf(await raw(s, { action: 'login', password: PW }));
  assert.equal((await raw(groups, { action: 'list' }, { headers: { cookie } })).status, 200);
  const out = await raw(s, { action: 'logout' }, { headers: { cookie } });
  assert.match(out.headers['set-cookie'], /Max-Age=0/);
  assert.equal((await raw(groups, { action: 'list' }, { headers: { cookie } })).status, 401);
});

test('pedido de outro site é recusado mesmo com cookie', async () => {
  const groups = createGroupsHandler({ env: ENV, store: memoryStore() });
  const cookie = `${cookieName(ENV)}=${makeSession(ENV).token}`;
  assert.equal((await raw(groups, { action: 'list' }, { headers: { cookie, origin: 'https://golpe.xyz' } })).status, 403);
  assert.equal((await raw(groups, { action: 'list' }, { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await raw(sessionH(), { action: 'login', password: PW }, { headers: { origin: 'https://golpe.xyz' } })).status, 403);
  assert.equal((await raw(groups, { action: 'list' }, { headers: { cookie, origin: 'https://papelzinho-rho.vercel.app', 'sec-fetch-site': 'same-origin' } })).status, 200);
});

test('limitador: 5 erros travam o IP, inclusive para a senha certa', async () => {
  let t = 0;
  const s = sessionH({ limiter: createLimiter({ now: () => t }) });
  for (let i = 0; i < 5; i++) assert.equal((await raw(s, { action: 'login', password: 'chute' + i })).status, 401);
  assert.equal((await raw(s, { action: 'login', password: PW })).status, 429);
  assert.equal((await raw(s, { action: 'login', password: PW }, { ip: '2.2.2.2' })).status, 200);
  t += 15 * 60 * 1000 + 1;
  assert.equal((await raw(s, { action: 'login', password: PW })).status, 200);
});

test('limitador: rajada em paralelo não passa (tentativa reservada antes de comparar)', async () => {
  const s = sessionH({ limiter: storeLimiter(memoryStore()) });
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => raw(s, { action: 'login', password: 'chute' + i })));
  assert.equal(rs.filter((r) => r.status === 401).length, 5);
  assert.equal(rs.filter((r) => r.status === 429).length, 45);
});

test('limitador: senha certa devolve a tentativa e não há trava geral', async () => {
  const s = sessionH({ limiter: storeLimiter(memoryStore()) });
  for (let i = 0; i < 20; i++) assert.equal((await raw(s, { action: 'login', password: PW })).status, 200);
  for (let i = 0; i < 40; i++) await raw(s, { action: 'login', password: 'x' }, { ip: '10.0.0.' + i });
  assert.equal((await raw(s, { action: 'login', password: PW }, { ip: '8.8.8.8' })).status, 200);
});

test('limitador no banco vale entre instâncias diferentes', async () => {
  const store = memoryStore();
  const a = sessionH({ limiter: storeLimiter(store) });
  const b = sessionH({ limiter: storeLimiter(store) });
  for (let i = 0; i < 5; i++) await raw(i % 2 ? a : b, { action: 'login', password: 'chute' + i });
  assert.equal((await raw(a, { action: 'login', password: PW })).status, 429);
  assert.equal((await raw(b, { action: 'login', password: PW })).status, 429);
  assert.equal((await raw(a, { action: 'login', password: PW }, { ip: '9.9.9.9' })).status, 200);
});
