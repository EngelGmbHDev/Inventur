// Gesamte Fachlogik. Kennt weder Workers, Node, D1 noch better-sqlite3.
// req: { method, path, query, body, ip, token }
// liefert { status, json } | { status, text, headers }
import { hashPin, checkPin, makeToken, readToken } from './auth.js';

const RUN = 1;                 // aktuell ein Durchgang; run_id ist für später vorgesehen
const MAX_TRIES = 5;
const BLOCK_MIN = 15;

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const json = (status, body) => ({ status, json: body });

export async function handle(req, repo, env) {
  const seg = req.path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const secret = env.TOKEN_SECRET;

  if (seg[0] === 'login')  return login(req, repo, env);
  if (seg[0] === 'state')
    return json(200, { open: (await repo.getSetting('open')) === '1', workers: await repo.listWorkers(RUN) });

  const who = await readToken(req.token, secret);
  if (!who) return json(401, { error: 'Anmeldung erforderlich' });

  if (seg[0] === 'admin') {
    if (who.role !== 'admin') return json(403, { error: 'Keine Berechtigung' });
    return admin(seg.slice(1), req, repo);
  }

  if ((await repo.getSetting('open')) !== '1')
    return json(503, { error: 'Die Inventur ist nicht freigegeben' });

  if (seg[0] === 'tasks') return tasks(seg.slice(1), req, repo, who);
  return json(404, { error: 'Unbekannte Anfrage' });
}

// ── Anmeldung ─────────────────────────────────────────────────────────────
// Verwaltung: ein gemeinsamer, gehashter Code (kein Name).
// Mitarbeiter: individueller Klartext-Code je Person, kommt aus dem CSV-Import
// (workers.pin) — Name und Code werden gemeinsam geprüft.
async function login(req, repo, env) {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const blocked = await repo.isBlocked(req.ip);
  if (blocked) return json(429, { error: `Zu viele Versuche. Bitte ${blocked} Min. warten.` });

  const pin = String(req.body?.pin ?? '');
  const worker = String(req.body?.worker ?? '').trim();

  if (!worker) {
    const rec = await repo.getAuth('admin');
    if (rec && await checkPin(pin, rec.hash, rec.salt)) {
      await repo.clearAttempts(req.ip);
      return json(200, {
        token: await makeToken({ role: 'admin', worker: 'admin' }, env.TOKEN_SECRET),
        role: 'admin', worker: 'admin',
      });
    }
  } else {
    const stored = await repo.getWorkerPin(RUN, worker);
    if (stored !== null && stored === pin) {
      await repo.clearAttempts(req.ip);
      return json(200, {
        token: await makeToken({ role: 'worker', worker }, env.TOKEN_SECRET),
        role: 'worker', worker,
      });
    }
  }

  await repo.bumpAttempt(req.ip, MAX_TRIES, BLOCK_MIN);
  return json(401, { error: 'Code ungültig' });
}

