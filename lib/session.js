// Sessão do organizador: a senha só trafega no login. Depois disso o navegador guarda um cookie
// HttpOnly (JavaScript da página não lê), Secure, SameSite=Strict, assinado com HMAC e com prazo.
// A chave da assinatura deriva de TOKEN_SECRET + ORGANIZER_PASSWORD: trocar a senha na Vercel derruba
// todas as sessões abertas. "Sair" revoga a sessão no banco (quando ligado), não só apaga o cookie.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_TTL = 8 * 3600; // segundos

const sessionKey = (env) => createHash('sha256').update(`papelzinho-sessao\0${env.TOKEN_SECRET}\0${env.ORGANIZER_PASSWORD}`).digest();
const sign = (payload, env) => createHmac('sha256', sessionKey(env)).update(payload).digest('base64url');
const nowSec = (now) => Math.floor(now / 1000);

export const cookieName = (env) => (env.PZ_INSECURE_COOKIE ? 'pz_s' : '__Host-pz_s');
export const revokedKey = (sid) => `pz:sess:off:${sid}`;

export function makeSession(env, now = Date.now()) {
  const sid = randomBytes(16).toString('base64url');
  const exp = nowSec(now) + SESSION_TTL;
  const payload = `${sid}.${exp}`;
  return { token: `${payload}.${sign(payload, env)}`, sid, exp };
}

/** Devolve { sid, exp } se o token é íntegro e está no prazo; senão null. */
export function readSession(token, env, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{22}$/.test(parts[0]) || !/^\d{1,12}$/.test(parts[1])) return null;
  const given = Buffer.from(parts[2], 'base64url');
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`, env), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const exp = Number(parts[1]);
  if (exp <= nowSec(now)) return null;
  return { sid: parts[0], exp };
}

export function getCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

export function setCookie(env, token, maxAge) {
  return `${cookieName(env)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${env.PZ_INSECURE_COOKIE ? '' : '; Secure'}`;
}
