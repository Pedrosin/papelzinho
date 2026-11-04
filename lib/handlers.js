// Handlers HTTP. Recebem as dependências por parâmetro para os testes trocarem SMTP/IMAP por falsos.
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { validateDraw, checkRules, draw, seal, open, tokenKey, formatValue, formatWhen, drawStamp, firstName } from './core.js';
import { buildEmail } from './email.js';
import { purgeSentCopies, MESSAGE_ID_RE } from './sent-copies.js';

const REQUIRED = ['GMAIL_USER', 'GMAIL_APP_PASSWORD', 'ORGANIZER_PASSWORD', 'TOKEN_SECRET'];
const MIN_PASSWORD = 10;

function reply(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(data));
}

function readBody(req) {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listNames = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} e ${a[a.length - 1]}` : a[0]);

/**
 * Freio contra chute de senha. Fica em memória da instância (sem banco): não é perfeito em
 * serverless, mas a instância é reaproveitada e corta rajadas. Por IP: 5 erros em 15 min trava
 * o IP por 15 min. Geral: 30 erros em 15 min trava todo mundo (inclusive a senha certa) por 15 min.
 */
export function createLimiter({ perIp = 5, global = 30, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const ips = new Map();
  let all = { n: 0, start: 0, lockedUntil: 0 };
  const fresh = (e, t) => (t - e.start > windowMs ? { n: 0, start: t, lockedUntil: e.lockedUntil } : e);
  return {
    blocked(ip) {
      const t = now();
      if (all.lockedUntil > t) return true;
      const e = ips.get(ip);
      return Boolean(e && e.lockedUntil > t);
    },
    fail(ip) {
      const t = now();
      if (ips.size > 5000) ips.clear();
      const e = fresh(ips.get(ip) || { n: 0, start: t, lockedUntil: 0 }, t);
      e.n++;
      if (e.n >= perIp) e.lockedUntil = t + windowMs;
      ips.set(ip, e);
      all = fresh(all, t);
      all.n++;
      if (all.n >= global) all.lockedUntil = t + windowMs;
    },
  };
}
const sharedLimiter = createLimiter();

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || 'desconhecido').split(',')[0].trim();
}

/** Confere configuração e senha. Devolve o corpo se pode seguir, ou undefined se já respondeu o erro. */
async function guard(req, res, env, wrongPasswordDelay, limiter) {
  if (req.method !== 'POST') return reply(res, 405, { error: 'Use POST.', stage: 'before' });
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) return reply(res, 500, { error: `O servidor ainda não foi configurado. Falta cadastrar na Vercel: ${missing.join(', ')}.`, stage: 'before' });
  if (env.ORGANIZER_PASSWORD.length < MIN_PASSWORD) return reply(res, 500, { error: `A ORGANIZER_PASSWORD cadastrada na Vercel é curta demais. Use pelo menos ${MIN_PASSWORD} caracteres.`, stage: 'before' });
  const ip = clientIp(req);
  if (limiter.blocked(ip)) return reply(res, 429, { error: 'Muitas tentativas de senha errada. Espere 15 minutos.', stage: 'before' });
  const body = readBody(req);
  if (!body) return reply(res, 400, { error: 'Pedido mal formado.', stage: 'before' });
  if (!samePassword(body.password, env.ORGANIZER_PASSWORD)) {
    limiter.fail(ip);
    await sleep(wrongPasswordDelay);
    return reply(res, 401, { error: 'Senha do organizador errada.', stage: 'before' });
  }
  return body;
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

export function createDrawHandler({ env = process.env, makeTransport = gmailTransport, wrongPasswordDelay = 900, retryDelays = [1500, 4000], limiter = sharedLimiter } = {}) {
  return async function drawHandler(req, res) {
    const body = await guard(req, res, env, wrongPasswordDelay, limiter);
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

    // A resposta nunca leva par nem token: o organizador só vê quem recebeu.
    return reply(res, 200, {
      stamp,
      sent: results.map(({ copy, ...r }) => r),
      copies: results.filter((r) => r.copy).map((r) => r.copy),
    });
  };
}

export function createPurgeHandler({ env = process.env, purge = purgeSentCopies, wrongPasswordDelay = 900, limiter = sharedLimiter } = {}) {
  return async function purgeHandler(req, res) {
    const body = await guard(req, res, env, wrongPasswordDelay, limiter);
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
