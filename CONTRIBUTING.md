# Contribuindo

Valeu por querer ajudar. O Papelzinho tem uma promessa só: **ninguém fica sabendo quem tirou quem, nem quem organiza**. Toda mudança é revisada contra isso antes de qualquer outra coisa.

## Como mandar uma mudança

1. Faça um fork e crie uma branch a partir da `main`.
2. Rode local (`npm install`, `npm run dev`, senha `papelzinho-teste`). Os e-mails viram arquivos em `outbox/`, nada sai de verdade.
3. Rode `npm test` e escreva teste para o que mudou. O CI roda os mesmos testes no PR.
4. Abra o PR para a `main` explicando o que muda e por quê. A `main` só recebe PR aprovado pelo mantenedor com o CI passando. Cada merge vai para produção.

Não há segredo de produção no repositório, e nenhum é necessário para desenvolver. Ninguém de fora recebe as variáveis da Vercel.

## Regras de sigilo (motivo de recusa de PR)

- **Par sorteado e link do papelzinho nunca saem do servidor.** Não podem ir para log, resposta da API, banco, cookie, cabeçalho nem para a tela do organizador. A resposta do `/api/draw` só diz quem recebeu e-mail.
- **O resultado não é gravado.** Cada par vai criptografado (AES-256-GCM) dentro do link do e-mail. Nada de "guardar para reenviar".
- **O e-mail não traz o nome sorteado.** O nome só aparece na página do link.
- **Nada de `console.log` com dados de participante** (nome, e-mail, dica) nem com o corpo do pedido.
- **Separações que deixam alguém com menos de 2 opções continuam proibidas** (`checkRules` em `lib/core.js`): com 1 opção dá para deduzir o par.
- **Nada de dependência nova sem necessidade clara.** Ela roda com acesso à senha do Gmail.

## Regras de segurança

- A senha do organizador só trafega no login (`/api/session`). A sessão é um cookie `HttpOnly`. Nenhum segredo vai para `localStorage`, `sessionStorage` ou variável acessível pela página.
- Rota do organizador passa por `guard()` em `lib/handlers.js`.
- Texto que vai no e-mail é escapado e não aceita link (`hasLink`).
- Front sem script de terceiros: a CSP (`vercel.json`) só libera `script-src 'self'`.
- Workflow do GitHub Actions usa `pull_request`, nunca `pull_request_target`.

## Achou uma falha de segurança?

Não abra issue pública. Veja [SECURITY.md](SECURITY.md).
