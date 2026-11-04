import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDraw, draw, seal, open, tokenKey, formatWhen, checkRules, reachableTargets, allowedMatrix, drawStamp } from '../lib/core.js';

const people = (n) => Array.from({ length: n }, (_, i) => ({ name: `Pessoa ${i}`, email: `p${i}@exemplo.com`, tip: '' }));

test('sorteio: ninguém tira a si mesmo e cada um é tirado uma vez', () => {
  for (let run = 0; run < 2000; run++) {
    const n = 3 + (run % 10);
    const t = draw(n, []);
    assert.ok(t);
    assert.equal(new Set(t).size, n);
    t.forEach((j, i) => assert.notEqual(i, j));
  }
});

test('sorteio: separações valem nos dois sentidos', () => {
  const ex = [[0, 1], [2, 3], [0, 4]];
  for (let run = 0; run < 2000; run++) {
    const t = draw(6, ex);
    assert.ok(t);
    for (const [a, b] of ex) {
      assert.notEqual(t[a], b);
      assert.notEqual(t[b], a);
    }
  }
});

test('sorteio: regras impossíveis devolvem null', () => {
  // 3 pessoas, 0 separada de 1 e de 2: 0 não tem quem tirar
  assert.equal(draw(3, [[0, 1], [0, 2]]), null);
  // 4 pessoas, casais 0-1 e 2-3 mais 0-2: 0 só pode tirar 3; 2 só pode tirar 1; ainda possível
  assert.ok(draw(4, [[0, 1], [2, 3], [0, 2]]));
});

test('sorteio: regras apertadas mas possíveis caem no retrocesso e acham solução', () => {
  // 12 pessoas, cada um só pode tirar o próximo (ciclo único permitido)
  const n = 12;
  const ex = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (j !== (i + 1) % n && i !== (j + 1) % n) ex.push([i, j]);
  const t = draw(n, ex);
  assert.ok(t);
  t.forEach((j, i) => assert.ok(j === (i + 1) % n || j === (i - 1 + n) % n));
});

test('sorteio: distribuição sem viés grosseiro (3 pessoas, 2 resultados possíveis)', () => {
  let a = 0;
  const N = 6000;
  for (let i = 0; i < N; i++) if (draw(3, [])[0] === 1) a++;
  assert.ok(Math.abs(a / N - 0.5) < 0.04, `proporção ${a / N}`);
});

test('validação: casos ruins', () => {
  assert.equal(validateDraw({ participants: people(3) }).ok, false);
  assert.equal(validateDraw({ participants: people(61) }).ok, false);
  const dupMail = people(4); dupMail[2].email = 'P0@exemplo.com';
  assert.match(validateDraw({ participants: dupMail }).error, /mesmo e-mail/);
  const dupName = people(4); dupName[2].name = 'pessoa 0';
  assert.match(validateDraw({ participants: dupName }).error, /repetido/);
  const badMail = people(4); badMail[1].email = 'sem-arroba';
  assert.match(validateDraw({ participants: badMail }).error, /e-mail inválido/);
  assert.equal(validateDraw({ participants: people(4), exclusions: [[0, 9]] }).ok, false);
  assert.equal(validateDraw({ participants: people(4), exclusions: [[1, 1]] }).ok, false);
  assert.equal(validateDraw({ participants: people(4), event: { date: '2026-13-40' } }).ok, false);
  assert.equal(validateDraw({ participants: people(4), event: { time: '25:00' } }).ok, false);
});

test('validação: normaliza espaços e e-mail', () => {
  const p = people(4); p[0].name = '  Ana   Souza '; p[0].email = ' ANA@Exemplo.com ';
  const v = validateDraw({ participants: p, event: { name: '', date: '2026-12-19', time: '19:30' } });
  assert.ok(v.ok);
  assert.equal(v.data.participants[0].name, 'Ana Souza');
  assert.equal(v.data.participants[0].email, 'ana@exemplo.com');
  assert.equal(v.data.event.name, 'Amigo secreto');
});

