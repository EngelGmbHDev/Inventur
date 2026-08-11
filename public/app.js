'use strict';
const $ = (id) => document.getElementById(id);
const S = {
  token: localStorage.getItem('inv.token') || '',
  role: localStorage.getItem('inv.role') || '',
  worker: localStorage.getItem('inv.worker') || '',
  task: null, lines: [], queue: new Set(), timer: null, retry: null, adminTimer: null,
};

// ── Netzwerk ──────────────────────────────────────────────────────────────
async function api(path, opt = {}) {
  const r = await fetch(window.API_BASE + '/api' + path, {
    method: opt.body ? 'POST' : (opt.method || 'GET'),
    headers: {
      ...(opt.body ? { 'content-type': 'application/json' } : {}),
      ...(S.token ? { authorization: 'Bearer ' + S.token } : {}),
    },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  if (r.status === 401) { logout(); throw new Error('Sitzung abgelaufen, bitte neu anmelden'); }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) { if (!r.ok) throw new Error('Fehler ' + r.status); return r; }
  const d = await r.json();
  if (!r.ok) { const e = new Error(d.error || 'Fehler ' + r.status); e.status = r.status; e.data = d; throw e; }
  return d;
}

let toastT;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; clearTimeout(toastT);
  toastT = setTimeout(() => el.remove(), 3200);
}

// ── Navigation ────────────────────────────────────────────────────────────
function show(view, title, sub, opts = {}) {
  for (const v of ['vLogin', 'vTasks', 'vCount', 'vAdmin', 'vHelp']) $(v).classList.toggle('hide', v !== view);
  $('hTitle').textContent = title;
  $('hSub').textContent = sub;
  $('tape').classList.toggle('hide', view !== 'vCount');
  $('dock').classList.toggle('hide', view !== 'vCount');
  $('btnBack').classList.toggle('hide', !opts.back);
  $('btnLogout').classList.toggle('hide', view === 'vLogin' || view === 'vHelp');
  window.scrollTo(0, 0);
}

function logout() {
  clearInterval(S.adminTimer); S.adminTimer = null;
  localStorage.removeItem('inv.token');
  S.token = ''; S.role = ''; S.task = null;
  show('vLogin', 'Inventur', 'Anmeldung');
}

$('btnLogout').onclick = async () => {
  if (S.task) {
    await flush();
    if (S.queue.size && !confirm('Es gibt noch nicht übertragene Zeilen. Trotzdem ausloggen?')) return;
  }
  logout();
};

// ── Anmeldung ─────────────────────────────────────────────────────────────
$('btnHelp').onclick = () => show('vHelp', 'Anleitung', '', { back: true });

async function loadWorkerList() {
  try {
    const d = await api('/state');
    const sel = $('fWorker');
    const prev = S.worker;
    sel.innerHTML = '<option value="">Verwaltung</option>'
      + d.workers.map((w) => `<option>${esc(w)}</option>`).join('');
    if (prev && d.workers.includes(prev)) sel.value = prev;
  } catch { /* egal, Verwaltung bleibt als Option nutzbar */ }
}

$('btnLogin').onclick = async () => {
  const pin = $('fPin').value.trim();
  if (!pin) return toast('Bitte Code eingeben');
  const worker = $('fWorker').value;
  try {
    const d = await api('/login', { body: { pin, worker } });
    S.token = d.token; S.role = d.role; S.worker = d.worker;
    localStorage.setItem('inv.token', d.token);
    localStorage.setItem('inv.role', d.role);
    localStorage.setItem('inv.worker', d.worker);
    $('fPin').value = '';
    d.role === 'admin' ? openAdmin() : openTasks();
  } catch (e) { toast(e.message); }
};

