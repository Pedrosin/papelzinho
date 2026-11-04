// Servidor local para testar sem Vercel e sem Gmail.
// npm run dev → http://localhost:3000  (senha do organizador: papelzinho-teste)
// Os e-mails não saem: viram arquivos .html em ./outbox, com o link do papelzinho clicável.
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createDrawHandler, createRevealHandler, createPurgeHandler, gmailTransport } from './lib/handlers.js';
import { purgeSentCopies } from './lib/sent-copies.js';
import { createGroupsHandler, createJoinHandler } from './lib/groups.js';
import { createStore, memoryStore } from './lib/store.js';

const PORT = Number(process.env.PORT) || 3000;
const real = Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
const env = {
  GMAIL_USER: 'teste@exemplo.com',
  GMAIL_APP_PASSWORD: 'senha-de-teste-local',
  ORGANIZER_PASSWORD: 'papelzinho-teste',
  TOKEN_SECRET: 'segredo-so-para-teste-local',
  PUBLIC_URL: `http://localhost:${PORT}`,
  ...process.env,
};
const purge = createPurgeHandler({ env, purge: real ? purgeSentCopies : async (_e, ids) => ({ total: ids.length, removed: ids.length }) });

let n = 0;
const outboxTransport = () => ({
  verify: async () => {},
  async sendMail(m) {
    await mkdir('outbox', { recursive: true });
    const file = join('outbox', `${String(++n).padStart(3, '0')}-${m.to.address.replace(/[^a-z0-9@.]/gi, '_')}.html`);
    await writeFile(file, m.html, 'utf8');
  },
  close() {},
});

// Sem KV_REST_API_URL/TOKEN no ambiente, as inscrições ficam num banco em memória (somem ao reiniciar).
const store = createStore(env) || memoryStore();
const draw = createDrawHandler({ env, makeTransport: real ? gmailTransport : outboxTransport, store });
const groups = createGroupsHandler({ env, store });
const joinH = createJoinHandler({ env, store });
const reveal = createRevealHandler({ env });
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    req.body = Buffer.concat(chunks).toString('utf8');
    if (url.pathname === '/api/draw') return draw(req, res);
    if (url.pathname === '/api/reveal') return reveal(req, res);
    if (url.pathname === '/api/purge') return purge(req, res);
    if (url.pathname === '/api/groups') return groups(req, res);
    if (url.pathname === '/api/join') return joinH(req, res);
    res.statusCode = 404;
    return res.end();
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!extname(p)) p += '.html';
  const file = normalize(join('public', p));
  if (!file.startsWith('public')) { res.statusCode = 403; return res.end(); }
  try {
    const body = await readFile(file);
    res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('não encontrado');
  }
}).listen(PORT, () => {
  console.log(`Papelzinho em http://localhost:${PORT}  ·  senha: ${process.env.ORGANIZER_PASSWORD ? '(a do seu ambiente)' : env.ORGANIZER_PASSWORD}`);
  console.log(real ? 'Gmail REAL: os e-mails vão sair de verdade.' : 'Modo de teste: os e-mails viram arquivos em ./outbox');
});
