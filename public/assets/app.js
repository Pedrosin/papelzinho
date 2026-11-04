(() => {
  'use strict';
  const KEY = 'papelzinho:rascunho:v1';
  const PASS_KEY = 'papelzinho:senha';
  const HUES = ['#FFD84A', '#FF9FB1', '#9FE3C6', '#B9C2FF', '#FFC48A', '#C9F07A', '#F5B8FF', '#8FE1F2'];
  const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;
  const EVENT_FIELDS = ['name', 'value', 'date', 'time', 'place', 'msg'];
  const MIN_PEOPLE = 4;
  const MIN_TARGETS = 2;
  const WEEK = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ');
  const first = (n) => n.split(' ')[0];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const listNames = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} e ${a[a.length - 1]}` : a[0]);

  let state = { people: [], excl: [], next: 1, event: { name: 'Amigo Secreto ' + new Date().getFullYear() }, mode: 'type' };
  let editingId = null;
  let password = '';
  let storeReady = null; // banco das inscrições: true ligado, false falta ligar
  let groups = [];
  let current = null;
  let showNew = false;

  // ---------- rascunho local (nunca guarda a senha) ----------
  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.people)) state = { people: s.people, excl: s.excl || [], next: s.next || 1, event: s.event || {}, lastDraw: s.lastDraw || '', importedGroup: s.importedGroup || '', mode: s.mode === 'link' ? 'link' : 'type' };
      }
    } catch { /* sem armazenamento: segue sem rascunho */ }
    try { password = sessionStorage.getItem(PASS_KEY) || ''; } catch { /* ignora */ }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignora */ }
  }
  const byId = (id) => state.people.find((p) => p.id === id);

  // ---------- telas ----------
  function phase(name) {
    $('#s-lock').hidden = name !== 'lock';
    $('#s-setup').hidden = name !== 'setup';
    $('#s-sent').hidden = name !== 'sent';
    $('#logout').hidden = name === 'lock';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function post(path, body) {
    let r, data;
    try {
      r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, ...body }) });
      data = await r.json().catch(() => ({}));
    } catch {
      return { ok: false, status: 0, data: { error: 'Sem conexão com o servidor. Confira a internet e tente de novo.' } };
    }
    return { ok: r.ok, status: r.status, data };
  }

  function lock(msg) {
    password = '';
    try { sessionStorage.removeItem(PASS_KEY); } catch { /* ignora */ }
    const e = $('#lock-error');
    e.textContent = msg || '';
    e.hidden = !msg;
    phase('lock');
    setTimeout(() => $('#lock-pass').focus(), 50);
  }

  /** Confere a senha listando as turmas (sem efeito colateral). */
  async function enter(silent) {
    const r = await post('/api/groups', { action: 'list' });
    if (r.status === 401) return lock(silent ? '' : 'Senha errada.');
    if (r.status === 429) return lock(r.data.error);
    if (r.ok) {
      storeReady = true;
      groups = r.data.groups || [];
    } else if (r.status === 503 && r.data.needsStore) {
      storeReady = false; // senha certa, só falta o banco das inscrições
    } else {
      return lock(r.data.error || `O servidor respondeu com erro ${r.status}.`);
    }
    try { sessionStorage.setItem(PASS_KEY, password); } catch { /* ignora */ }
    phase('setup');
    render();
  }

  $('#lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    password = $('#lock-pass').value;
    if (!password) return lock('Digite a senha.');
    const b = $('#lock-btn');
    b.disabled = true;
    b.textContent = 'Conferindo…';
    await enter(false);
    b.disabled = false;
    b.textContent = 'Entrar';
    $('#lock-pass').value = '';
  });
  $('#logout').addEventListener('click', () => lock(''));

  // ---------- regras: sorteio possível e imprevisível (mesma conta do servidor, lib/core.js) ----------
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

  /** Situação do sorteio: { ok, problem } — problem é o motivo em uma frase. */
  function drawStatus() {
    const n = state.people.length;
    if (n < MIN_PEOPLE) return { ok: false, problem: n ? `Faltam ${plural(MIN_PEOPLE - n, 'pessoa', 'pessoas')} na lista (o mínimo é ${MIN_PEOPLE}).` : `Coloque pelo menos ${MIN_PEOPLE} pessoas no passo 2.` };
    const reach = reachable(n, forbiddenIdx());
    if (!reach) return { ok: false, problem: 'Com as separações do passo 3 não existe sorteio possível. Desfaça alguma.' };
    const forced = state.people.filter((_, i) => reach[i] < MIN_TARGETS).map((p) => first(p.name));
    if (forced.length) return { ok: false, problem: `Com as separações do passo 3 dá pra adivinhar quem ${listNames(forced)} ${forced.length > 1 ? 'vão' : 'vai'} tirar. Desfaça alguma.` };
    if (editingId !== null) return { ok: false, problem: 'Termine de salvar a alteração da pessoa no passo 2.' };
    return { ok: true };
  }

  function whenText() {
    const d = $('#ev-date').value, t = $('#ev-time').value;
    if (!d) return '';
    const [y, m, dd] = d.split('-').map(Number);
    return `${WEEK[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()]}, ${String(dd).padStart(2, '0')}/${String(m).padStart(2, '0')}${t ? ' · ' + t : ''}`;
  }

  // ---------- render ----------
  const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  function render() {
    const P = state.people;
    const n = P.length;
    state.excl = state.excl.filter(([a, b]) => byId(a) && byId(b));

    // passo 2
    $('#count').textContent = plural(n, 'pessoa', 'pessoas');
    const link = state.mode === 'link';
    $('#tab-type').setAttribute('aria-selected', String(!link));
    $('#tab-link').setAttribute('aria-selected', String(link));
    $('#add-form').hidden = link;
    $('#link-box').hidden = !link;
    if (link) renderLink();
    $('#people').innerHTML = n
      ? P.map((p, i) => `<li class="person${p.id === editingId ? ' editing' : ''}">
          <span class="ava" style="background:${HUES[i % HUES.length]}">${esc((p.name[0] || '?').toUpperCase())}</span>
          <span class="p-name">${esc(p.name)}</span>
          <span class="p-actions">
            <button class="icon-btn" type="button" data-edit="${p.id}" aria-label="Editar ${esc(p.name)}">${ICON_EDIT}</button>
            <button class="icon-btn del" type="button" data-del="${p.id}" aria-label="Remover ${esc(p.name)}">×</button>
          </span>
          <span class="p-meta"><span class="mail">${esc(p.email)}</span><span class="tip ${p.tip ? '' : 'empty'}">${p.tip ? 'Dica: ' + esc(p.tip) : 'sem dica'}</span></span>
        </li>`).join('')
      : `<li class="empty-list">${link ? 'Os inscritos aparecem aqui quando você clicar em “Trazer inscritos pra lista”.' : 'Ninguém ainda. Escreva o nome e o e-mail da primeira pessoa aqui em cima.'}</li>`;

    // passo 3: só aparece com gente suficiente
    const enough = n >= MIN_PEOPLE;
    $('#excl-wait').hidden = enough;
    $('#excl-body').hidden = !enough;
    $('#chips').innerHTML = state.excl.length
      ? state.excl.map(([a, b], k) => `<span class="chip">${esc(first(byId(a).name))}<span class="x">⇄</span>${esc(first(byId(b).name))}<button type="button" data-unex="${k}" aria-label="Desfazer separação">×</button></span>`).join('')
      : '<span class="hint" style="margin:0">Ninguém separado: todo mundo pode tirar todo mundo.</span>';
    const opts = P.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    const a = $('#ex-a').value, b = $('#ex-b').value;
    $('#ex-a').innerHTML = opts; $('#ex-b').innerHTML = opts;
    if (a && byId(+a)) $('#ex-a').value = a;
    if (b && byId(+b)) $('#ex-b').value = b; else if (P[1]) $('#ex-b').value = P[1].id;

    const st = drawStatus();
    const v = $('#verdict');
    if (enough) {
      const exclProblem = !st.ok && /passo 3/.test(st.problem || '');
      v.className = exclProblem ? 'verdict no' : 'verdict';
      v.textContent = exclProblem ? st.problem.replace('Com as separações do passo 3', 'Com essas separações') : '✓ Sorteio possível e secreto.';
    }

    // passo 4
    const ev = (f) => clean($('#ev-' + f).value);
    const chips = [
      [plural(n, 'pessoa', 'pessoas'), n >= MIN_PEOPLE],
      ...(state.excl.length ? [[plural(state.excl.length, 'separação', 'separações'), true]] : []),
      [ev('value') ? `R$ ${ev('value').replace(/^r\$\s*/i, '')}` : 'valor livre', Boolean(ev('value'))],
      [whenText() || 'sem data', Boolean(whenText())],
      [ev('place') || 'sem local', Boolean(ev('place'))],
    ];
    $('#summary').innerHTML = chips.map(([t, filled]) => `<span class="${filled ? '' : 'miss'}">${esc(t)}</span>`).join('');
    const why = $('#why-not');
    why.hidden = st.ok;
    why.textContent = st.ok ? '' : st.problem;
    const btn = $('#go-draw');
    disarm();
    btn.disabled = !st.ok;
    btn.textContent = st.ok ? `Sortear e enviar ${n} papeizinhos` : 'Sortear e enviar';
    const last = $('#last-draw');
    last.hidden = !state.lastDraw;
    if (state.lastDraw) last.textContent = `Você já sorteou em ${state.lastDraw}. Sortear de novo manda um papelzinho novo pra todo mundo, e vale o mais recente.`;
    save();
  }

  // ---------- passo 2: digitar ----------
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
  function setMode(mode) {
    state.mode = mode;
    if (mode === 'link' && editingId !== null) resetForm();
    render();
  }
  $('#tab-type').addEventListener('click', () => setMode('type'));
  $('#tab-link').addEventListener('click', () => setMode('link'));

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
      state.mode = 'type';
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

  // ---------- passo 2: mandar link ----------
  function gError(msg) {
    const e = $('#g-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  }
  async function gApi(body) {
    gError('');
    const r = await post('/api/groups', body);
    if (r.status === 401) { lock('A senha não confere mais. Entre de novo.'); return null; }
    if (!r.ok) {
      if (r.data.needsStore) storeReady = false;
      gError(r.data.needsStore
        ? 'Para mandar link, falta ligar o banco gratuito na Vercel: Storage → Upstash for Redis → conectar ao projeto e fazer Redeploy.'
        : r.data.error || `Erro ${r.status}.`);
      return null;
    }
    storeReady = true;
    return r.data;
  }
  const joinLink = (code) => `${location.origin}/entrar#${code}`;

  function renderLink() {
    if (storeReady === false) {
      gError('Para mandar link, falta ligar o banco gratuito na Vercel: Storage → Upstash for Redis → conectar ao projeto e fazer Redeploy.');
      $('#g-intro').hidden = true;
      $('#g-new').hidden = true;
      $('#g-detail').hidden = true;
      return;
    }
    if (!groups.some((g) => g.code === current)) current = groups[0]?.code || null;
    const g = groups.find((x) => x.code === current);
    $('#g-intro').hidden = Boolean(g) && !showNew;
    $('#g-new').hidden = Boolean(g) && !showNew;
    if (!$('#g-new-name').value) $('#g-new-name').value = clean($('#ev-name').value);
    $('#g-detail').hidden = !g;
    if (!g) return;
    const sel = $('#g-select');
    sel.hidden = groups.length < 2;
    sel.innerHTML = groups.map((x) => `<option value="${x.code}">${esc(x.name)} · ${plural(x.count, 'inscrito', 'inscritos')}</option>`).join('');
    sel.value = current;
    $('#g-link').value = joinLink(g.code);
    $('#g-status').innerHTML = `<b>${esc(plural(g.count, 'inscrito', 'inscritos'))}</b> · ${g.closed ? 'inscrições encerradas' : 'inscrições abertas'}`;
    const imp = $('#g-import');
    imp.disabled = !g.count;
    imp.textContent = g.count ? `Trazer ${plural(g.count, 'inscrito', 'inscritos')} pra lista` : 'Ninguém se inscreveu ainda';
    $('#g-close').textContent = g.closed ? 'Reabrir inscrições' : 'Encerrar inscrições';
    const del = $('#g-delete');
    if (del.dataset.armed !== '1') del.textContent = 'Apagar este link';
  }

  async function loadGroups() {
    const d = await gApi({ action: 'list' });
    if (!d) return;
    groups = d.groups;
    render();
  }

  $('#g-refresh').addEventListener('click', loadGroups);
  $('#g-select').addEventListener('change', (e) => { current = e.target.value || null; render(); });
  $('#g-other').addEventListener('click', () => { showNew = true; $('#g-new-name').value = ''; render(); $('#g-new-name').focus(); });

  $('#g-new').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = clean($('#g-new-name').value);
    if (!name) { gError('Dê um nome para a turma.'); return; }
    const d = await gApi({ action: 'create', name });
    if (!d) return;
    $('#g-new-name').value = '';
    showNew = false;
    current = d.group.code;
    await loadGroups();
  });

  $('#g-copy').addEventListener('click', async () => {
    const input = $('#g-link');
    try {
      await navigator.clipboard.writeText(input.value);
      $('#g-copy').textContent = 'Copiado';
      setTimeout(() => { $('#g-copy').textContent = 'Copiar link'; }, 1800);
    } catch {
      input.select();
    }
  });

  $('#g-close').addEventListener('click', async () => {
    const g = groups.find((x) => x.code === current);
    if (!g) return;
    if (await gApi({ action: 'close', code: g.code, closed: !g.closed })) await loadGroups();
  });

  $('#g-delete').addEventListener('click', async () => {
    const b = $('#g-delete');
    if (b.dataset.armed !== '1') {
      b.dataset.armed = '1';
      b.textContent = 'Clique de novo para apagar';
      setTimeout(() => { b.dataset.armed = ''; renderLink(); }, 4000);
      return;
    }
    b.dataset.armed = '';
    if (await gApi({ action: 'delete', code: current })) {
      if (state.importedGroup === current) { state.importedGroup = ''; save(); }
      current = null;
      await loadGroups();
    }
  });

  $('#g-import').addEventListener('click', async () => {
    const d = await gApi({ action: 'people', code: current, closeAfter: true });
    if (!d) return;
    let added = 0, already = 0, full = 0;
    for (const p of d.people) {
      const email = String(p.email || '').toLowerCase();
      const nameTaken = state.people.some((x) => x.name.toLocaleLowerCase('pt-BR') === String(p.name).toLocaleLowerCase('pt-BR'));
      if (!email || state.people.some((x) => x.email === email) || nameTaken) { already++; continue; }
      if (state.people.length >= 60) { full++; continue; }
      state.people.push({ id: state.next++, name: p.name, email, tip: p.tip || '' });
      added++;
    }
    state.importedGroup = current;
    await loadGroups();
    const parts = [`${plural(added, 'pessoa entrou', 'pessoas entraram')} na lista`];
    if (already) parts.push(`${plural(already, 'já estava', 'já estavam')} (mesmo e-mail ou nome)`);
    if (full) parts.push(`${plural(full, 'ficou', 'ficaram')} de fora porque a lista chegou a 60`);
    $('#g-status').innerHTML = `${esc(parts.join('; '))}. Inscrições encerradas para ninguém entrar depois e ficar de fora. Se faltar alguém, reabra.`;
  });

  // ---------- passo 3 ----------
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

  // ---------- passo 1 ----------
  for (const f of EVENT_FIELDS) {
    const el = $('#ev-' + f);
    el.addEventListener('input', () => { state.event[f] = el.value; save(); render(); });
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

  // ---------- passo 4 ----------
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
    if (!drawStatus().ok) return;
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

  async function send() {
    const P = state.people;
    const idx = new Map(P.map((p, i) => [p.id, i]));
    const payload = {
      participants: P.map(({ name, email, tip }) => ({ name, email, tip })),
      exclusions: state.excl.map(([a, b]) => [idx.get(a), idx.get(b)]),
      event: Object.fromEntries(EVENT_FIELDS.map((f) => [f, clean($('#ev-' + f).value)])),
      // turma de onde vieram os inscritos: se todos participaram e tudo saiu, o servidor apaga a lista
      group: state.importedGroup || undefined,
    };

    phase('sent');
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
    const r = await post('/api/draw', payload);
    const data = r.data;
    if (r.status === 0) {
      phase('setup');
      showDrawError('A conexão caiu durante o sorteio.' + UNSURE);
      return;
    }
    if (!r.ok || !Array.isArray(data.sent)) {
      if (r.status === 401) return lock('A senha não confere mais. Entre de novo. Nenhum e-mail foi enviado.');
      phase('setup');
      // stage "before" = o servidor recusou antes de mandar qualquer coisa
      if (data.stage === 'before') showDrawError(data.error + ' Nenhum e-mail foi enviado.');
      else showDrawError(`O servidor não respondeu direito (erro ${r.status}).` + UNSURE);
      return;
    }

    state.lastDraw = data.stamp || new Date().toLocaleString('pt-BR');
    save();
    const total = data.sent.length;
    const okCount = data.sent.filter((x) => x.ok).length;
    const hour = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    $('#progress').className = 'progress';
    $('#progress i').style.width = (okCount / total) * 100 + '%';
    $('#sent-count').textContent = `${okCount} de ${total}`;
    $('#sent').innerHTML = data.sent.map((x) => `<li>
        <span class="who">${esc(x.name)}</span>
        <span class="status ${x.ok ? 'ok' : 'bad'}">${x.ok ? 'enviado ' + hour : 'falhou'}</span>
        <span class="addr">${esc(x.email)}</span>
        ${x.ok ? '' : `<span class="why">${esc(x.reason || '')}</span>`}
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
    if (data.groupDeleted) {
      state.importedGroup = '';
      save();
      groups = groups.filter((g) => g.code !== payload.group);
      $('#sent-lede').textContent += ' A lista de inscrição da turma foi apagada do servidor.';
    } else if (data.groupLeftovers) {
      $('#sent-lede').textContent += ` Atenção: ${plural(data.groupLeftovers, 'pessoa inscrita', 'pessoas inscritas')} pelo link não ${data.groupLeftovers > 1 ? 'estavam' : 'estava'} neste sorteio. A turma não foi apagada; confira no passo 2.`;
    }
    $('#sent-note').hidden = false;
    $('#back').hidden = false;
    purgeCopies(data.copies || []);
  }

  // O Gmail guarda cópia dos e-mails em Enviados; o servidor apaga essas cópias para o dono da conta não ver.
  async function purgeCopies(copies) {
    const box = $('#purge');
    if (!copies.length) { box.hidden = true; return; }
    box.hidden = false;
    box.className = 'verdict';
    box.textContent = 'Apagando as cópias da pasta Enviados do seu Gmail… não abra o Gmail ainda.';
    const r = await post('/api/purge', { copies });
    const info = r.data || {};
    if (r.ok && info.removed === info.total) {
      box.textContent = '✓ Cópias apagadas da pasta Enviados. Pode abrir o Gmail tranquilo.';
    } else {
      box.className = 'verdict no';
      box.textContent = `Não consegui apagar ${info.total ? `${info.total - (info.removed || 0)} de ${info.total} cópias` : 'as cópias'} da pasta Enviados do Gmail. Para não ver o resultado: na busca do Gmail, digite "in:sent Seu papelzinho", marque todas sem abrir e exclua; depois esvazie a Lixeira.`;
    }
  }

  $('#back').addEventListener('click', () => { phase('setup'); render(); });

  // ---------- início ----------
  load();
  for (const f of EVENT_FIELDS) $('#ev-' + f).value = state.event?.[f] || '';
  if (password) enter(true);
  else lock('');
})();
