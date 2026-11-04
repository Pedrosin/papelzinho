// Banco das inscrições: Upstash Redis pela API REST (sem dependência).
// Na Vercel, a integração do Upstash cria KV_REST_API_URL e KV_REST_API_TOKEN sozinha.
// Guarda só a lista de inscritos de cada turma. Nunca guarda resultado de sorteio.

// Aceita os nomes com prefixo que a Vercel cria quando o banco é conectado com "Custom Prefix"
// (ex.: STORAGE_KV_REST_API_URL). O token sai do mesmo prefixo da URL; nunca o READ_ONLY.
export function storeConfig(env) {
  const keys = Object.keys(env).filter((k) => env[k]);
  const pick = (re) => keys.filter((k) => re.test(k)).sort((a, b) => a.length - b.length)[0];
  const urlKey = pick(/^KV_REST_API_URL$/) || pick(/^UPSTASH_REDIS_REST_URL$/) || pick(/_KV_REST_API_URL$/) || pick(/_REDIS_REST_URL$/);
  if (!urlKey) return null;
  const url = env[urlKey];
  const token = env[urlKey.replace(/URL$/, 'TOKEN')];
  return /^https:\/\//.test(url) && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

/** Cliente mínimo: cmd('SET','k','v') e pipe([['INCR','k'],['EXPIRE','k',60]]). */
export function createStore(env, fetchImpl = globalThis.fetch) {
  const cfg = storeConfig(env);
  if (!cfg) return null;
  const call = async (path, body) => {
    const r = await fetchImpl(cfg.url + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data) throw new Error(`banco respondeu ${r.status}`);
    return data;
  };
  return {
    async cmd(...args) {
      const d = await call('', args.map(String));
      if (d.error) throw new Error(d.error);
      return d.result;
    },
    async pipe(cmds) {
      const d = await call('/pipeline', cmds.map((c) => c.map(String)));
      return d.map((x) => {
        if (x.error) throw new Error(x.error);
        return x.result;
      });
    },
  };
}

/** Redis de mentira em memória, com os comandos que o app usa. Para testes e servidor local. */
export function memoryStore() {
  const data = new Map();
  const exp = new Map();
  const alive = (k) => {
    if (exp.has(k) && exp.get(k) <= Date.now()) { data.delete(k); exp.delete(k); }
    return data.has(k);
  };
  const run = (c, ...a) => {
    const k = a[0];
    switch (c.toUpperCase()) {
      case 'GET': return alive(k) ? data.get(k) : null;
      case 'SET': {
        if (a.includes('NX') && alive(k)) return null;
        // SET sem KEEPTTL zera o prazo, igual ao Redis
        exp.delete(k);
        data.set(k, String(a[1]));
        const ex = a.indexOf('EX');
        if (ex > 0) exp.set(k, Date.now() + Number(a[ex + 1]) * 1000); else exp.delete(k);
        return 'OK';
      }
      case 'DEL': { let n = 0; for (const x of a) if (alive(x)) { data.delete(x); exp.delete(x); n++; } return n; }
      case 'INCR': { const v = (alive(k) ? Number(data.get(k)) : 0) + 1; data.set(k, String(v)); return v; }
      case 'DECR': { const v = (alive(k) ? Number(data.get(k)) : 0) - 1; data.set(k, String(v)); return v; }
      case 'TTL': return !alive(k) ? -2 : exp.has(k) ? Math.ceil((exp.get(k) - Date.now()) / 1000) : -1;
      case 'EXPIRE':
        if (!alive(k) || (a.includes('NX') && exp.has(k))) return 0;
        exp.set(k, Date.now() + Number(a[1]) * 1000);
        return 1;
      case 'HSETNX': { if (!alive(k)) data.set(k, new Map()); const h = data.get(k); if (h.has(a[1])) return 0; h.set(a[1], String(a[2])); return 1; }
      case 'HSET': { if (!alive(k)) data.set(k, new Map()); data.get(k).set(a[1], String(a[2])); return 1; }
      case 'HDEL': { if (!alive(k)) return 0; return data.get(k).delete(a[1]) ? 1 : 0; }
      case 'HLEN': return alive(k) ? data.get(k).size : 0;
      case 'HGETALL': return alive(k) ? [...data.get(k)].flat() : [];
      case 'SADD': { if (!alive(k)) data.set(k, new Set()); const s = data.get(k); const had = s.has(a[1]); s.add(a[1]); return had ? 0 : 1; }
      case 'SREM': return alive(k) && data.get(k).delete(a[1]) ? 1 : 0;
      case 'SMEMBERS': return alive(k) ? [...data.get(k)] : [];
      default: throw new Error('comando não suportado no banco de teste: ' + c);
    }
  };
  return {
    async cmd(...a) { return run(...a.map(String)); },
    async pipe(cmds) { return cmds.map((c) => run(...c.map(String))); },
  };
}

/**
 * Limite por janela fixa guardado no banco (vale entre todas as instâncias da Vercel).
 * hit(key) conta e devolve true se passou do limite. SET NX EX cria a chave já com prazo
 * (comando padrão, sem depender de EXPIRE ... NX). Chave já estourada fica marcada em memória
 * e não gasta mais comandos do banco até a janela acabar.
 */
export function storeWindow(store, { limit, windowSec, now = () => Date.now() }) {
  const blockedUntil = new Map();
  return {
    async hit(key) {
      const t = now();
      if ((blockedUntil.get(key) || 0) > t) return true;
      const [, n] = await store.pipe([['SET', key, '0', 'EX', windowSec, 'NX'], ['INCR', key]]);
      if (Number(n) > limit) {
        if (blockedUntil.size > 5000) blockedUntil.clear();
        blockedUntil.set(key, t + windowSec * 1000);
        return true;
      }
      return false;
    },
  };
}
