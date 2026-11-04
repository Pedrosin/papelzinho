(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const first = (n) => String(n).split(' ')[0];

  function fail(msg) {
    $('#loading').hidden = true;
    $('#fail').hidden = false;
    $('#fail-msg').textContent = msg;
  }

  async function start() {
    // Tira o token da barra de endereço (e do histórico); guarda só nesta aba para sobreviver a um recarregar.
    let token = location.hash.replace(/^#/, '');
    try {
      if (token) sessionStorage.setItem('papelzinho:t', token);
      else token = sessionStorage.getItem('papelzinho:t') || '';
    } catch { /* sem armazenamento: segue com o que tiver */ }
    if (location.hash) history.replaceState(null, '', location.pathname);
    if (!token) return fail('O link chegou sem o papelzinho. Abra de novo pelo botão “Abrir meu papelzinho” do e-mail.');

    let res, data;
    try {
      res = await fetch('/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token }) });
      data = await res.json().catch(() => ({}));
    } catch {
      return fail('Sem conexão. Confira a internet e recarregue a página.');
    }
    if (!res.ok) return fail(data.error || 'Não deu para abrir este papelzinho. Abra de novo pelo botão do e-mail.');

    const g = first(data.giver);
    const r = first(data.receiver);
    document.title = `Papelzinho de ${g}`;
    $('#g-name').textContent = g;
    $('#to').textContent = `pra você, ${g}`;
    $('#r-name').textContent = data.receiver;
    $('#slip-event').textContent = data.event.name;
    $('#tip-label').textContent = data.tip ? `Dica de ${r}` : 'Dica de presente';
    $('#tip').textContent = data.tip || `${r} não deixou dica. Hora de investigar.`;
    $('#facts').replaceChildren(...[data.event.value, data.event.when, data.event.place].filter(Boolean).map((t) => {
      const s = document.createElement('span');
      s.textContent = t;
      return s;
    }));
    if (data.stamp) $('#stamp').textContent = `Sorteio de ${data.stamp}. Se chegou outro papelzinho deste amigo secreto, vale o mais recente.`;
    if (data.event.msg) {
      $('#msg').textContent = `“${data.event.msg}”`;
      $('#msg-card').hidden = false;
    }

    $('#loading').hidden = true;
    $('#ok').hidden = false;
  }

  $('#slip').addEventListener('click', () => {
    $('#stage').classList.add('open');
    $('#slip').setAttribute('aria-label', 'Papelzinho aberto');
  });
  $('#fold').addEventListener('click', () => {
    $('#stage').classList.remove('open');
    $('#slip').setAttribute('aria-label', 'Abrir papelzinho');
  });

  start();
})();
