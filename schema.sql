-- Inventur — schema (SQLite / Cloudflare D1)

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth (
  k    TEXT PRIMARY KEY,   -- 'admin' | 'worker'
  hash TEXT NOT NULL,
  salt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  ip    TEXT PRIMARY KEY,
  cnt   INTEGER NOT NULL DEFAULT 0,
  until TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  run_id   INTEGER NOT NULL,
  n        INTEGER NOT NULL,
  von      TEXT,
  bis      TEXT,
  cnt      INTEGER NOT NULL DEFAULT 0,
  status   TEXT NOT NULL DEFAULT 'open',   -- open | taken | done
  worker   TEXT,
  taken_at TEXT,
  done_at  TEXT,
  PRIMARY KEY (run_id, n)
);

CREATE TABLE IF NOT EXISTS lines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL,
  n             INTEGER NOT NULL,
  lagerplatz    TEXT NOT NULL,
  itemcode      TEXT NOT NULL,
  itemcode_soll TEXT,              -- ursprünglicher Artikel, sobald geändert wurde
  added         INTEGER NOT NULL DEFAULT 0,  -- 1 = vom Mitarbeiter zusätzlich erfasst
  menge         REAL,
  counted_at    TEXT
);

CREATE INDEX IF NOT EXISTS ix_lines_task ON lines (run_id, n, id);

CREATE TABLE IF NOT EXISTS workers (
  run_id INTEGER NOT NULL,
  name   TEXT NOT NULL,
  pin    TEXT,                     -- Klartext, individuell je Mitarbeiter, aus dem CSV-Import
  PRIMARY KEY (run_id, name)
);
