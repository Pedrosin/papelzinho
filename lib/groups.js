// Turmas com inscrição por link.
// Organizador (com senha): cria turma, vê inscritos, remove, fecha inscrição, apaga.
// Participante (com o código do link): vê o nome da turma e se inscreve.
// No banco: pz:groups (conjunto de códigos), pz:g:<código> (dados da turma), pz:g:<código>:p (inscritos por e-mail).
// As duas chaves da turma vencem no MESMO instante (criação + 60 dias); nada renova esse prazo.
import { randomInt } from 'node:crypto';
import { validatePerson, hasLink, LIMITS } from './core.js';
import { createStore, storeWindow } from './store.js';
import { reply, readBody, guard, clientIp, ipKey, memoryWindow, GROUP_CODE_RE } from './handlers.js';

export const TTL_MS = 60 * 24 * 3600 * 1000; // inscrições somem sozinhas em 60 dias
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const newCode = () => Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const kMeta = (c) => `pz:g:${c}`;
const kPeople = (c) => `pz:g:${c}:p`;
const clean = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const secondsLeft = (meta, now = Date.now()) => Math.max(1, Math.ceil(((meta.expiresAt || meta.createdAt + TTL_MS) - now) / 1000));
const NO_STORE = { error: 'A inscrição por link precisa do banco gratuito (Upstash Redis) ligado ao projeto na Vercel.', needsStore: true };
const DUP = 'Não deu para inscrever: esse nome ou esse e-mail já está na turma. Se precisar corrigir algo, fale com quem organiza.';