test('token: ida e volta, e qualquer alteração invalida', () => {
  const key = tokenKey({ TOKEN_SECRET: 'x' });
  const payload = { g: 'Ana', r: 'Bruno Lima', h: 'Café e livro de suspense', e: { n: 'Amigo Secreto', v: 'R$ 100', w: 'sáb, 19/12', l: 'Casa', m: '' } };
  const t = seal(payload, key);
  assert.deepEqual(open(t, key), payload);
  assert.equal(open(t, tokenKey({ TOKEN_SECRET: 'outra' })), null);
  const flipped = t.slice(0, 40) + (t[40] === 'A' ? 'B' : 'A') + t.slice(41);
  assert.equal(open(flipped, key), null);
  assert.equal(open('', key), null);
  assert.equal(open('../../etc/passwd', key), null);
  // o nome sorteado não aparece em claro no token
  assert.ok(!Buffer.from(t, 'base64url').toString('latin1').includes('Bruno'));
});

test('token: TOKEN_SECRET é obrigatório', () => {
  assert.throws(() => tokenKey({ GMAIL_APP_PASSWORD: 'x' }));
});

test('token: todos os links têm o mesmo tamanho, seja qual for o nome e a dica', () => {
  const key = tokenKey({ TOKEN_SECRET: 'x' });
  const e = { n: 'Amigo', v: 'R$ 100', w: 'sáb, 19/12', l: 'Casa', m: '' };
  const a = seal({ g: 'Ana', r: 'Bo', h: '', e }, key);
  const b = seal({ g: 'Ana', r: 'Maria Aparecida dos Santos Gonçalves', h: 'x'.repeat(200), e }, key);
  assert.equal(a.length, b.length);
});

test('regras: separação que entrega o resultado é recusada', () => {
  // 4 pessoas; 0 separado de 1 e 2: só pode tirar 3, previsível
  assert.equal(checkRules(4, [[0, 1], [0, 2]]).reason, 'forced');
  assert.ok(checkRules(4, [[0, 1], [0, 2]]).forced.includes(0));
  assert.equal(checkRules(4, [[0, 1], [0, 2], [0, 3]]).reason, 'impossible');
  assert.deepEqual(checkRules(6, [[0, 1], [2, 3]]), { ok: true });
});

test('regras: alvos alcançáveis batem com força bruta', () => {
  const perms = (n) => { const out = []; const p = []; const used = new Array(n).fill(false);
    (function go(i) { if (i === n) { out.push(p.slice()); return; } for (let j = 0; j < n; j++) if (!used[j]) { used[j] = true; p[i] = j; go(i + 1); used[j] = false; } })(0); return out; };
  for (let run = 0; run < 300; run++) {
    const n = 4 + (run % 4);
    const ex = [];
    for (let k = 0; k < run % 9; k++) { const a = Math.floor(Math.random() * n), b = Math.floor(Math.random() * n); if (a !== b) ex.push([a, b]); }
    const ok = allowedMatrix(n, ex);
    const valid = perms(n).filter((p) => p.every((t, i) => ok[i][t]));
    const reach = reachableTargets(ok);
    if (!valid.length) { assert.equal(reach, null); continue; }
    const expect = Array.from({ length: n }, (_, i) => new Set(valid.map((p) => p[i])).size);
    assert.deepEqual(reach, expect, JSON.stringify(ex));
  }
});

test('sorteio: caminho de montagem pessoa a pessoa respeita regras', () => {
  // rnd que nunca embaralha força a rejeição a falhar e cair no caminho de montagem
  const n = 8, ex = [[0, 1], [2, 3], [4, 5]];
  const t = draw(n, ex, () => 0);
  assert.ok(t);
  assert.equal(new Set(t).size, n);
  t.forEach((j, i) => assert.notEqual(i, j));
  for (const [a, b] of ex) { assert.notEqual(t[a], b); assert.notEqual(t[b], a); }
});

test('validação: data que não existe é recusada', () => {
  assert.equal(validateDraw({ participants: people(4), event: { date: '2026-02-31' } }).ok, false);
  assert.equal(validateDraw({ participants: people(4), event: { date: '2028-02-29' } }).ok, true);
});

test('carimbo do sorteio no horário de Brasília', () => {
  assert.equal(drawStamp(new Date('2026-11-04T22:42:00Z')), '04/11 às 19:42');
});

test('data: dia da semana certo e sem fuso', () => {
  assert.equal(formatWhen('2026-12-19', '19:30'), 'sáb, 19/12 · 19:30');
  assert.equal(formatWhen('', ''), 'a combinar');
});
