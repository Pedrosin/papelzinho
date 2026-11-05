// Handlers HTTP. Recebem as dependências por parâmetro para os testes trocarem SMTP/IMAP por falsos.
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { validateDraw, checkRules, draw, seal, open, tokenKey, formatValue, formatWhen, drawStamp, firstName } from './core.js';
import { buildEmail } from './email.js';
import { purgeSentCopies, MESSAGE_ID_RE } from './sent-copies.js';
import { createStore } from './store.js';
import { makeSession, readSession, getCookie, setCookie, cookieName, revokedKey, SESSION_TTL } from './session.js';

const REQUIRED = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'ORGANIZER_PASSWORD', 'TOKEN_SECRET'];
const MIN_PASSWORD = 10;
export const GROUP_CODE_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{10}$/;

export function reply(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

export function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  try {
    return JSON.parse(Buffer.isBuffer(b) ? b.toString('utf8') : b || '');
  } catch {
    return null;
  }
}

function samePassword(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listNames = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} e ${a[a.length - 1]}` : a[0]);

/** Agrupa IPv6 por /64 (cada cliente IPv6 tem um /64 inteiro para trocar de endereço). */
export function ipBucket(ip) {
  ip = String(ip || '').trim().toLowerCase();
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) return v4[1];
  if (!ip.includes(':')) return ip || 'desconhecido';
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}
export const ipKey = (ip) => createHash('sha256').update('papelzinho-ip:' + ipBucket(ip)).digest('hex').slice(0, 20);

/** Janela fixa em memória da instância. hit() conta e diz se passou do limite; undo() devolve uma. */
export function memoryWindow({ limit, windowMs, now = () => Date.now() }) {
  const m = new Map();
  return {
    hit(key) {
      const t = now();
      let e = m.get(key);
      if (!e || t - e.start > windowMs) e = { n: 0, start: t };
      e.n++;
      if (m.size > 5000) m.clear();
      m.set(key, e);
      return e.n > limit;
    },
    undo(key) {
      const e = m.get(key);
      if (e && e.n > 0) e.n--;
    },
  };
}

/**
 * Freio contra chute de senha: 5 tentativas por IP (IPv6 por /64) a cada 15 min.
 * A tentativa é RESERVADA antes de comparar a senha (rajada paralela não passa) e devolvida
 * quando a senha está certa. Sem trava geral: senão qualquer um trancaria o organizador.
 * attempt(ip) -> { allowed, release() }
 */
export function createLimiter({ perIp = 5, windowMs = 15 * 60 * 1000, now } = {}) {
  const w = memoryWindow({ limit: perIp, windowMs, now });
  return {
    async attempt(ip) {
      const k = ipKey(ip);
      if (w.hit(k)) return { allowed: false, release() {} };
      return { allowed: true, release: () => w.undo(k) };
    },
  };
}
const sharedLimiter = createLimiter();

/**
 * Mesmo freio guardado no banco (vale entre instâncias). IP já travado fica marcado em memória
 * e nem consulta o banco (não gasta cota). Banco fora do ar ou sem cota: cai para o freio em memória.
 */
export function storeLimiter(store, { perIp = 5, windowSec = 15 * 60, fallback = createLimiter({ perIp, windowMs: windowSec * 1000 }), now = () => Date.now() } = {}) {
  const blockedUntil = new Map();
  return {
    async attempt(ip) {
      const id = ipKey(ip);
      const t = now();
      if ((blockedUntil.get(id) || 0) > t) return { allowed: false, release() {} };
      const k = `pz:rl:pw:${id}`;
      try {
        const [, n] = await store.pipe([['SET', k, '0', 'EX', windowSec, 'NX'], ['INCR', k]]);
        if (Number(n) > perIp) {
          if (blockedUntil.size > 5000) blockedUntil.clear();
          blockedUntil.set(id, t + windowSec * 1000);
          return { allowed: false, release() {} };
        }
        // senha certa zera o contador do IP (DEL, nunca DECR: DECR em chave vencida cria contador sem prazo)
        return { allowed: true, release: () => store.cmd('DEL', k).catch(() => {}) };
      } catch {
        return fallback.attempt(ip);
      }
    },
  };
}

export function limiterFor(env) {
  const store = createStore(env);
  return store ? storeLimiter(store) : sharedLimiter;
}

export function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'desconhecido').split(',')[0].trim();
}

function configError(env) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) return `O servidor ainda não foi configurado. Falta cadastrar na Vercel: ${missing.join(', ')}.`;
  if (env.ORGANIZER_PASSWORD.length < MIN_PASSWORD) return `A ORGANIZER_PASSWORD cadastrada na Vercel é curta demais. Use pelo menos ${MIN_PASSWORD} caracteres.`;
  return '';
}

/** Pedido vindo de outro site (CSRF): o cookie já é SameSite=Strict; esta é a segunda barreira. */
export function crossSite(req) {
  if (String(req.headers['sec-fetch-site'] || '') === 'cross-site') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** Abertura comum: método, configuração, origem e corpo. Devolve o corpo ou undefined (já respondeu). */
function preflight(req, res, env) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'Use POST.', stage: 'before' });
  const err = configError(env);
  if (err) return reply(res, 500, { error: err, stage: 'before' });
  if (crossSite(req)) return reply(res, 403, { error: 'Pedido de outro site recusado.', stage: 'before' });
  const body = readBody(req);
  if (!body) return reply(res, 400, { error: 'Pedido mal formado.', stage: 'before' });
  return body;
}

/** Sessão válida e não revogada. Banco fora do ar: vale a assinatura (não tranca o organizador). */
async function validSession(req, env, store) {
  const s = readSession(getCookie(req, cookieName(env)), env);
  if (!s) return null;
  if (store) {
    try {
      if (await store.cmd('GET', revokedKey(s.sid))) return null;
    } catch { /* segue só com a assinatura */ }
  }
  return s;
}

/** Rotas do organizador: exigem a sessão do cookie. A senha não é aceita aqui. */
export async function guard(req, res, env, store) {
  const body = preflight(req, res, env);
  if (!body) return;
  if (!(await validSession(req, env, store))) return reply(res, 401, { error: 'Sua sessão terminou. Entre de novo com a senha.', stage: 'before', needsLogin: true });
  return body;
}

/** POST /api/session { action: 'login', password } | { action: 'logout' } */
export function createSessionHandler({ env = process.env, store = createStore(env), limiter = limiterFor(env), wrongPasswordDelay = 900 } = {}) {
  return async function sessionHandler(req, res) {
    const body = preflight(req, res, env);
    if (!body) return;
    if (body.action === 'logout') {
      const s = readSession(getCookie(req, cookieName(env)), env);
      if (s && store) {
        const left = Math.max(1, s.exp - Math.floor(Date.now() / 1000));
        try { await store.cmd('SET', revokedKey(s.sid), '1', 'EX', left); } catch { /* o cookie some mesmo assim */ }
      }
      res.setHeader('Set-Cookie', setCookie(env, '', 0));
      return reply(res, 200, { ok: true });
    }
    if (body.action !== 'login') return reply(res, 400, { error: 'Ação desconhecida.' });
    const slot = await limiter.attempt(clientIp(req));
    if (!slot.allowed) return reply(res, 429, { error: 'Muitas tentativas de senha. Espere 15 minutos.' });
    if (!samePassword(body.password, env.ORGANIZER_PASSWORD)) {
      await sleep(wrongPasswordDelay);
      return reply(res, 401, { error: 'Senha errada.' });
    }
    await slot.release();
    const s = makeSession(env);
    res.setHeader('Set-Cookie', setCookie(env, s.token, SESSION_TTL));
    return reply(res, 200, { ok: true, expiresAt: s.exp * 1000 });
  };
}

function publicBase(req, env) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL.replace(/\/+$/, '');
  // domínio de produção que a própria Vercel informa: link nunca aponta para preview nem para host forjado
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${host}`;
}