// ── Aufgabenliste ─────────────────────────────────────────────────────────
async function openTasks() {
  S.task = null;
  const d = await api('/tasks');
  const free = d.tasks.filter((t) => t.status === 'open').length;
  $('tasksNote').textContent = free
    ? `Freie Aufgaben: ${free}. Wählen Sie eine – sie wird Ihnen fest zugeordnet.`
    : 'Keine freien Aufgaben.';
  $('taskList').innerHTML = d.tasks.map((t) => {
    const mine = t.worker === d.me;
    const label = t.status === 'done' ? 'abgegeben' : (t.status === 'taken' ? (mine ? 'bei Ihnen' : esc(t.worker || '')) : '');
    return `<button class="task" data-s="${t.status}" data-n="${t.n}"
      ${t.status === 'open' || (t.status === 'taken' && mine) ? '' : 'disabled'}>
      <span class="num">${t.n}</span>
      <span class="rng"><b>${esc(t.von)}</b> → <b>${esc(t.bis)}</b>
        ${label ? `<span class="who">${label}</span>` : ''}</span>
      <span class="cnt">${t.cnt} Pos.</span></button>`;
  }).join('');
  for (const b of $('taskList').querySelectorAll('.task[data-n]')) {
    if (!b.disabled) b.onclick = () => claim(Number(b.dataset.n));
  }
  show('vTasks', 'Aufgaben', S.worker);
}

async function claim(n) {
  try {
    const d = await api(`/tasks/${n}/claim`);
    openCount(n, d.lines);
  } catch (e) {
    toast(e.message);
    openTasks();
  }
}

// ── Zählung ───────────────────────────────────────────────────────────────
const bufKey = (n) => 'inv.buf.' + n;
const readBuf = (n) => { try { return JSON.parse(localStorage.getItem(bufKey(n))) || {}; } catch { return {}; } };
const writeBuf = (n, b) => localStorage.setItem(bufKey(n), JSON.stringify(b));

function openCount(n, lines) {
  S.task = n; S.lines = lines; S.queue = new Set();
  localStorage.setItem('inv.task', String(n));
  renderLines();
  refreshStat();
  show('vCount', 'Aufgabe ' + n, `${lines[0]?.lagerplatz ?? ''} → ${lines[lines.length - 1]?.lagerplatz ?? ''}`, { back: true });
}

function renderLines() {
  const buf = readBuf(S.task);

  const rows = S.lines.map((l) => {
    const pending = Object.prototype.hasOwnProperty.call(buf, l.id);
    const val = pending ? buf[l.id] : (l.menge ?? '');
    const st = pending ? 'dirty' : (l.menge !== null ? 'saved' : '');
    const tag = l.added ? '<em class="tag neu">neu erfasst</em>'
      : (l.itemcode_soll ? `<em class="tag">Soll: ${esc(l.itemcode_soll)}</em>` : '');
    return `<div class="row" data-s="${st}" data-id="${l.id}">
      <span class="lp">${esc(l.lagerplatz)}
        <button class="ic" data-edit="${l.id}">${l.itemcode ? esc(l.itemcode) : 'kein Artikel erwartet'}<span class="pen">✎</span></button>
        ${tag}</span>
      <input inputmode="decimal" enterkeyhint="next" value="${val === '' ? '' : esc(String(val))}">
      ${l.added ? `<button class="rm" data-rm="${l.id}" aria-label="Zeile entfernen">×</button>` : ''}
    </div>`;
  }).join('');

  const plaetze = [...new Set(S.lines.map((l) => l.lagerplatz))].sort();
  const pane = `<div class="addpane">
    <h3>Zusätzlicher Artikel am Platz</h3>
    <select id="aLp">${plaetze.map((x) => `<option>${esc(x)}</option>`).join('')}</select>
    <input id="aCode" placeholder="Artikelnummer" autocapitalize="characters" autocomplete="off">
    <input id="aMenge" inputmode="decimal" placeholder="Menge">
    <button id="aAdd">Artikel hinzufügen</button>
  </div>`;

  $('lineList').innerHTML = rows + pane;

  const inputs = [...$('lineList').querySelectorAll('.row input')];
  inputs.forEach((inp, i) => {
    inp.onchange = () => onEdit(inp);
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); inputs[i + 1]?.focus(); } };
  });
  for (const b of $('lineList').querySelectorAll('[data-edit]')) b.onclick = () => editItem(Number(b.dataset.edit));
  for (const b of $('lineList').querySelectorAll('[data-rm]')) b.onclick = () => removeLine(Number(b.dataset.rm));
  $('aAdd').onclick = addLine;

  if (Object.keys(buf).length) { Object.keys(buf).forEach((id) => S.queue.add(Number(id))); flushSoon(200); }
}

