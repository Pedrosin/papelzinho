(() => {
  'use strict';
  const KEY = 'papelzinho:rascunho:v1';
  const HUES = ['#FFD84A', '#FF9FB1', '#9FE3C6', '#B9C2FF', '#FFC48A', '#C9F07A', '#F5B8FF', '#8FE1F2'];
  const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;
  const EVENT_FIELDS = ['name', 'value', 'date', 'time', 'place', 'msg'];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const first = (n) => n.split(' ')[0];

  let state = { people: [], excl: [], next: 1, event: { name: 'Amigo Secreto ' + new Date().getFullYear() } };
  let editingId = null;

  // ---------- rascunho local (nunca guarda a senha) ----------
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.people)) state = { people: s.people, excl: s.excl || [], next: s.next || 1, event: s.event || {}, lastDraw: s.lastDraw || '' };
      }
    } catch { /* sem armazenamento: segue sem rascunho */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignora */ }
  }

  const byId = (id) => state.people.find((p) => p.id === id);

  // ---------- regras: sorteio possível e imprevisível (mesma conta do servidor, lib/core.js) ----------
  const MIN_PEOPLE = 4;
  const MIN_TARGETS = 2;
  function matching(ok) {
    const n = ok.length;
    const matchR = new Array(n).fill(-1);
    const aug = (i, seen) => {
      for (let j = 0; j < n; j++) {
        if (!ok[i][j] || seen[j]) continue;
        seen[j] = 1;
        if (matchR[j] < 0 || aug(matchR[j], seen)) { matchR[j] = i; return true; }
      }
      return false;
    };
    for (let i = 0; i < n; i++) if (!aug(i, new Uint8Array(n))) return null;
    const m = new Array(n);
    matchR.forEach((i, j) => { m[i] = j; });
    return m;
  }
  function scc(adj) {
    const n = adj.length, idx = new Array(n).fill(-1), low = new Array(n).fill(0), comp = new Array(n).fill(-1), on = new Uint8Array(n), st = [];
    let k = 0, c = 0;
    const visit = (v) => {
      idx[v] = low[v] = k++; st.push(v); on[v] = 1;
      for (const w of adj[v]) {
        if (idx[w] < 0) { visit(w); low[v] = Math.min(low[v], low[w]); } else if (on[w]) low[v] = Math.min(low[v], idx[w]);
      }
      if (low[v] === idx[v]) { let w; do { w = st.pop(); on[w] = 0; comp[w] = c; } while (w !== v); c++; }
    };
    for (let v = 0; v < n; v++) if (idx[v] < 0) visit(v);
    return comp;
  }
  /** null = impossível; senão, para cada pessoa, quantas ela pode de fato tirar. */
  function reachable(n, forbidden) {
    const ok = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i !== j && !forbidden.has(i + '-' + j)));
    const m = matching(ok);
    if (!m) return null;
    const adj = Array.from({ length: 2 * n }, () => []);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (ok[i][j]) (m[i] === j ? adj[n + j].push(i) : adj[i].push(n + j));
    const comp = scc(adj);
    return Array.from({ length: n }, (_, i) => { let c = 0; for (let j = 0; j < n; j++) if (ok[i][j] && (m[i] === j || comp[i] === comp[n + j])) c++; return c; });
  }
  function forbiddenIdx() {
    const idx = new Map(state.people.map((p, i) => [p.id, i]));
    const f = new Set();
    for (const [a, b] of state.excl) {
      const i = idx.get(a), j = idx.get(b);
      if (i === undefined || j === undefined) continue;
      f.add(i + '-' + j); f.add(j + '-' + i);
    }
    return f;
  }

  // ---------- render ----------
  const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  function render() {
    const P = state.people;
    state.excl = state.excl.filter(([a, b]) => byId(a) && byId(b));

    $('#count').textContent = P.length === 1 ? '1 pessoa' : `${P.length} pessoas`;
    $('#people').innerHTML = P.length
      ? P.map((p, i) => `<li class="person${p.id === editingId ? ' editing' : ''}">
          <span class="ava" style="background:${HUES[i % HUES.length]}">${esc((p.name[0] || '?').toUpperCase())}</span>
          <span class="p-name">${esc(p.name)}</span>
          <span class="p-actions">
            <button class="icon-btn" type="button" data-edit="${p.id}" aria-label="Editar ${esc(p.name)}">${ICON_EDIT}</button>
            <button class="icon-btn del" type="button" data-del="${p.id}" aria-label="Remover ${esc(p.name)}">×</button>
          </span>
          <span class="p-meta"><span class="mail">${esc(p.email)}</span><span class="tip ${p.tip ? '' : 'empty'}">${p.tip ? 'Dica: ' + esc(p.tip) : 'sem dica'}</span></span>
        </li>`).join('')
      : '<li class="empty-list">Ninguém ainda. Escreva o nome e o e-mail da primeira pessoa aqui embaixo.</li>';

    $('#chips').innerHTML = state.excl.length
      ? state.excl.map(([a, b], k) => `<span class="chip">${esc(first(byId(a).name))}<span class="x">⇄</span>${esc(first(byId(b).name))}<button type="button" data-unex="${k}" aria-label="Desfazer separação">×</button></span>`).join('')
      : '<span style="color:var(--muted);font-size:14px">Ninguém separado. Todo mundo pode tirar todo mundo. Use para casais, irmãos ou quem se tirou ano passado.</span>';

    const opts = P.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    const a = $('#ex-a').value, b = $('#ex-b').value;
    $('#ex-a').innerHTML = opts; $('#ex-b').innerHTML = opts;
    if (a && byId(+a)) $('#ex-a').value = a;
    if (b && byId(+b)) $('#ex-b').value = b; else if (P[1]) $('#ex-b').value = P[1].id;
    $('#ex-add').disabled = P.length < 2;

    const v = $('#verdict');
    const n = P.length;
    let ok = false;
    if (n < MIN_PEOPLE) {
      v.className = 'verdict no';
      v.textContent = `Precisa de pelo menos ${MIN_PEOPLE} pessoas pra sortear${n ? ` (falta${MIN_PEOPLE - n > 1 ? 'm' : ''} ${MIN_PEOPLE - n})` : ''}.`;
    } else {
      const reach = reachable(n, forbiddenIdx());
      const forced = reach ? P.filter((_, i) => reach[i] < MIN_TARGETS).map((p) => first(p.name)) : [];
      if (!reach) {
        v.className = 'verdict no';
        v.textContent = 'Com essas separações não existe sorteio possível. Desfaça alguma.';
      } else if (forced.length) {
        v.className = 'verdict no';
        const names = forced.length > 1 ? `${forced.slice(0, -1).join(', ')} e ${forced[forced.length - 1]}` : forced[0];
        v.textContent = `Com essas separações dá pra adivinhar quem ${names} ${forced.length > 1 ? 'vão' : 'vai'} tirar. Desfaça alguma para o sorteio continuar secreto.`;
      } else {
        ok = true;
        v.className = 'verdict';
        v.textContent = '✓ Sorteio possível e secreto.';
      }
    }

    const btn = $('#go-draw');
    disarm();
    btn.disabled = !ok;
    btn.textContent = n >= MIN_PEOPLE ? `Sortear e enviar ${n} papeizinhos` : 'Sortear e enviar';
    const last = $('#last-draw');
    last.hidden = !state.lastDraw;
    if (state.lastDraw) last.textContent = `Você já sorteou em ${state.lastDraw}. Sortear de novo manda um papelzinho novo pra todo mundo, e vale o mais recente.`;
    save();
  }

  // ---------- participantes ----------
  function showAddError(msg) {
    const e = $('#add-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  }
  function resetForm() {
    editingId = null;
    $('#add-form').reset();
    $('#add-submit').textContent = 'Adicionar pessoa';
    $('#add-cancel').hidden = true;
    showAddError('');
  }

  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = clean($('#add-name').value);
    const email = clean($('#add-mail').value).toLowerCase();
    const tip = clean($('#add-tip').value);
    if (!name) return showAddError('Escreva o nome.');
    if (!EMAIL_RE.test(email)) return showAddError('Esse e-mail não parece certo.');
    const others = state.people.filter((p) => p.id !== editingId);
    const dupName = others.find((p) => p.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'));
    if (dupName) return showAddError(`Já tem ${dupName.name} na lista. Use o sobrenome para diferenciar.`);
    const dupMail = others.find((p) => p.email === email);
    if (dupMail) return showAddError(`Esse e-mail já é de ${dupMail.name}. Cada pessoa precisa de um e-mail só dela.`);
    if (state.people.length >= 60 && editingId === null) return showAddError('No máximo 60 pessoas por sorteio.');

    if (editingId !== null) Object.assign(byId(editingId), { name, email, tip });
    else state.people.push({ id: state.next++, name, email, tip });
    resetForm();
    render();
    $('#add-name').focus();
  });
  $('#add-cancel').addEventListener('click', () => { resetForm(); render(); });

  $('#people').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    const edit = e.target.closest('[data-edit]');
    if (del) {
      const id = +del.dataset.del;
      state.people = state.people.filter((p) => p.id !== id);
      if (editingId === id) resetForm();
      render();
    } else if (edit) {
      const p = byId(+edit.dataset.edit);
      editingId = p.id;
      $('#add-name').value = p.name;
      $('#add-mail').value = p.email;
      $('#add-tip').value = p.tip;
      $('#add-submit').textContent = 'Salvar alteração';
      $('#add-cancel').hidden = false;
      showAddError('');
      render();
      $('#add-name').focus();
    }
  });

  // ---------- separações ----------
  $('#chips').addEventListener('click', (e) => {
    const d = e.target.closest('[data-unex]');
    if (!d) return;
    state.excl.splice(+d.dataset.unex, 1);
    render();
  });
  $('#ex-add').addEventListener('click', () => {
    const a = +$('#ex-a').value, b = +$('#ex-b').value;
    if (!a || !b || a === b) return;
    if (state.excl.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) return;
    state.excl.push([a, b]);
    render();
  });

  // ---------- evento ----------
  for (const f of EVENT_FIELDS) {
    const el = $('#ev-' + f);
    el.value = state.event?.[f] || '';
    el.addEventListener('input', () => { state.event[f] = el.value; save(); });
  }

  $('#clear-all').addEventListener('click', () => {
    const b = $('#clear-all');
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = 'clique de novo para apagar tudo';
      setTimeout(() => { b.dataset.armed = ''; b.textContent = 'começar do zero'; }, 4000);
      return;
    }
    try { localStorage.removeItem(KEY); } catch { /* ignora */ }
    location.reload();
  });

  // ---------- sortear ----------
  let armTimer = null;
  function disarm() {
    clearTimeout(armTimer);
    const btn = $('#go-draw');
    btn.classList.remove('armed');
    btn.dataset.armed = '';
  }
  function showDrawError(msg) {
    const e = $('#draw-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  }

  $('#go-draw').addEventListener('click', () => {
    const btn = $('#go-draw');
    showDrawError('');
    if (!$('#ev-pass').value) { showDrawError('Digite a senha do organizador.'); $('#ev-pass').focus(); return; }
    if (editingId !== null) { showDrawError('Termine de salvar a alteração da pessoa antes de sortear.'); return; }
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1';
      btn.classList.add('armed');
      btn.textContent = `Confirma? Clique de novo para mandar ${state.people.length} e-mails`;
      armTimer = setTimeout(render, 6000);
      return;
    }
    disarm();
    send();
  });

  function setSent(phase) {
    $('#s-setup').hidden = phase !== 'setup';
    $('#s-sent').hidden = phase === 'setup';
    $('#draft-note').hidden = phase !== 'setup';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function send() {
    const P = state.people;
    const idx = new Map(P.map((p, i) => [p.id, i]));
    const payload = {
      password: $('#ev-pass').value,
      participants: P.map(({ name, email, tip }) => ({ name, email, tip })),
      exclusions: state.excl.map(([a, b]) => [idx.get(a), idx.get(b)]),
      event: Object.fromEntries(EVENT_FIELDS.map((f) => [f, clean($('#ev-' + f).value)])),
    };

    setSent('sending');
    $('#sent-h1').innerHTML = 'Dobrando os <em>papeizinhos…</em>';
    $('#sent-lede').textContent = 'Sorteando e enviando os e-mails. Não feche esta página.';
    $('#sent-title').textContent = 'Enviando…';
    $('#sent-count').textContent = '';
    $('#progress').className = 'progress busy';
    $('#progress i').style.width = '';
    $('#sent').innerHTML = P.map((p) => `<li><span class="who">${esc(p.name)}</span><span class="status">na fila</span><span class="addr">${esc(p.email)}</span></li>`).join('');
    $('#sent-note').hidden = true;
    $('#purge').hidden = true;
    $('#back').hidden = true;

    const UNSURE = ' Pode ser que parte dos e-mails tenha saído. Pergunte à turma antes de sortear de novo; se sortear, vale o papelzinho mais recente.';
    let res, data;
    try {
      res = await fetch('/api/draw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      data = await res.json().catch(() => ({}));
    } catch {
      setSent('setup');
      showDrawError('A conexão caiu durante o sorteio.' + UNSURE);
      return;
    }
    if (!res.ok || !Array.isArray(data.sent)) {
      setSent('setup');
      // stage "before" = o servidor recusou antes de mandar qualquer coisa
      if (data.stage === 'before') showDrawError(data.error + ' Nenhum e-mail foi enviado.');
      else showDrawError(`O servidor não respondeu direito (erro ${res.status}).` + UNSURE);
      if (res.status === 401) $('#ev-pass').select();
      return;
    }

    const password = $('#ev-pass').value;
    $('#ev-pass').value = '';
    state.lastDraw = data.stamp || new Date().toLocaleString('pt-BR');
    save();
    const total = data.sent.length;
    const okCount = data.sent.filter((r) => r.ok).length;
    const hour = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    $('#progress').className = 'progress';
    $('#progress i').style.width = (okCount / total) * 100 + '%';
    $('#sent-count').textContent = `${okCount} de ${total}`;
    $('#sent').innerHTML = data.sent.map((r) => `<li>
        <span class="who">${esc(r.name)}</span>
        <span class="status ${r.ok ? 'ok' : 'bad'}">${r.ok ? 'enviado ' + hour : 'falhou'}</span>
        <span class="addr">${esc(r.email)}</span>
        ${r.ok ? '' : `<span class="why">${esc(r.reason || '')}</span>`}
      </li>`).join('');

    if (okCount === total) {
      $('#sent-h1').innerHTML = 'Papeizinhos <em>a caminho.</em>';
      $('#sent-lede').textContent = 'Cada pessoa vai receber um e-mail com um link para abrir o próprio papelzinho.';
      $('#sent-title').textContent = 'Todos enviados';
    } else {
      $('#sent-h1').innerHTML = `${total - okCount} papelzinho${total - okCount > 1 ? 's' : ''} <em>não ${total - okCount > 1 ? 'saíram' : 'saiu'}.</em>`;
      $('#sent-lede').textContent = 'Como o resultado não fica guardado, não dá para reenviar só pra quem falhou. Corrija o e-mail e sorteie de novo: todo mundo recebe um papelzinho novo. Avise a turma que vale só o e-mail mais recente.';
      $('#sent-title').textContent = 'Envio parcial';
    }
    $('#sent-note').hidden = false;
    $('#back').hidden = false;
    purgeCopies(password, data.copies || []);
  }

  // O Gmail guarda cópia dos e-mails em Enviados; o servidor apaga essas cópias para o dono da conta não ver.
  async function purgeCopies(password, copies) {
    const box = $('#purge');
    if (!copies.length) { box.hidden = true; return; }
    box.hidden = false;
    box.className = 'verdict';
    box.textContent = 'Apagando as cópias da pasta Enviados do seu Gmail… não abra o Gmail ainda.';
    let ok = false, info = {};
    try {
      const r = await fetch('/api/purge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, copies }) });
      info = await r.json().catch(() => ({}));
      ok = r.ok && info.removed === info.total;
    } catch { /* cai no aviso abaixo */ }
    if (ok) {
      box.textContent = '✓ Cópias apagadas da pasta Enviados. Pode abrir o Gmail tranquilo.';
    } else {
      box.className = 'verdict no';
      box.textContent = `Não consegui apagar ${info.total ? `${info.total - (info.removed || 0)} de ${info.total} cópias` : 'as cópias'} da pasta Enviados do Gmail. Para não ver o resultado: na busca do Gmail, digite "in:sent Seu papelzinho", marque todas sem abrir e exclua; depois esvazie a Lixeira.`;
    }
  }

  $('#back').addEventListener('click', () => { setSent('setup'); render(); });

  load();
  for (const f of EVENT_FIELDS) $('#ev-' + f).value = state.event?.[f] || '';
  render();
})();