export function gmailTransport(env) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    pool: true,
    maxConnections: 3,
    auth: { user: env.GMAIL_USER, pass: String(env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') },
  });
}

async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// Erro temporário do Gmail (4xx, "tente mais tarde") ou queda de conexão: vale tentar de novo.
const transient = (e) => !e?.responseCode || (e.responseCode >= 400 && e.responseCode < 500);

async function sendWithRetry(transport, mail, retryDelays) {
  for (let a = 0; ; a++) {
    try {
      return await transport.sendMail(mail);
    } catch (e) {
      if (a >= retryDelays.length || !transient(e)) throw e;
      await sleep(retryDelays[a]);
    }
  }
}

export function createDrawHandler({ env = process.env, makeTransport = gmailTransport, retryDelays = [1500, 4000], store = createStore(env) } = {}) {
  return async function drawHandler(req, res) {
    const body = await guard(req, res, env, store);
    if (!body) return;

    const v = validateDraw(body);
    if (!v.ok) return reply(res, 400, { error: v.error, stage: 'before' });
    const { participants, exclusions, event } = v.data;

    const rules = checkRules(participants.length, exclusions);
    if (!rules.ok) {
      const error = rules.reason === 'impossible'
        ? 'Com essas separações não existe sorteio possível. Desfaça alguma.'
        : `Com essas separações dá pra adivinhar quem ${listNames(rules.forced.map((i) => firstName(participants[i].name)))} ${rules.forced.length > 1 ? 'vão' : 'vai'} tirar. Desfaça alguma separação.`;
      return reply(res, 422, { error, stage: 'before' });
    }
    const target = draw(participants.length, exclusions);
    if (!target) return reply(res, 422, { error: 'Com essas separações não existe sorteio possível. Desfaça alguma.', stage: 'before' });

    const transport = makeTransport(env);
    try {
      await transport.verify();
    } catch {
      transport.close?.();
      return reply(res, 502, { error: 'O Gmail recusou o login. Confira GMAIL_USER e GMAIL_APP_PASSWORD na Vercel.', stage: 'before' });
    }

    const key = tokenKey(env);
    const base = publicBase(req, env);
    const stamp = drawStamp();
    const drawId = randomBytes(8).toString('hex');
    const ev = { n: event.name, v: formatValue(event.value), w: formatWhen(event.date, event.time), l: event.place || 'a combinar', m: event.msg };
    const sender = env.GMAIL_USER.toLowerCase();

    const results = await mapPool(participants, 3, async (giver, i) => {
      const receiver = participants[target[i]];
      const token = seal({ g: giver.name, r: receiver.name, h: receiver.tip, e: ev, s: stamp }, key);
      const mail = buildEmail({ giver, event, link: `${base}/r#${token}`, stamp });
      const messageId = `<pz-${drawId}-${i}@papelzinho>`;
      try {
        await sendWithRetry(transport, {
          from: { name: 'Papelzinho', address: env.GMAIL_USER },
          to: { name: giver.name, address: giver.email },
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          messageId,
        }, retryDelays);
        // a cópia de quem é o próprio dono do Gmail fica: é o papelzinho dele, na caixa de entrada dele
        return { name: giver.name, email: giver.email, ok: true, copy: giver.email === sender ? null : messageId };
      } catch (e) {
        return { name: giver.name, email: giver.email, ok: false, reason: String(e?.response || e?.message || 'falha no envio').slice(0, 160) };
      }
    });
    transport.close?.();

    // Sorteio de uma turma inscrita por link, tudo enviado: apaga a lista do banco.
    // Só apaga se TODO inscrito da turma estava neste sorteio; quem entrou depois da importação
    // não pode sumir sem aviso.
    let groupDeleted = false;
    let groupLeftovers = 0;
    const group = typeof body.group === 'string' && GROUP_CODE_RE.test(body.group) ? body.group : null;
    if (group && store && results.every((r) => r.ok)) {
      try {
        const flat = (await store.cmd('HGETALL', `pz:g:${group}:p`)) || [];
        const drawn = new Set(participants.map((p) => p.email));
        for (let i = 0; i < flat.length; i += 2) if (!drawn.has(String(flat[i]).toLowerCase())) groupLeftovers++;
        if (!groupLeftovers) {
          await store.pipe([['DEL', `pz:g:${group}`, `pz:g:${group}:p`], ['SREM', 'pz:groups', group]]);
          groupDeleted = true;
        }
      } catch { /* fica para a limpeza manual ou para expirar */ }
    }

    // A resposta nunca leva par nem token: o organizador só vê quem recebeu.
    return reply(res, 200, {
      stamp,
      sent: results.map(({ copy, ...r }) => r),
      copies: results.filter((r) => r.copy).map((r) => r.copy),
      groupDeleted,
      groupLeftovers,
    });
  };
}