// Artikel einer Zeile korrigieren. Der ursprüngliche Artikel bleibt im Feld
// itemcode_soll erhalten — sonst wäre nicht mehr erkennbar, dass am Platz
// etwas anderes lag als erwartet.
function editItem(id) {
  const line = S.lines.find((l) => l.id === id);
  if (!line) return;
  const row = $('lineList').querySelector(`.row[data-id="${id}"]`);
  const btn = row.querySelector('.ic');
  const inp = document.createElement('input');
  inp.className = 'icedit';
  inp.value = line.itemcode;
  inp.autocapitalize = 'characters';
  inp.autocomplete = 'off';
  inp.enterKeyHint = 'done';
  btn.replaceWith(inp);
  inp.focus(); inp.select();

  let closed = false;
  const finish = async (save) => {
    if (closed) return; closed = true;
    const v = inp.value.trim();
    if (!save || !v || v === line.itemcode) return renderLines();
    try {
      await api(`/tasks/${S.task}/item`, { body: { id, itemcode: v } });
      if (!line.itemcode_soll) line.itemcode_soll = line.itemcode;
      line.itemcode = v;
      toast('Artikel geändert');
    } catch (e) { toast(e.message); }
    renderLines();
  };
  inp.onblur = () => finish(true);
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
}

// Zusätzlicher Artikel, der am Lagerplatz gefunden wurde und nicht auf der Liste steht
async function addLine() {
  const lagerplatz = $('aLp').value;
  const itemcode = $('aCode').value.trim();
  const raw = $('aMenge').value.trim().replace(',', '.');
  if (!itemcode) return toast('Artikelnummer eingeben');
  if (raw !== '' && !Number.isFinite(Number(raw))) return toast('Menge ungültig');
  try {
    const d = await api(`/tasks/${S.task}/add`, {
      body: { lagerplatz, itemcode, menge: raw === '' ? null : Number(raw) },
    });
    S.lines.push({ id: d.id, lagerplatz, itemcode, itemcode_soll: null, added: 1,
      menge: raw === '' ? null : Number(raw) });
    S.lines.sort((a, b) => a.lagerplatz.localeCompare(b.lagerplatz) || a.id - b.id);
    renderLines(); refreshStat();
    toast('Artikel hinzugefügt');
  } catch (e) { toast(e.message); }
}

async function removeLine(id) {
  if (!confirm('Diese zusätzlich erfasste Zeile entfernen?')) return;
  try {
    await api(`/tasks/${S.task}/remove`, { body: { id } });
    S.lines = S.lines.filter((l) => l.id !== id);
    const buf = readBuf(S.task); delete buf[id]; writeBuf(S.task, buf);
    S.queue.delete(id);
    renderLines(); refreshStat();
  } catch (e) { toast(e.message); }
}

function onEdit(inp) {
  const row = inp.closest('.row');
  const id = Number(row.dataset.id);
  const raw = inp.value.trim().replace(',', '.');
  if (raw !== '' && !Number.isFinite(Number(raw))) { toast('Bitte Zahl eingeben'); inp.focus(); return; }

  const buf = readBuf(S.task);
  buf[id] = raw === '' ? '' : Number(raw);
  writeBuf(S.task, buf);
  row.dataset.s = 'dirty';
  S.queue.add(id);
  refreshStat();
  flushSoon();
}