async function readMeta(store, code) {
  const raw = await store.cmd('GET', kMeta(code));
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function readPeople(store, code) {
  const flat = (await store.cmd('HGETALL', kPeople(code))) || [];
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    try {
      out.push(JSON.parse(flat[i + 1]));
    } catch { /* ignora linha estragada */ }
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

const dropGroup = (store, code) => store.pipe([['DEL', kMeta(code), kPeople(code)], ['SREM', 'pz:groups', code]]);

export function createGroupsHandler({ env = process.env, store = createStore(env) } = {}) {
  return async function groupsHandler(req, res) {
    const body = await guard(req, res, env, store);
    if (!body) return;
    if (!store) return reply(res, 503, NO_STORE);

    const action = body.action;
    const code = typeof body.code === 'string' && GROUP_CODE_RE.test(body.code) ? body.code : null;
    try {
      if (action === 'list') {
        const codes = (await store.cmd('SMEMBERS', 'pz:groups')) || [];
        const groups = [];
        for (const c of codes) {
          const meta = await readMeta(store, c);
          if (!meta) {
            await dropGroup(store, c); // venceu: leva junto a lista de inscritos
            continue;
          }
          groups.push({ code: c, name: meta.name, closed: Boolean(meta.closed), createdAt: meta.createdAt, expiresAt: meta.expiresAt, count: Number(await store.cmd('HLEN', kPeople(c))) });
        }
        groups.sort((a, b) => b.createdAt - a.createdAt);
        return reply(res, 200, { groups });
      }

      if (action === 'create') {
        const name = clean(body.name);
        if (!name) return reply(res, 400, { error: 'Dê um nome para a turma.' });
        if (name.length > LIMITS.eventName) return reply(res, 400, { error: `Nome da turma passa de ${LIMITS.eventName} caracteres.` });
        if (hasLink(name)) return reply(res, 400, { error: 'Nome da turma não pode ter link nem e-mail.' });
        const existing = (await store.cmd('SMEMBERS', 'pz:groups')) || [];
        if (existing.length >= 20) return reply(res, 400, { error: 'Já existem 20 turmas. Apague alguma antes.' });
        const c = newCode();
        const now = Date.now();
        const meta = { name, closed: false, createdAt: now, expiresAt: now + TTL_MS };
        await store.pipe([['SET', kMeta(c), JSON.stringify(meta), 'EX', secondsLeft(meta, now)], ['SADD', 'pz:groups', c]]);
        return reply(res, 200, { group: { code: c, ...meta, count: 0 } });
      }

      if (!code) return reply(res, 400, { error: 'Turma inválida.' });

      if (action === 'delete') {
        await dropGroup(store, code); // apaga mesmo que os dados da turma já tenham vencido
        return reply(res, 200, { ok: true });
      }

      const meta = await readMeta(store, code);
      if (!meta) {
        await dropGroup(store, code);
        return reply(res, 404, { error: 'Essa turma não existe mais.' });
      }

      if (action === 'people') {
        // Trazer para a lista encerra a inscrição: ninguém entra depois e fica de fora do sorteio sem saber.
        if (body.closeAfter && !meta.closed) {
          meta.closed = true;
          await store.cmd('SET', kMeta(code), JSON.stringify(meta), 'EX', secondsLeft(meta));
        }
        return reply(res, 200, { group: { code, ...meta }, people: await readPeople(store, code) });
      }

      if (action === 'remove') {
        await store.cmd('HDEL', kPeople(code), clean(body.email).toLowerCase());
        return reply(res, 200, { ok: true });
      }

      if (action === 'close') {
        meta.closed = Boolean(body.closed);
        await store.cmd('SET', kMeta(code), JSON.stringify(meta), 'EX', secondsLeft(meta));
        return reply(res, 200, { group: { code, ...meta } });
      }

      return reply(res, 400, { error: 'Ação desconhecida.' });
    } catch {
      return reply(res, 502, { error: 'O banco das inscrições não respondeu. Tente de novo em instantes.' });
    }
  };
}

/**
 * Inscrição pública. Duas barreiras contra abuso e contra estourar a cota grátis do banco:
 * 1) em memória da instância, antes de tocar no banco: 60 pedidos por IP a cada 10 min;
 * 2) no banco, só para inscrições: 20 por IP por hora (IPv6 agrupado por /64).
 */
export function createJoinHandler({ env = process.env, store = createStore(env), joinsPerHour = 20, memLimit = 60 } = {}) {
  const joins = store ? storeWindow(store, { limit: joinsPerHour, windowSec: 3600 }) : null;
  const mem = memoryWindow({ limit: memLimit, windowMs: 10 * 60 * 1000 });
  return async function joinHandler(req, res) {
    if (req.method !== 'POST') return reply(res, 405, { error: 'Use POST.' });
    const ip = ipKey(clientIp(req));
    if (mem.hit(ip)) return reply(res, 429, { error: 'Muitos pedidos seguidos. Espere alguns minutos e tente de novo.' });
    if (!store) return reply(res, 503, NO_STORE);
    const body = readBody(req);
    if (!body) return reply(res, 400, { error: 'Pedido mal formado.' });
    const code = typeof body.code === 'string' && GROUP_CODE_RE.test(body.code) ? body.code : null;
    if (!code) return reply(res, 404, { error: 'Esse link de inscrição está incompleto. Peça o link de novo para quem organiza.' });

    try {
      if (body.action === 'join' && (await joins.hit(`pz:rl:join:${ip}`))) {
        return reply(res, 429, { error: 'Muitas inscrições seguidas desta rede. Espere um pouco e tente de novo.' });
      }
      const meta = await readMeta(store, code);
      if (!meta) return reply(res, 404, { error: 'Esse link de inscrição não existe ou a turma já foi sorteada.' });

      if (body.action === 'info') {
        const people = await readPeople(store, code);
        return reply(res, 200, { name: meta.name, closed: Boolean(meta.closed), count: people.length, names: people.map((p) => p.name.split(' ')[0]) });
      }

      if (body.action === 'join') {
        if (meta.closed) return reply(res, 409, { error: 'As inscrições desta turma já foram encerradas. Fale com quem organiza.' });
        const v = validatePerson(body, 'Inscrição');
        if (!v.ok) return reply(res, 400, { error: v.error.replace(/^Inscrição: /, '') });
        const p = v.data;
        if (hasLink(p.tip)) return reply(res, 400, { error: 'A dica não pode ter link nem e-mail. Descreva o presente com palavras.' });
        const people = await readPeople(store, code);
        if (people.length >= LIMITS.maxPeople) return reply(res, 409, { error: `A turma já tem ${LIMITS.maxPeople} pessoas, o máximo.` });
        const nk = p.name.toLocaleLowerCase('pt-BR');
        if (people.some((x) => x.name.toLocaleLowerCase('pt-BR') === nk)) return reply(res, 409, { error: DUP });

        // grava, alinha o prazo ao da turma e confere o teto no mesmo pedido ao banco
        const [added, , size] = await store.pipe([
          ['HSETNX', kPeople(code), p.email, JSON.stringify({ ...p, at: Date.now() })],
          ['EXPIRE', kPeople(code), secondsLeft(meta)],
          ['HLEN', kPeople(code)],
        ]);
        if (!Number(added)) return reply(res, 409, { error: DUP });
        if (Number(size) > LIMITS.maxPeople) {
          await store.cmd('HDEL', kPeople(code), p.email);
          return reply(res, 409, { error: `A turma já tem ${LIMITS.maxPeople} pessoas, o máximo.` });
        }
        return reply(res, 200, { ok: true, name: p.name.split(' ')[0], group: meta.name });
      }

      return reply(res, 400, { error: 'Ação desconhecida.' });
    } catch {
      return reply(res, 502, { error: 'Não deu para falar com o servidor agora. Tente de novo em instantes.' });
    }
  };
}
