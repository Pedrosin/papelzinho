// E-mail que cada participante recebe. HTML em tabela com estilo inline (clientes de e-mail ignoram <style>).
// O nome sorteado NÃO vai no e-mail: só o link com o token.
import { escapeHtml as h, firstName, formatValue, formatWhen } from './core.js';

export function buildEmail({ giver, event, link, stamp }) {
  const when = formatWhen(event.date, event.time);
  const value = formatValue(event.value);
  const where = event.place || 'a combinar';
  const subject = `Seu papelzinho do ${event.name} chegou`;
  const fn = firstName(giver.name);

  const text = [
    `${fn}, seu papelzinho do ${event.name} chegou.`,
    '',
    'O sorteio foi feito. Abra o link quando estiver sozinho, porque o nome aparece na tela:',
    link,
    '',
    `Valor: ${value}`,
    `Quando: ${when}`,
    `Onde: ${where}`,
    event.msg ? `\nRecado: "${event.msg}"` : '',
    '',
    'Ninguém mais tem esse link. Não encaminhe este e-mail.',
    stamp ? `Sorteio de ${stamp}. Se chegar outro papelzinho deste amigo secreto, vale o mais recente.` : '',
  ].join('\n');

  const fact = (label, val) => `
    <td valign="top" style="padding:12px 14px;border:1px dashed #E2E5FA;font-family:Arial,Helvetica,sans-serif;">
      <div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#5C628F;font-weight:bold;">${label}</div>
      <div style="font-size:15px;color:#141633;font-weight:bold;padding-top:2px;">${h(val)}</div>
    </td>`;

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${h(subject)}</title></head>
<body style="margin:0;padding:0;background:#F6F7FC;">
<div style="display:none;max-height:0;overflow:hidden;">O sorteio foi feito. Abra seu papelzinho quando estiver sozinho.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F7FC;"><tr><td align="center" style="padding:28px 12px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E2E5FA;border-radius:8px;overflow:hidden;">
    <tr><td style="background:#2433C9;padding:28px 26px;font-family:Arial,Helvetica,sans-serif;">
      <div style="font-size:11px;letter-spacing:1.2px;text-transform:uppercase;font-weight:bold;color:#FFD84A;">${h(event.name)}</div>
      <div style="font-size:26px;line-height:1.15;font-weight:900;color:#FFFFFF;padding-top:10px;letter-spacing:-0.5px;">${h(fn)}, seu papelzinho chegou.</div>
    </td></tr>
    <tr><td style="padding:24px 26px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#141633;">
      <p style="margin:0 0 18px;">O sorteio foi feito. Abra o link quando estiver sozinho, porque o nome aparece na tela.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px;"><tr>
        ${fact('Valor', value)}${fact('Quando', when)}${fact('Onde', where)}
      </tr></table>
      ${event.msg ? `<p style="margin:0 0 18px;font-style:italic;color:#5C628F;">&ldquo;${h(event.msg)}&rdquo;</p>` : ''}
      <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#FF5C7C;border-radius:999px;">
        <a href="${h(link)}" style="display:inline-block;padding:14px 24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#141633;text-decoration:none;">Abrir meu papelzinho</a>
      </td></tr></table>
    </td></tr>
    <tr><td style="border-top:1px solid #E2E5FA;padding:14px 26px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#5C628F;">
      Ninguém mais tem esse link. Não encaminhe este e-mail.${stamp ? `<br>Sorteio de ${h(stamp)}. Se chegar outro papelzinho deste amigo secreto, vale o mais recente.` : ''}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  return { subject, text, html };
}