// ── Aufgaben ──────────────────────────────────────────────────────────────
async function tasks(seg, req, repo, who) {
  if (seg.length === 0) return json(200, { tasks: await repo.listTasks(RUN), me: who.worker });

  const n = Number(seg[0]);
  if (!Number.isInteger(n)) return json(400, { error: 'Ungültige Aufgabennummer' });
  const action = seg[1];

  if (action === 'claim') {
    const t = await repo.getTask(RUN, n);
    if (!t) return json(404, { error: 'Aufgabe nicht gefunden' });
    if (t.status === 'taken' && t.worker === who.worker)
      return json(200, { lines: await repo.getLines(RUN, n) });

    const active = await repo.activeTaskFor(RUN, who.worker);
    if (active !== null)
      return json(409, { error: `Sie bearbeiten bereits Aufgabe ${active}. Bitte zuerst abschließen oder verlassen.` });

    const ok = await repo.claimTask(RUN, n, who.worker);
    if (!ok) return json(409, { error: 'Aufgabe ist bereits vergeben' });
    return json(200, { lines: await repo.getLines(RUN, n) });
  }

  const t = await repo.getTask(RUN, n);
  if (!t) return json(404, { error: 'Aufgabe nicht gefunden' });
  if (t.worker !== who.worker) return json(403, { error: 'Aufgabe gehört einem anderen Mitarbeiter' });

  if (action === 'lines' && req.method === 'GET')
    return json(200, { lines: await repo.getLines(RUN, n) });

  if (action === 'lines' && req.method === 'POST') {
    const current = await repo.getLines(RUN, n);
    const itemcodeById = new Map(current.map((l) => [l.id, l.itemcode]));
    const upd = (req.body?.lines ?? [])
      .filter((l) => Number.isInteger(l.id))
      .map((l) => ({ id: l.id, menge: l.menge === null || l.menge === '' ? null : Number(l.menge) }))
      .filter((l) => l.menge === null || Number.isFinite(l.menge))
      // Menge > 0 ohne Artikel ergibt fachlich keinen Sinn (Menge wovon?) — 0 bleibt erlaubt,
      // um einen laut Import leeren Lagerplatz als tatsächlich leer zu bestätigen.
      .filter((l) => l.menge === null || l.menge <= 0 || itemcodeById.get(l.id));
    await repo.saveLines(RUN, n, upd, now());
    return json(200, { saved: upd.length });
  }

  if (action === 'item' && req.method === 'POST') {
    const id = Number(req.body?.id);
    const code = String(req.body?.itemcode ?? '').trim();
    if (!Number.isInteger(id) || !code) return json(400, { error: 'Artikelnummer fehlt' });
    if (code.length > 50) return json(400, { error: 'Artikelnummer zu lang' });
    const ok = await repo.setItemcode(RUN, n, id, code);
    return ok ? json(200, { ok: true }) : json(404, { error: 'Zeile nicht gefunden' });
  }

  if (action === 'add' && req.method === 'POST') {
    const lagerplatz = String(req.body?.lagerplatz ?? '').trim();
    const code = String(req.body?.itemcode ?? '').trim();
    const menge = req.body?.menge === '' || req.body?.menge === null ? null : Number(req.body?.menge);
    if (!lagerplatz || !code) return json(400, { error: 'Lagerplatz und Artikelnummer angeben' });
    if (menge !== null && !Number.isFinite(menge)) return json(400, { error: 'Menge ungültig' });
    const plaetze = await repo.lagerplaetze(RUN, n);
    if (!plaetze.includes(lagerplatz)) return json(400, { error: 'Lagerplatz gehört nicht zu dieser Aufgabe' });
    const id = await repo.addLine(RUN, n, lagerplatz, code, menge, now());
    return json(200, { id });
  }

  if (action === 'remove' && req.method === 'POST') {
    const id = Number(req.body?.id);
    if (!Number.isInteger(id)) return json(400, { error: 'Zeile fehlt' });
    const ok = await repo.removeLine(RUN, n, id);
    return ok ? json(200, { ok: true }) : json(400, { error: 'Nur selbst erfasste Zeilen lassen sich entfernen' });
  }

  if (action === 'release' && req.method === 'POST') {
    await repo.releaseTask(RUN, n, who.worker);
    return json(200, { ok: true });
  }

  if (action === 'complete') {
    const left = await repo.countEmpty(RUN, n);
    if (left > 0 && !req.body?.force) return json(400, { error: `Noch offen: ${left} Zeilen`, left });
    await repo.completeTask(RUN, n, who.worker, now());
    return json(200, { ok: true });
  }

  return json(404, { error: 'Unbekannte Aktion' });
}