function flushSoon(ms = 900) { clearTimeout(S.timer); S.timer = setTimeout(flush, ms); }

async function flush() {
  if (!S.task || !S.queue.size) return;
  const buf = readBuf(S.task);
  const ids = [...S.queue];
  const payload = ids.map((id) => ({ id, menge: buf[id] === '' ? null : buf[id] }));
  try {
    await api(`/tasks/${S.task}/lines`, { body: { lines: payload } });
    for (const id of ids) {
      S.queue.delete(id);
      const line = S.lines.find((l) => l.id === id);
      if (line) line.menge = buf[id] === '' ? null : buf[id];
      delete buf[id];
      const row = $('lineList').querySelector(`.row[data-id="${id}"]`);
      if (row) row.dataset.s = line && line.menge !== null ? 'saved' : '';
    }
    writeBuf(S.task, buf);
    clearTimeout(S.retry); S.retry = null;
  } catch {
    if (!S.retry) S.retry = setInterval(flush, 15000);   // keine Verbindung — Daten liegen im localStorage
  }
  refreshStat();
}

function refreshStat() {
  const buf = readBuf(S.task);
  const filled = S.lines.filter((l) => {
    const v = Object.prototype.hasOwnProperty.call(buf, l.id) ? buf[l.id] : l.menge;
    return v !== null && v !== '' && v !== undefined;
  }).length;
  const pend = S.queue.size;
  $('dockStat').innerHTML = `<b>${filled} / ${S.lines.length}</b>${pend ? `offen: ${pend}` : 'alles gespeichert'}`;
  $('btnDone').disabled = filled < S.lines.length;
}

$('btnDone').onclick = async () => {
  await flush();
  if (S.queue.size) return toast('Nicht alle Zeilen übertragen – Verbindung prüfen');
  try {
    await api(`/tasks/${S.task}/complete`, { body: {} });
    localStorage.removeItem(bufKey(S.task));
    localStorage.removeItem('inv.task');
    toast('Aufgabe abgegeben');
    openTasks();
  } catch (e) { toast(e.message); }
};

$('btnRelease').onclick = async () => {
  if (!confirm('Aufgabe wirklich verlassen? Alle bisher für diese Aufgabe erfassten Mengen und Änderungen gehen dabei verloren.')) return;
  clearTimeout(S.timer); clearTimeout(S.retry); S.retry = null; S.queue.clear();
  try {
    await api(`/tasks/${S.task}/release`, { body: {} });
    localStorage.removeItem(bufKey(S.task));
    localStorage.removeItem('inv.task');
    toast('Aufgabe freigegeben');
    openTasks();
  } catch (e) { toast(e.message); }
};

$('btnBack').onclick = async () => {
  if (!S.token) return show('vLogin', 'Inventur', 'Anmeldung');
  if (S.role === 'admin') return openAdmin();
  await flush();
  if (S.queue.size && !confirm('Es gibt noch nicht übertragene Zeilen. Trotzdem zurück zur Liste?')) return;
  openTasks();
};

window.addEventListener('online', () => { if (S.queue.size) flush(); });

// ── Verwaltung ────────────────────────────────────────────────────────────
function renderAdminTasks(tasks) {
  $('adminTasks').innerHTML = tasks.map((t) => {
    const label = t.status === 'open' ? 'frei'
      : t.status === 'taken' ? `<b>${esc(t.worker)}</b> arbeitet daran`
      : `<b>${esc(t.worker)}</b> abgegeben`;
    return `<div class="arow" data-s="${t.status}">
      <span class="n">${t.n}</span>
      <span class="rng">${esc(t.von)} → ${esc(t.bis)} · ${t.cnt} Pos.</span>
      <span class="who">${label}</span>
      ${t.status !== 'open' ? `<button class="leer" data-reset="${t.n}">Leeren</button>` : ''}
    </div>`;
  }).join('');
  for (const b of $('adminTasks').querySelectorAll('[data-reset]')) {
    b.onclick = () => resetAdminTask(Number(b.dataset.reset));
  }
}

