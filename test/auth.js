// Testes antigos mandam { password } no corpo; agora as rotas do organizador só aceitam a sessão do cookie.
// Senha certa no corpo => o helper anexa um cookie de sessão válido (como se tivesse feito login) e tira a senha do corpo.
import { makeSession, cookieName } from '../lib/session.js';

export function asSession(env, body) {
  if (!body || typeof body !== 'object') return { body, headers: {} };
  const { password, ...rest } = body;
  if (password && password === env.ORGANIZER_PASSWORD) return { body: rest, headers: { cookie: `${cookieName(env)}=${makeSession(env).token}` } };
  return { body: rest, headers: {} };
}
