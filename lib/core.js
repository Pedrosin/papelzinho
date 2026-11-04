// Regras puras do Papelzinho: validação, sorteio e token do papelzinho.
// Nada aqui faz I/O, então dá pra testar sem rede.
import { randomInt, createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

export const LIMITS = { minPeople: 4, maxPeople: 60, name: 60, email: 120, tip: 200, eventName: 80, value: 20, place: 80, msg: 300, exclusions: 300, minTargets: 2 };

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const str = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

// Texto que aparece no e-mail não pode ter link: se a senha vazar, o app não vira disparador de phishing.
const LINK_RE = /(https?:|www\.|\b[a-z0-9-]+\.(com|net|org|br|io|app|xyz|info|link|ly|me|co|site|online|top|shop)\b|@)/i;
const hasLink = (s) => LINK_RE.test(s);

function validDate(s) {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Valida e normaliza o pedido de sorteio. Retorna { ok:true, data } ou { ok:false, error }. */
export function validateDraw(body) {
  if (!body || typeof body !== 'object') return fail('Pedido vazio.');
  const people = Array.isArray(body.participants) ? body.participants : null;
  if (!people) return fail('Lista de participantes ausente.');
  if (people.length < LIMITS.minPeople) return fail(`Precisa de pelo menos ${LIMITS.minPeople} pessoas.`);
  if (people.length > LIMITS.maxPeople) return fail(`No máximo ${LIMITS.maxPeople} pessoas por sorteio.`);

  const participants = [];
  const seenMail = new Map();
  const seenName = new Map();
  for (let i = 0; i < people.length; i++) {
    const p = people[i] || {};
    const name = str(p.name);
    const email = str(p.email).toLowerCase();
    const tip = str(p.tip);
    const pos = `Pessoa ${i + 1}`;
    if (!name) return fail(`${pos}: falta o nome.`);
    if (hasLink(name)) return fail(`${pos}: nome não pode ter link nem e-mail.`);
    if (name.length > LIMITS.name) return fail(`${pos}: nome passa de ${LIMITS.name} caracteres.`);
    if (!email || email.length > LIMITS.email || !EMAIL_RE.test(email)) return fail(`${name}: e-mail inválido.`);
    if (tip.length > LIMITS.tip) return fail(`${name}: dica passa de ${LIMITS.tip} caracteres.`);
    const nk = name.toLocaleLowerCase('pt-BR');
    if (seenName.has(nk)) return fail(`Nome repetido: ${name}. Use sobrenome para diferenciar.`);
    if (seenMail.has(email)) return fail(`${name} e ${seenMail.get(email)} estão com o mesmo e-mail.`);
    seenName.set(nk, true);
    seenMail.set(email, name);
    participants.push({ name, email, tip });
  }

  const rawEx = Array.isArray(body.exclusions) ? body.exclusions : [];
  if (rawEx.length > LIMITS.exclusions) return fail('Separações demais.');
  const exclusions = [];
  for (const pair of rawEx) {
    if (!Array.isArray(pair) || pair.length !== 2) return fail('Separação mal formada.');
    const [a, b] = pair;
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b || a < 0 || b < 0 || a >= participants.length || b >= participants.length) {
      return fail('Separação aponta para pessoa que não existe.');
    }
    exclusions.push([a, b]);
  }

  const ev = body.event || {};
  const event = {
    name: str(ev.name) || 'Amigo secreto',
    value: str(ev.value),
    date: str(ev.date),
    time: str(ev.time),
    place: str(ev.place),
    msg: str(ev.msg),
  };
  if (event.name.length > LIMITS.eventName) return fail(`Nome do amigo secreto passa de ${LIMITS.eventName} caracteres.`);
  if (event.value.length > LIMITS.value) return fail('Valor sugerido longo demais.');
  if (event.place.length > LIMITS.place) return fail(`Local passa de ${LIMITS.place} caracteres.`);
  if (event.msg.length > LIMITS.msg) return fail(`Recado passa de ${LIMITS.msg} caracteres.`);
  for (const [k, label] of [['name', 'Nome do amigo secreto'], ['value', 'Valor'], ['place', 'Local'], ['msg', 'Recado']]) {
    if (hasLink(event[k])) return fail(`${label} não pode ter link nem e-mail.`);
  }
  if (event.date && !validDate(event.date)) return fail('Data inválida.');
  if (event.time && !TIME_RE.test(event.time)) return fail('Horário inválido.');

  return { ok: true, data: { participants, exclusions, event } };
}

function fail(error) {
  return { ok: false, error };
}

// ---------- grafo de quem pode tirar quem ----------

/** Matriz de quem pode tirar quem (sem si mesmo, sem separações, nos dois sentidos). */
export function allowedMatrix(n, exclusions) {
  const ok = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i !== j));
  for (const [a, b] of exclusions) {
    ok[a][b] = false;
    ok[b][a] = false;
  }
  return ok;
}