// ── Verwaltung ────────────────────────────────────────────────────────────
async function admin(seg, req, repo) {
  const cmd = seg[0];

  if (cmd === 'status')
    return json(200, {
      open: (await repo.getSetting('open')) === '1',
      ...(await repo.summary(RUN)),
      tasks: await repo.listTasks(RUN),
    });

  if (cmd === 'tasks' && seg[2] === 'reset' && req.method === 'POST') {
    const n = Number(seg[1]);
    if (!Number.isInteger(n)) return json(400, { error: 'Ungültige Aufgabennummer' });
    const ok = await repo.adminResetTask(RUN, n);
    return ok ? json(200, { ok: true }) : json(404, { error: 'Aufgabe nicht gefunden oder bereits offen' });
  }

  if (cmd === 'workers' && seg.length === 1 && req.method === 'GET')
    return json(200, { workers: await repo.listWorkersFull(RUN) });

  if (cmd === 'workers' && seg.length === 1 && req.method === 'POST') {
    const name = String(req.body?.name ?? '').trim();
    const pin = String(req.body?.pin ?? '').trim();
    if (!name) return json(400, { error: 'Name fehlt' });
    if (pin.length < 4) return json(400, { error: 'Code zu kurz (mind. 4 Zeichen)' });
    const ok = await repo.addWorker(RUN, name, pin);
    return ok ? json(200, { ok: true }) : json(409, { error: 'Mitarbeiter existiert bereits' });
  }

  if (cmd === 'workers' && seg[2] === 'pin' && req.method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '');
    const pin = String(req.body?.pin ?? '').trim();
    if (pin.length < 4) return json(400, { error: 'Code zu kurz (mind. 4 Zeichen)' });
    const ok = await repo.setWorkerPin(RUN, name, pin);
    return ok ? json(200, { ok: true }) : json(404, { error: 'Mitarbeiter nicht gefunden' });
  }

  if (cmd === 'workers' && seg[2] === 'remove' && req.method === 'POST') {
    const name = decodeURIComponent(seg[1] ?? '');
    const ok = await repo.removeWorker(RUN, name);
    return ok ? json(200, { ok: true }) : json(404, { error: 'Mitarbeiter nicht gefunden' });
  }

  if (cmd === 'open' && req.method === 'POST') {
    const v = req.body?.open ? '1' : '0';
    await repo.setSetting('open', v);
    return json(200, { open: v === '1' });
  }

  if (cmd === 'pin' && req.method === 'POST') {
    const role = req.body?.role === 'admin' ? 'admin' : 'worker';
    const pin = String(req.body?.pin ?? '');
    if (pin.length < (role === 'admin' ? 8 : 4)) return json(400, { error: 'Code zu kurz' });
    const { hash, salt } = await hashPin(pin);
    await repo.setAuth(role, hash, salt);
    return json(200, { ok: true });
  }

  if (cmd === 'import' && req.method === 'POST') {
    if (await repo.hasActivity(RUN))
      return json(409, { error: 'Im Durchgang gibt es bereits vergebene oder abgegebene Aufgaben. Bitte zuerst leeren.' });
    const parsed = parseCsv(String(req.body?.csv ?? ''));
    if (parsed.error) return json(400, { error: parsed.error });
    await repo.importRun(RUN, parsed.rows);
    return json(200, { ...(await repo.summary(RUN)), problems: parsed.problems });
  }

  if (cmd === 'import-workers' && req.method === 'POST') {
    const wParsed = parseWorkers(String(req.body?.workersCsv ?? ''));
    await repo.importWorkers(RUN, wParsed.workers);
    return json(200, { workers: wParsed.workers.length, problems: wParsed.problems });
  }

  if (cmd === 'reset' && req.method === 'POST') {
    await repo.setSetting('open', '0');
    await repo.clearRun(RUN);
    return json(200, { ok: true });
  }

  if (cmd === 'export') {
    const rows = await repo.exportRows(RUN);
    const head = 'whscode;aufgabe;lagerplatz;itemcode;menge;buchbestand;buchartikel;status;gezaehlt_von;zeitpunkt\n';
    const body = rows.map((r) => [
      r.whscode ?? '', r.n, r.lagerplatz, r.itemcode,
      r.menge === null ? '' : String(r.menge).replace('.', ','),
      r.buchbestand === null ? '' : String(r.buchbestand).replace('.', ','),
      r.itemcode_soll ?? '',
      r.added ? 'neu' : (r.itemcode_soll ? 'geaendert' : ''),
      r.worker ?? '', r.counted_at ?? '',
    ].join(';')).join('\n');
    return {
      status: 200,
      text: '\uFEFF' + head + body,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="inventur_${now().slice(0, 10)}.csv"`,
      },
    };
  }

  return json(404, { error: 'Unbekannter Befehl' });
}

// ── CSV: lagerplatz ; itemcode ; aufgabe_num ───────────────────────────────
export function parseCsv(text) {
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!raw.length) return { error: 'Datei ist leer' };

  const delim = (raw[0].match(/;/g) || []).length >= (raw[0].match(/,/g) || []).length ? ';' : ',';
  if (/lagerplatz/i.test(raw[0])) raw.shift();

  const rows = [], problems = [];
  const seen = new Map();

  raw.forEach((line, i) => {
    const c = line.split(delim).map((s) => s.trim().replace(/^"|"$/g, ''));
    const [whscodeRaw, lagerplatz, itemcodeRaw, aufgabe, buchbestandRaw] = c;
    const whscode = whscodeRaw || null;
    const itemcode = itemcodeRaw ?? '';
    const n = Number(aufgabe);
    const buchbestand = !buchbestandRaw ? null : Number(buchbestandRaw.replace(',', '.'));
    if (!lagerplatz || !Number.isInteger(n) || (buchbestand !== null && !Number.isFinite(buchbestand))) {
      problems.push(`Zeile ${i + 1}: ${line.slice(0, 60)}`);
      return;
    }
    const key = lagerplatz + '|' + itemcode;
    if (seen.has(key)) problems.push(`Doppelt: ${lagerplatz} / ${itemcode} (Aufgaben ${seen.get(key)} und ${n})`);
    else seen.set(key, n);
    rows.push({ lagerplatz, itemcode, n, buchbestand, whscode });
  });

  if (!rows.length) return { error: 'Keine Zeile erkannt' };

  // Ein Lagerplatz darf nicht in zwei Aufgaben landen
  const lp = new Map();
  for (const r of rows) {
    if (lp.has(r.lagerplatz) && lp.get(r.lagerplatz) !== r.n)
      problems.push(`Lagerplatz ${r.lagerplatz} in Aufgaben ${lp.get(r.lagerplatz)} und ${r.n}`);
    lp.set(r.lagerplatz, r.n);
  }

  return { rows, problems: problems.slice(0, 50) };
}

// ── CSV: name ; pincode ─────────────────────────────────────────────────────
export function parseWorkers(text) {
  const raw = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!raw.length) return { workers: [], problems: [] };

  const delim = (raw[0].match(/;/g) || []).length >= (raw[0].match(/,/g) || []).length ? ';' : ',';
  if (/name|pincode|login/i.test(raw[0])) raw.shift();

  const workers = [], problems = [];
  const seen = new Set();

  raw.forEach((line, i) => {
    const [name, pin] = line.split(delim).map((s) => s.trim().replace(/^"|"$/g, ''));
    if (!name || !pin || pin.length < 4) {
      problems.push(`Mitarbeiter Zeile ${i + 1}: ${line.slice(0, 60)}`);
      return;
    }
    if (seen.has(name)) { problems.push(`Mitarbeiter doppelt: ${name}`); return; }
    seen.add(name);
    workers.push({ name, pin });
  });

  return { workers, problems: problems.slice(0, 50) };
}