async function resetAdminTask(n) {
  if (!confirm(`Aufgabe ${n} wirklich leeren? Alle für diese Aufgabe erfassten Mengen und Änderungen gehen dabei verloren, sie wird wieder frei zur Vergabe.`)) return;
  try {
    await api(`/admin/tasks/${n}/reset`, { body: {} });
    toast(`Aufgabe ${n} geleert`);
    refreshAdmin();
  } catch (e) { toast(e.message); }
}

async function refreshAdmin() {
  try {
    const d = await api('/admin/status');
    $('kTasks').textContent = d.tasks.length;
    $('kLines').textContent = d.lines;
    $('kDone').textContent = d.done;
    $('kEmpty').textContent = d.empty;
    $('openState').textContent = d.open ? 'für Mitarbeiter freigegeben' : 'gesperrt';
    $('btnOpen').textContent = d.open ? 'Sperren' : 'Freigeben';
    $('btnOpen').onclick = async () => { await api('/admin/open', { body: { open: !d.open } }); refreshAdmin(); };
    renderAdminTasks(d.tasks);
  } catch { /* Netzfehler/Token abgelaufen — nächster Versuch folgt, api() regelt den Logout */ }
}

async function openAdmin() {
  S.task = null;
  show('vAdmin', 'Verwaltung', S.worker);
  await refreshAdmin();
  clearInterval(S.adminTimer);
  S.adminTimer = setInterval(refreshAdmin, 8000);
}

$('fCsvFile').onchange = async () => {
  const file = $('fCsvFile').files[0];
  if (!file) return;
  $('fCsv').value = await file.text();
  $('fCsvFile').value = '';
};

$('fWorkersFile').onchange = async () => {
  const file = $('fWorkersFile').files[0];
  if (!file) return;
  $('fWorkers').value = await file.text();
  $('fWorkersFile').value = '';
};

$('btnImport').onclick = async () => {
  const csv = $('fCsv').value;
  if (!csv.trim()) return toast('Bitte CSV einfügen');
  $('importProblems').classList.add('hide');
  try {
    const d = await api('/admin/import', {
      body: { csv, workersCsv: $('fWorkers').value },
    });
    toast(`Geladen: ${d.tasks} Aufgaben, ${d.lines} Zeilen`);
    if (d.problems?.length) {
      $('importProblems').innerHTML = `<b>${d.problems.length} Problem(e) beim Import — bitte prüfen:</b>
        <ul style="margin:6px 0 0;padding-left:18px">${d.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`;
      $('importProblems').classList.remove('hide');
    }
    openAdmin();
    loadWorkerList();
  } catch (e) { toast(e.message); }
};

$('btnPin').onclick = async () => {
  const pin = $('fNewPin').value.trim();
  try { await api('/admin/pin', { body: { role: 'admin', pin } }); $('fNewPin').value = ''; toast('Code geändert'); }
  catch (e) { toast(e.message); }
};

$('btnExport').onclick = async () => {
  const r = await fetch(window.API_BASE + '/api/admin/export', { headers: { authorization: 'Bearer ' + S.token } });
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'inventur.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

$('btnReset').onclick = async () => {
  if (!confirm('Alle Aufgaben, erfassten Mengen und Mitarbeiternamen löschen?')) return;
  await api('/admin/reset', { body: {} });
  toast('Durchgang geleert'); openAdmin();
  loadWorkerList();
};

// ── Start ─────────────────────────────────────────────────────────────────
function esc(s) { return String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }

loadWorkerList();

(async function boot() {
  if (!S.token) return;
  try {
    if (S.role === 'admin') return openAdmin();
    const n = Number(localStorage.getItem('inv.task'));
    if (Number.isInteger(n) && n) {
      const d = await api(`/tasks/${n}/lines`);
      return openCount(n, d.lines);
    }
    openTasks();
  } catch (e) { toast(e.message); }
})();