/** Um sorteio válido qualquer (emparelhamento perfeito, Kuhn) ou null se não existe. */
export function perfectMatching(ok) {
  const n = ok.length;
  const matchR = new Array(n).fill(-1);
  const aug = (i, seen) => {
    for (let j = 0; j < n; j++) {
      if (!ok[i][j] || seen[j]) continue;
      seen[j] = 1;
      if (matchR[j] < 0 || aug(matchR[j], seen)) {
        matchR[j] = i;
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < n; i++) if (!aug(i, new Uint8Array(n))) return null;
  const matchL = new Array(n);
  matchR.forEach((i, j) => { matchL[i] = j; });
  return matchL;
}

function scc(adj) {
  const n = adj.length;
  const idx = new Array(n).fill(-1), low = new Array(n).fill(0), comp = new Array(n).fill(-1), onStack = new Uint8Array(n);
  const stack = [];
  let counter = 0, c = 0;
  const visit = (v) => {
    idx[v] = low[v] = counter++;
    stack.push(v); onStack[v] = 1;
    for (const w of adj[v]) {
      if (idx[w] < 0) { visit(w); low[v] = Math.min(low[v], low[w]); }
      else if (onStack[w]) low[v] = Math.min(low[v], idx[w]);
    }
    if (low[v] === idx[v]) {
      let w;
      do { w = stack.pop(); onStack[w] = 0; comp[w] = c; } while (w !== v);
      c++;
    }
  };
  for (let v = 0; v < n; v++) if (idx[v] < 0) visit(v);
  return comp;
}

/**
 * Para cada pessoa, quantas pessoas ela pode de fato tirar em algum sorteio válido.
 * Aresta i→j está em algum emparelhamento perfeito sse está no emparelhamento achado
 * ou suas pontas caem no mesmo componente fortemente conexo do grafo alternante.
 * Devolve null se não existe sorteio.
 */
export function reachableTargets(ok) {
  const n = ok.length;
  const m = perfectMatching(ok);
  if (!m) return null;
  const adj = Array.from({ length: 2 * n }, () => []);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (!ok[i][j]) continue;
    if (m[i] === j) adj[n + j].push(i);
    else adj[i].push(n + j);
  }
  const comp = scc(adj);
  return Array.from({ length: n }, (_, i) => {
    let c = 0;
    for (let j = 0; j < n; j++) if (ok[i][j] && (m[i] === j || comp[i] === comp[n + j])) c++;
    return c;
  });
}

/**
 * Confere se as regras deixam o sorteio possível E imprevisível:
 * ninguém pode ficar com menos de LIMITS.minTargets opções reais,
 * senão o organizador saberia quem aquela pessoa tirou.
 */
export function checkRules(n, exclusions) {
  const reach = reachableTargets(allowedMatrix(n, exclusions));
  if (!reach) return { ok: false, reason: 'impossible' };
  const forced = reach.map((c, i) => (c < LIMITS.minTargets ? i : -1)).filter((i) => i >= 0);
  if (forced.length) return { ok: false, reason: 'forced', forced };
  return { ok: true };
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Sorteia: devolve target[i] = índice de quem a pessoa i tirou, ou null se impossível.
 * Primeiro amostragem por rejeição (uniforme entre todos os sorteios válidos).
 * Se as regras forem apertadas demais, monta pessoa a pessoa em ordem aleatória,
 * só aceitando escolhas que ainda deixam o resto com sorteio possível (nunca empaca).
 */
export function draw(n, exclusions, rnd = randomInt) {
  const ok = allowedMatrix(n, exclusions);
  if (!perfectMatching(ok)) return null;

  const perm = Array.from({ length: n }, (_, i) => i);
  for (let attempt = 0; attempt < 20000; attempt++) {
    shuffle(perm, rnd);
    if (perm.every((t, i) => ok[i][t])) return perm.slice();
  }

  const cur = ok.map((r) => r.slice());
  const target = new Array(n).fill(-1);
  for (const i of shuffle(Array.from({ length: n }, (_, k) => k), rnd)) {
    const cands = shuffle(Array.from({ length: n }, (_, j) => j).filter((j) => cur[i][j]), rnd);
    for (const j of cands) {
      const row = cur[i].slice();
      const col = cur.map((r) => r[j]);
      for (let k = 0; k < n; k++) { cur[i][k] = k === j; if (k !== i) cur[k][j] = false; }
      if (perfectMatching(cur)) { target[i] = j; break; }
      cur[i] = row;
      col.forEach((v, k) => { cur[k][j] = v; });
    }
    if (target[i] < 0) return null;
  }
  return target;
}

// ---------- token do papelzinho (AES-256-GCM, chave só no servidor) ----------

export function tokenKey(env) {
  if (!env.TOKEN_SECRET) throw new Error('Sem TOKEN_SECRET.');
  return createHash('sha256').update('papelzinho:' + env.TOKEN_SECRET).digest();
}

const VERSION = 2;
const PAD = 512;

// Texto comprimido vai dentro de um bloco de tamanho fixo: todos os links ficam do mesmo
// tamanho e o comprimento não entrega o tamanho do nome sorteado nem da dica.
export function seal(payload, key) {
  const z = deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const size = Math.max(PAD, Math.ceil((z.length + 2) / PAD) * PAD);
  const block = Buffer.alloc(size);
  block.writeUInt16BE(z.length, 0);
  z.copy(block, 2);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(block), c.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, c.getAuthTag(), body]).toString('base64url');
}

export function open(token, key) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 6000 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const buf = Buffer.from(token, 'base64url');
    if (buf[0] !== VERSION) return null;
    const d = createDecipheriv('aes-256-gcm', key, buf.subarray(1, 13));
    d.setAuthTag(buf.subarray(13, 29));
    const block = Buffer.concat([d.update(buf.subarray(29)), d.final()]);
    const len = block.readUInt16BE(0);
    return JSON.parse(inflateRawSync(block.subarray(2, 2 + len)).toString('utf8'));
  } catch {
    return null;
  }
}

// ---------- formatação ----------

const WEEK = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function formatWhen(date, time) {
  if (!date) return time ? `às ${time}` : 'a combinar';
  const [y, m, d] = date.split('-').map(Number);
  const wd = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}${time ? ' · ' + time : ''}`;
}

export function formatValue(v) {
  if (!v) return 'livre';
  return /^r\$/i.test(v) ? v : `R$ ${v}`;
}

/** Carimbo do sorteio no horário de Brasília, ex.: "04/11 às 19:42". */
export function drawStamp(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} às ${p.hour}:${p.minute}`;
}

export const firstName = (n) => n.split(' ')[0];

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
