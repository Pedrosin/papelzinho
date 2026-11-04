// O Gmail guarda cópia de tudo que sai pelo SMTP na pasta Enviados, e essa cópia tem o link
// do papelzinho. Para o dono da conta não ver o resultado sem querer, depois do envio
// as cópias são movidas para a Lixeira e apagadas de lá (IMAP, mesma senha de app).
// Só mexe nas mensagens deste sorteio, achadas pelo Message-ID que o próprio app gerou.
import { ImapFlow } from 'imapflow';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MESSAGE_ID_RE = /^<pz-[a-f0-9]{16}-\d{1,3}@papelzinho>$/;

export async function purgeSentCopies(env, messageIds, { attempts = 5, wait = 1500 } = {}) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: env.GMAIL_USER, pass: String(env.GMAIL_APP_PASSWORD).replace(/\s+/g, '') },
    logger: false,
  });
  await client.connect();
  try {
    const boxes = await client.list();
    const sent = boxes.find((b) => b.specialUse === '\\Sent')?.path;
    const trash = boxes.find((b) => b.specialUse === '\\Trash')?.path;
    if (!sent || !trash) throw new Error('Pastas Enviados/Lixeira não encontradas.');

    const pending = new Set(messageIds);
    const trashUids = [];
    let lock = await client.getMailboxLock(sent);
    try {
      for (let a = 0; a < attempts && pending.size; a++) {
        if (a) await sleep(wait);
        const uids = [];
        for (const id of [...pending]) {
          const found = await client.search({ gmraw: `rfc822msgid:${id.slice(1, -1)}` }, { uid: true });
          if (found && found.length) {
            uids.push(...found);
            pending.delete(id);
          }
        }
        if (uids.length) {
          const moved = await client.messageMove(uids, trash, { uid: true });
          if (moved?.uidMap) trashUids.push(...moved.uidMap.values());
        }
      }
    } finally {
      lock.release();
    }

    lock = await client.getMailboxLock(trash);
    try {
      if (trashUids.length) await client.messageDelete(trashUids, { uid: true });
      // garantia: se o servidor não devolveu o mapa de UIDs, procura na Lixeira
      for (const id of messageIds) {
        const left = await client.search({ gmraw: `in:trash rfc822msgid:${id.slice(1, -1)}` }, { uid: true });
        if (left && left.length) await client.messageDelete(left, { uid: true });
      }
    } finally {
      lock.release();
    }
    return { total: messageIds.length, removed: messageIds.length - pending.size };
  } finally {
    await client.logout().catch(() => {});
  }
}
