// Adapter für Cloudflare D1. Gleiche Schnittstelle wie sqlite.js, nur async.
export function createRepo(DB) {
  const P = (sql, ...a) => DB.prepare(sql).bind(...a);
  const all = async (sql, ...a) => (await P(sql, ...a).all()).results ?? [];
  const first = (sql, ...a) => P(sql, ...a).first();
  const run = (sql, ...a) => P(sql, ...a).run();

  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  };

  return {
    getSetting: async (k) => (await first('SELECT v FROM settings WHERE k=?', k))?.v ?? null,
    setSetting: (k, v) => run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v),
    getAuth: async (k) => (await first('SELECT hash,salt FROM auth WHERE k=?', k)) ?? null,
    setAuth: (k, hash, salt) =>
      run('INSERT INTO auth(k,hash,salt) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET hash=excluded.hash, salt=excluded.salt', k, hash, salt),

    async isBlocked(ip) {
      const r = await first('SELECT until FROM attempts WHERE ip=?', ip);
      if (!r?.until) return 0;
      const left = Math.ceil((Date.parse(r.until + 'Z') - Date.now()) / 60000);
      return left > 0 ? left : 0;
    },
    async bumpAttempt(ip, max, blockMin) {
      await run('INSERT INTO attempts(ip,cnt) VALUES(?,1) ON CONFLICT(ip) DO UPDATE SET cnt=cnt+1', ip);
      const r = await first('SELECT cnt FROM attempts WHERE ip=?', ip);
      if (r.cnt >= max)
        await run("UPDATE attempts SET cnt=0, until=datetime('now', ?) WHERE ip=?", `+${blockMin} minutes`, ip);
    },
    clearAttempts: (ip) => run('DELETE FROM attempts WHERE ip=?', ip),

    listTasks: (runId) => all('SELECT n, von, bis, cnt, status, worker FROM tasks WHERE run_id=? ORDER BY n', runId),
    getTask: async (runId, n) => (await first('SELECT n, status, worker FROM tasks WHERE run_id=? AND n=?', runId, n)) ?? null,
    activeTaskFor: async (runId, worker) =>
      (await first("SELECT n FROM tasks WHERE run_id=? AND worker=? AND status='taken'", runId, worker))?.n ?? null,

    async claimTask(runId, n, worker) {
      const r = await run(
        `UPDATE tasks SET status='taken', worker=?, taken_at=datetime('now')
         WHERE run_id=? AND n=? AND status='open'
           AND NOT EXISTS (SELECT 1 FROM tasks t2 WHERE t2.run_id=? AND t2.worker=? AND t2.status='taken')`,
        worker, runId, n, runId, worker);
      return r.meta.changes === 1;
    },
    async releaseTask(runId, n, worker) {
      const r = await run(
        "UPDATE tasks SET status='open', worker=NULL, taken_at=NULL WHERE run_id=? AND n=? AND worker=? AND status='taken'",
        runId, n, worker);
      if (r.meta.changes !== 1) return false;
      await DB.batch([
        P('DELETE FROM lines WHERE run_id=? AND n=? AND added=1', runId, n),
        P(`UPDATE lines SET itemcode=COALESCE(itemcode_soll, itemcode), itemcode_soll=NULL, menge=NULL, counted_at=NULL
           WHERE run_id=? AND n=?`, runId, n),
      ]);
      await run('UPDATE tasks SET cnt=(SELECT COUNT(*) FROM lines WHERE run_id=? AND n=?) WHERE run_id=? AND n=?',
        runId, n, runId, n);
      return true;
    },
    completeTask: (runId, n, worker, ts) =>
      run("UPDATE tasks SET status='done', done_at=? WHERE run_id=? AND n=? AND worker=?", ts, runId, n, worker),

    getLines: (runId, n) =>
      all(`SELECT id, lagerplatz, itemcode, itemcode_soll, added, menge
           FROM lines WHERE run_id=? AND n=? ORDER BY lagerplatz, id`, runId, n),
    async setItemcode(runId, n, id, itemcode) {
      const r = await run(`UPDATE lines SET itemcode_soll=COALESCE(itemcode_soll, itemcode), itemcode=?
                           WHERE id=? AND run_id=? AND n=?`, itemcode, id, runId, n);
      return r.meta.changes === 1;
    },
    async addLine(runId, n, lagerplatz, itemcode, menge, ts) {
      const r = await run(`INSERT INTO lines(run_id,n,lagerplatz,itemcode,added,menge,counted_at)
                           VALUES(?,?,?,?,1,?,?)`, runId, n, lagerplatz, itemcode, menge, ts);
      await run('UPDATE tasks SET cnt=cnt+1 WHERE run_id=? AND n=?', runId, n);
      return Number(r.meta.last_row_id);
    },
    async removeLine(runId, n, id) {
      const r = await run('DELETE FROM lines WHERE id=? AND run_id=? AND n=? AND added=1', id, runId, n);
      if (r.meta.changes !== 1) return false;
      await run('UPDATE tasks SET cnt=cnt-1 WHERE run_id=? AND n=?', runId, n);
      return true;
    },
    lagerplaetze: async (runId, n) =>
      (await all('SELECT DISTINCT lagerplatz FROM lines WHERE run_id=? AND n=? ORDER BY lagerplatz', runId, n))
        .map((r) => r.lagerplatz),
    countEmpty: async (runId, n) =>
      (await first('SELECT COUNT(*) c FROM lines WHERE run_id=? AND n=? AND menge IS NULL', runId, n)).c,
    async saveLines(runId, n, upd, ts) {
      if (!upd.length) return;
      await DB.batch(upd.map((l) =>
        P('UPDATE lines SET menge=?, counted_at=? WHERE id=? AND run_id=? AND n=?',
          l.menge, l.menge === null ? null : ts, l.id, runId, n)));
    },

    hasActivity: async (runId) =>
      (await first("SELECT COUNT(*) c FROM tasks WHERE run_id=? AND status<>'open'", runId)).c > 0,
    clearRun: (runId) => DB.batch([
      P('DELETE FROM lines WHERE run_id=?', runId),
      P('DELETE FROM tasks WHERE run_id=?', runId),
      P('DELETE FROM workers WHERE run_id=?', runId),
    ]),
    async importRun(runId, rows, workers) {
      await DB.batch([
        P('DELETE FROM lines WHERE run_id=?', runId),
        P('DELETE FROM tasks WHERE run_id=?', runId),
        P('DELETE FROM workers WHERE run_id=?', runId),
      ]);
      for (const part of chunk(rows, 400))
        await DB.batch(part.map((r) =>
          P('INSERT INTO lines(run_id,n,lagerplatz,itemcode) VALUES(?,?,?,?)', runId, r.n, r.lagerplatz, r.itemcode)));
      const w = workers.map((x) => String(x).trim()).filter(Boolean);
      if (w.length)
        await DB.batch(w.map((name) => P('INSERT OR IGNORE INTO workers(run_id,name) VALUES(?,?)', runId, name)));
      await run(`INSERT INTO tasks(run_id,n,von,bis,cnt)
                 SELECT ?, n, MIN(lagerplatz), MAX(lagerplatz), COUNT(*)
                 FROM lines WHERE run_id=? GROUP BY n`, runId, runId);
    },
    listWorkers: async (runId) => (await all('SELECT name FROM workers WHERE run_id=? ORDER BY name', runId)).map((r) => r.name),
    async summary(runId) {
      const q = async (sql) => (await first(sql, runId)).c;
      return {
        lines: await q('SELECT COUNT(*) c FROM lines WHERE run_id=?'),
        tasks: await q('SELECT COUNT(*) c FROM tasks WHERE run_id=?'),
        done: await q("SELECT COUNT(*) c FROM tasks WHERE run_id=? AND status='done'"),
        empty: await q('SELECT COUNT(*) c FROM lines WHERE run_id=? AND menge IS NULL'),
      };
    },
    exportRows: (runId) =>
      all(`SELECT l.n, l.lagerplatz, l.itemcode, l.itemcode_soll, l.added, l.menge, l.counted_at, t.worker
           FROM lines l LEFT JOIN tasks t ON t.run_id=l.run_id AND t.n=l.n
           WHERE l.run_id=? ORDER BY l.n, l.id`, runId),
  };
}