export function createPurgeHandler({ env = process.env, purge = purgeSentCopies, store = createStore(env) } = {}) {
  return async function purgeHandler(req, res) {
    const body = await guard(req, res, env, store);
    if (!body) return;
    const ids = Array.isArray(body.copies) ? body.copies : [];
    if (!ids.length) return reply(res, 200, { total: 0, removed: 0 });
    if (ids.length > 60 || !ids.every((id) => typeof id === 'string' && MESSAGE_ID_RE.test(id))) return reply(res, 400, { error: 'Lista de cópias inválida.' });
    try {
      return reply(res, 200, await purge(env, ids));
    } catch (e) {
      return reply(res, 502, { error: 'Não consegui apagar as cópias da pasta Enviados do Gmail.', detail: String(e?.message || '').slice(0, 160) });
    }
  };
}

export function createRevealHandler({ env = process.env } = {}) {
  return async function revealHandler(req, res) {
    if (req.method !== 'POST') return reply(res, 405, { error: 'Use POST.' });
    if (!env.TOKEN_SECRET) return reply(res, 500, { error: 'O servidor ainda não foi configurado.' });
    const body = readBody(req);
    const data = open(body?.t, tokenKey(env));
    if (!data) return reply(res, 400, { error: 'Esse link está incompleto ou não é válido. Abra de novo pelo botão do e-mail.' });
    return reply(res, 200, {
      giver: data.g,
      receiver: data.r,
      tip: data.h || '',
      stamp: data.s || '',
      event: { name: data.e.n, value: data.e.v, when: data.e.w, place: data.e.l, msg: data.e.m || '' },
    });
  };
}
