// Adapter für node:sqlite (Node 22+ mit --experimental-sqlite, Node 24 ohne Flag).
// Das gesamte SQL liegt hier — ein zweiter Dialekt ist eine Kopie dieser Datei.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function createRepo(path, schemaPath) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  if (schemaPath) db.exec(readFileSync(schemaPath, 'utf8'));

  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const get = (sql, ...a) => db.prepare(sql).get(...a);
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const tx = (fn) => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };

  // Setzt eine Aufgabe auf den Stand direkt nach dem Import zurück: eigene
  // Zeilen löschen, korrigierte Artikelnummern rückgängig machen, Mengen leeren.
  const resetLines = (runId, n) => {
    run('DELETE FROM lines WHERE run_id=? AND n=? AND added=1', runId, n);
    run(`UPDATE lines SET itemcode=COALESCE(itemcode_soll, itemcode), itemcode_soll=NULL, menge=NULL, counted_at=NULL
         WHERE run_id=? AND n=?`, runId, n);
    run('UPDATE tasks SET cnt=(SELECT COUNT(*) FROM lines WHERE run_id=? AND n=?) WHERE run_id=? AND n=?', runId, n, runId, n);
  };

  return {
    // Einstellungen und Zugang
    getSetting: (k) => get('SELECT v FROM settings WHERE k=?', k)?.v ?? null,
    setSetting: (k, v) => run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v),
    getAuth: (k) => get('SELECT hash,salt FROM auth WHERE k=?', k) ?? null,
    setAuth: (k, hash, salt) =>
      run('INSERT INTO auth(k,hash,salt) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET hash=excluded.hash, salt=excluded.salt', k, hash, salt),

    isBlocked(ip) {
      const r = get("SELECT cnt, until FROM attempts WHERE ip=?", ip);
      if (!r?.until) return 0;
      const left = Math.ceil((Date.parse(r.until + 'Z') - Date.now()) / 60000);
      return left > 0 ? left : 0;
    },
    bumpAttempt(ip, max, blockMin) {
      run('INSERT INTO attempts(ip,cnt) VALUES(?,1) ON CONFLICT(ip) DO UPDATE SET cnt=cnt+1', ip);
      const r = get('SELECT cnt FROM attempts WHERE ip=?', ip);
      if (r.cnt >= max)
        run("UPDATE attempts SET cnt=0, until=datetime('now', ?) WHERE ip=?", `+${blockMin} minutes`, ip);
    },
    clearAttempts: (ip) => run('DELETE FROM attempts WHERE ip=?', ip),

    // Aufgaben
    listTasks: (runId) =>
      all('SELECT n, von, bis, cnt, status, worker FROM tasks WHERE run_id=? ORDER BY n', runId),
    getTask: (runId, n) =>
      get('SELECT n, status, worker FROM tasks WHERE run_id=? AND n=?', runId, n) ?? null,
    activeTaskFor: (runId, worker) =>
      get("SELECT n FROM tasks WHERE run_id=? AND worker=? AND status='taken'", runId, worker)?.n ?? null,

    claimTask(runId, n, worker) {
      const r = run(
        `UPDATE tasks SET status='taken', worker=?, taken_at=datetime('now')
         WHERE run_id=? AND n=? AND status='open'
           AND NOT EXISTS (SELECT 1 FROM tasks t2 WHERE t2.run_id=? AND t2.worker=? AND t2.status='taken')`,
        worker, runId, n, runId, worker);
      return r.changes === 1;
    },
    releaseTask(runId, n, worker) {
      let ok = false;
      tx(() => {
        const r = run(
          "UPDATE tasks SET status='open', worker=NULL, taken_at=NULL WHERE run_id=? AND n=? AND worker=? AND status='taken'",
          runId, n, worker);
        ok = r.changes === 1;
        if (ok) resetLines(runId, n);
      });
      return ok;
    },
    // Admin-Variante von releaseTask: kein Worker-Abgleich, funktioniert auch
    // für bereits abgegebene ('done') Aufgaben — für vergessene/liegengelassene Aufgaben.
    adminResetTask(runId, n) {
      let ok = false;
      tx(() => {
        const r = run(
          "UPDATE tasks SET status='open', worker=NULL, taken_at=NULL, done_at=NULL WHERE run_id=? AND n=? AND status<>'open'",
          runId, n);
        ok = r.changes === 1;
        if (ok) resetLines(runId, n);
      });
      return ok;
    },
    completeTask: (runId, n, worker, ts) =>
      run("UPDATE tasks SET status='done', done_at=? WHERE run_id=? AND n=? AND worker=?", ts, runId, n, worker),

    // Zeilen
    getLines: (runId, n) =>
      all(`SELECT id, lagerplatz, itemcode, itemcode_soll, added, menge
           FROM lines WHERE run_id=? AND n=? ORDER BY lagerplatz, id`, runId, n),
    setItemcode(runId, n, id, itemcode) {
      const r = run(`UPDATE lines SET itemcode_soll=COALESCE(itemcode_soll, itemcode), itemcode=?
                     WHERE id=? AND run_id=? AND n=?`, itemcode, id, runId, n);
      return r.changes === 1;
    },
    addLine(runId, n, lagerplatz, itemcode, menge, ts) {
      let id;
      tx(() => {
        const r = run(`INSERT INTO lines(run_id,n,lagerplatz,itemcode,added,menge,counted_at)
                       VALUES(?,?,?,?,1,?,?)`, runId, n, lagerplatz, itemcode, menge, ts);
        id = Number(r.lastInsertRowid);
        run('UPDATE tasks SET cnt=cnt+1 WHERE run_id=? AND n=?', runId, n);
      });
      return id;
    },
    removeLine(runId, n, id) {
      let ok = false;
      tx(() => {
        const r = run('DELETE FROM lines WHERE id=? AND run_id=? AND n=? AND added=1', id, runId, n);
        ok = r.changes === 1;
        if (ok) run('UPDATE tasks SET cnt=cnt-1 WHERE run_id=? AND n=?', runId, n);
      });
      return ok;
    },
    lagerplaetze: (runId, n) =>
      all('SELECT DISTINCT lagerplatz FROM lines WHERE run_id=? AND n=? ORDER BY lagerplatz', runId, n)
        .map((r) => r.lagerplatz),
    countEmpty: (runId, n) =>
      get('SELECT COUNT(*) c FROM lines WHERE run_id=? AND n=? AND menge IS NULL', runId, n).c,
    saveLines(runId, n, upd, ts) {
      const st = db.prepare('UPDATE lines SET menge=?, counted_at=? WHERE id=? AND run_id=? AND n=?');
      tx(() => { for (const l of upd) st.run(l.menge, l.menge === null ? null : ts, l.id, runId, n); });
    },

    // Import / Export
    hasActivity: (runId) =>
      get("SELECT COUNT(*) c FROM tasks WHERE run_id=? AND status<>'open'", runId).c > 0,
    clearRun(runId) {
      tx(() => {
        run('DELETE FROM lines WHERE run_id=?', runId);
        run('DELETE FROM tasks WHERE run_id=?', runId);
        run('DELETE FROM workers WHERE run_id=?', runId);
      });
    },
    importRun(runId, rows) {
      const insL = db.prepare('INSERT INTO lines(run_id,n,lagerplatz,itemcode) VALUES(?,?,?,?)');
      tx(() => {
        run('DELETE FROM lines WHERE run_id=?', runId);
        run('DELETE FROM tasks WHERE run_id=?', runId);
        for (const r of rows) insL.run(runId, r.n, r.lagerplatz, r.itemcode);
        run(`INSERT INTO tasks(run_id,n,von,bis,cnt)
             SELECT ?, n, MIN(lagerplatz), MAX(lagerplatz), COUNT(*)
             FROM lines WHERE run_id=? GROUP BY n`, runId, runId);
      });
    },
    importWorkers(runId, workers) {
      const insW = db.prepare('INSERT OR IGNORE INTO workers(run_id,name,pin) VALUES(?,?,?)');
      tx(() => {
        run('DELETE FROM workers WHERE run_id=?', runId);
        for (const w of workers) insW.run(runId, w.name, w.pin);
      });
    },
    listWorkers: (runId) => all('SELECT name FROM workers WHERE run_id=? ORDER BY name', runId).map((r) => r.name),
    listWorkersFull: (runId) => all('SELECT name, pin FROM workers WHERE run_id=? ORDER BY name', runId),
    getWorkerPin: (runId, name) => get('SELECT pin FROM workers WHERE run_id=? AND name=?', runId, name)?.pin ?? null,
    addWorker(runId, name, pin) {
      const r = run('INSERT OR IGNORE INTO workers(run_id,name,pin) VALUES(?,?,?)', runId, name, pin);
      return r.changes === 1;
    },
    setWorkerPin(runId, name, pin) {
      const r = run('UPDATE workers SET pin=? WHERE run_id=? AND name=?', pin, runId, name);
      return r.changes === 1;
    },
    removeWorker(runId, name) {
      const r = run('DELETE FROM workers WHERE run_id=? AND name=?', runId, name);
      return r.changes === 1;
    },
    summary: (runId) => ({
      lines: get('SELECT COUNT(*) c FROM lines WHERE run_id=?', runId).c,
      tasks: get('SELECT COUNT(*) c FROM tasks WHERE run_id=?', runId).c,
      done: get("SELECT COUNT(*) c FROM tasks WHERE run_id=? AND status='done'", runId).c,
      empty: get('SELECT COUNT(*) c FROM lines WHERE run_id=? AND menge IS NULL', runId).c,
    }),
    exportRows: (runId) =>
      all(`SELECT l.n, l.lagerplatz, l.itemcode, l.itemcode_soll, l.added, l.menge, l.counted_at, t.worker
           FROM lines l LEFT JOIN tasks t ON t.run_id=l.run_id AND t.n=l.n
           WHERE l.run_id=? ORDER BY l.n, l.id`, runId),
  };
}
