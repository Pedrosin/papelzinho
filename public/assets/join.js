(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;
  const code = location.hash.replace(/^#/, '').trim().toLowerCase();

  function show(id) {
    for (const s of ['loading', 'fail', 'form-view', 'done']) $('#' + s).hidden = s !== id;
  }
  function fail(msg) {
    $('#fail-msg').textContent = msg;
    show('fail');
  }
  async function api(body) {
    const r = await fetch('/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, ...body }) });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  }

  function renderWho(names) {
    $('#who').hidden = !names.length;
    $('#who-count').textContent = names.length === 1 ? '1 pessoa' : `${names.length} pessoas`;
    $('#who-list').replaceChildren(...names.map((n) => {
      const s = document.createElement('span');
      s.className = 'chip';
      s.style.paddingRight = '14px';
      s.textContent = n;
      return s;
    }));
  }

  async function start() {
    if (!code) return fail('O link chegou incompleto. Peça o link de novo para quem organiza.');
    let r;
    try {
      r = await api({ action: 'info' });
    } catch {
      return fail('Sem conexão. Confira a internet e recarregue a página.');
    }
    if (!r.ok) return fail(r.data.error || 'Não deu para abrir o convite agora. Tente de novo em instantes.');
    const g = r.data;
    document.title = `Entrar no ${g.name}`;
    $('#g-name').textContent = g.name;
    renderWho(g.names || []);
    if (g.closed) {
      $('#join-form').hidden = true;
      $('#f-lede').textContent = 'As inscrições desta turma já foram encerradas. Se você ficou de fora, fale com quem organiza.';
    }
    show('form-view');
  }

  function err(msg) {
    const e = $('#join-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  $('#join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    err('');
    const name = $('#j-name').value.trim();
    const email = $('#j-mail').value.trim().toLowerCase();
    const tip = $('#j-tip').value.trim();
    if (!name) { err('Escreva seu nome.'); $('#j-name').focus(); return; }
    if (!EMAIL_RE.test(email)) { err('Esse e-mail não parece certo. Confira, porque é por ele que o papelzinho chega.'); $('#j-mail').focus(); return; }
    const btn = $('#join-btn');
    btn.disabled = true;
    btn.textContent = 'Entrando…';
    let r;
    try {
      r = await api({ action: 'join', name, email, tip });
    } catch {
      r = { ok: false, data: { error: 'Sem conexão. Confira a internet e tente de novo.' } };
    }
    btn.disabled = false;
    btn.textContent = 'Quero participar';
    if (!r.ok) return err(r.data.error || 'Não deu certo agora. Tente de novo.');
    $('#d-name').textContent = r.data.name;
    $('#d-group').textContent = r.data.group;
    $('#d-lede').textContent = `Sua inscrição no ${r.data.group} foi registrada com o e-mail ${email}.`;
    show('done');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  start();
})();
