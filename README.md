# Papelzinho

Sorteio de amigo secreto por e-mail. O organizador cadastra a turma, separa quem não pode se tirar e aperta um botão. Cada pessoa recebe um e-mail com um link que abre o próprio papelzinho. Ninguém, nem quem organiza, fica sabendo quem tirou quem.

## Como funciona

- O sorteio roda no servidor (função da Vercel), nunca no navegador do organizador.
- O resultado não é gravado em lugar nenhum. Cada par vai criptografado (AES-256-GCM) dentro do link do e-mail; só o servidor tem a chave para abrir.
- O e-mail não traz o nome sorteado. O nome só aparece na página do link, depois de tocar no papelzinho.
- A dica de presente de cada pessoa vai para quem a tirou.
- A resposta que volta para o organizador lista só quem recebeu o e-mail, sem par e sem link.
- O Gmail guarda cópia de tudo que sai na pasta **Enviados**. Logo depois do envio, o site apaga essas cópias (vão pra Lixeira e são excluídas de lá, via IMAP com a mesma senha de app). Só mexe nas mensagens do sorteio, achadas pelo Message-ID que o próprio app gera. A cópia do papelzinho do dono do Gmail fica, porque é a caixa de entrada dele. Se a faxina falhar, a tela avisa e ensina a apagar à mão sem abrir.
- Separações que deixariam alguém com uma única opção são recusadas: senão daria pra saber quem aquela pessoa tirou. Mínimo de 4 pessoas.
- O link sai da barra de endereço assim que a página abre.
- Se um e-mail se perder, não dá para reenviar: é preciso sortear de novo. Cada e-mail traz a data e hora do sorteio e vale o mais recente.

## Inscrição por link (opcional)

Em vez de digitar todo mundo, crie uma turma no painel **Inscrição por link** e mande o link `/entrar#código`. Cada pessoa coloca nome, e-mail e dica; quem tem o link vê só o primeiro nome de quem já entrou. No painel você clica em **Trazer inscritos para a lista** e segue normal (separações, sorteio).

- Precisa do banco gratuito **Upstash Redis**: na Vercel, **Storage → Create Database → Upstash for Redis**, conecte ao projeto e faça **Redeploy**. As variáveis `KV_REST_API_URL` e `KV_REST_API_TOKEN` entram sozinhas.
- O banco guarda só os inscritos, nunca o resultado. A lista é apagada quando o sorteio sai inteiro, ou sozinha em 60 dias.
- Com o banco ligado, o freio contra chute de senha passa a valer de verdade (5 erros por IP ou 30 no geral travam 15 minutos).

## Publicar na Vercel (grátis)

1. Entre em [vercel.com](https://vercel.com) com a conta do GitHub.
2. **Add New → Project → Import** o repositório `papelzinho`. Framework: **Other**. Não precisa mudar build.
3. Antes do Deploy, em **Environment Variables**, cadastre:

| Variável | O que é |
| --- | --- |
| `GMAIL_USER` | O Gmail que envia os e-mails, ex.: `voce@gmail.com` |
| `GMAIL_APP_PASSWORD` | Senha de app do Google (16 letras). Crie em [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords); a conta precisa ter verificação em duas etapas ligada. |
| `ORGANIZER_PASSWORD` | Senha que você digita no site para liberar o envio. Mínimo de 10 caracteres. |
| `TOKEN_SECRET` | Texto aleatório longo que vira a chave dos links. Não troque até o amigo secreto acabar: trocar invalida os links já enviados. |
| `PUBLIC_URL` | Opcional. Endereço fixo do site (ex.: `https://papelzinho.vercel.app`) para os links dos e-mails. |

4. **Deploy**. Mudou variável depois? Faça **Redeploy** para valer.

Limite do Gmail: cerca de 500 e-mails por dia.

## Rodar local

```bash
npm install
npm run dev
```

Abre em `http://localhost:3000`, senha `papelzinho-teste`. Os e-mails não saem: viram arquivos em `outbox/`, com o link do papelzinho funcionando. Com `GMAIL_USER` e `GMAIL_APP_PASSWORD` no ambiente, o envio é real.

```bash
npm test
```
