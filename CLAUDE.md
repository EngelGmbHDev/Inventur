# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Inventur (German for "stocktaking") tracks a physical inventory count of employees' private
smartphones. Work is split into numbered tasks; each task can only be claimed and worked by one
person at a time. There are two roles: `admin` (Verwaltung — imports data, releases/locks the run,
exports results) and `worker` (Mitarbeiter — claims a task and counts items at each storage
location, `lagerplatz`).

The core rule of the codebase: **the same business logic runs unmodified on two completely
different platforms** — Cloudflare Workers (D1) in production, and a dependency-free Node server
(`node:sqlite`) for self-hosting. `src/handlers.js` must stay ignorant of both.

## Architecture

```
public/        Static frontend (vanilla JS, no build step) — served as-is on both platforms
src/           Platform-agnostic business logic
  handlers.js  All rules: login, task assignment, CSV import, export — the file to read first
  auth.js      PBKDF2 (pin hashing) + HMAC (bearer tokens) via WebCrypto — works unchanged on
               Workers and Node 18+
  repo/d1.js       Cloudflare D1 adapter (async, batched)
  repo/sqlite.js   node:sqlite adapter (sync, uses real transactions) — the two are independent
                   copies of the same SQL; a schema change must be applied to both
worker/index.js   Cloudflare Workers adapter (~35 lines): routes /api/* to handle(), everything
                  else to the ASSETS binding
server/index.js   Node adapter: node:http + node:sqlite, zero npm dependencies
server/setpin.js   Sets the admin PIN directly against the local sqlite DB (admin only — worker
                   PINs are per-person now, set via CSV import, see below)
server/pinsql.js   Prints the equivalent SQL for setting the admin PIN remotely against D1
schema.sql        Single source of truth for the schema (SQLite dialect, used by both adapters)
```

**The hard boundary**: `handlers.js` (and everything it calls in `repo/`) must never reference
`env`, `context`, `waitUntil`, or Cloudflare-specific globals — those exist only in the two
adapters (`worker/index.js`, `server/index.js`). This is what keeps the same logic portable
between a Cloudflare account and a self-hosted Docker container. When adding a feature, put the
platform-independent rule in `handlers.js` and any platform-specific plumbing in the adapters.

Request/response shape passed into `handle(req, repo, env)`:
`req = { method, path, query, body, ip, token }` →
`{ status, json }` or `{ status, text, headers }`.

`RUN = 1` in `handlers.js` is a hardcoded single active inventory run; `run_id` is threaded through
the schema and repo layer for a future multi-run feature but is not currently used as such.

## Commands

```bash
# Self-hosted (Node ≥24, or Node 22 with --experimental-sqlite)
openssl rand -hex 32                      # → TOKEN_SECRET
node server/setpin.js admin ACHTSTELLIG   # set the admin PIN (min. 8 chars)
TOKEN_SECRET=... node server/index.js     # → http://localhost:8080

docker compose up -d                      # adjust the Traefik host in compose.yaml first
docker compose exec inventur node server/setpin.js admin ...

# Cloudflare Workers
wrangler dev                              # local dev
wrangler deploy                           # deploy — requires the D1 database to already exist,
                                           # see below; also requires TOKEN_SECRET to be set
wrangler d1 create inventur               # one-time: copy the returned id into wrangler.toml
wrangler d1 execute inventur --remote --file=schema.sql   # apply/update schema — NOT automatic
                                                            # on deploy, must be run manually
wrangler secret put TOKEN_SECRET

# Set the admin PIN against the remote D1 database (no local DB needed)
wrangler d1 execute inventur --remote --command="$(node server/pinsql.js admin Sommer2026)"
```

There is no test suite, no linter, and no CI workflow configured in this repo.

## Deployment notes

- **`git push` does not deploy.** There is no Cloudflare Workers Builds / Git integration wired
  up for this repo (confirmed: pushing to `main` did not produce a new deployment). Production
  only updates when someone runs `wrangler deploy`.
- A deploy does **not** run `schema.sql` against D1 and does **not** set secrets; those are
  separate, one-time, manual steps against the live D1 database/account and are not reflected
  anywhere in git.
- `wrangler.toml`'s `database_id` must match a D1 database that actually exists (`wrangler d1
  list`) — a stale or placeholder id makes the Worker fail to initialize for *every* request
  (Cloudflare error 1101), before `handle()` ever runs, and won't show up in `wrangler tail`.
- Order matters on first setup: create the D1 database and apply the schema *before* the first
  deploy that references it.

## Business rules worth knowing before changing handlers.js

- Two separate auth models, both in `login()`: **admin** is a single shared code, hashed
  (PBKDF2) in the `auth` table, entered with no worker name. **Workers** are individual — each
  gets their own PIN, stored as **plain text** in `workers.pin` (deliberate: low-stakes internal
  tool, and it lets the admin actually see/debug a worker's code, which a hash wouldn't allow).
  Worker PINs are set via CSV import (`parseWorkers`, format `name;pincode`, min. 4 chars) for bulk
  setup, or individually via `POST /admin/workers` (add), `POST /admin/workers/:name/pin` (change),
  `POST /admin/workers/:name/remove` — `:name` is URL-encoded since names can contain spaces. Login
  requires name selected first, then that worker's exact PIN checked directly against
  `workers.pin` — no lookup by PIN alone.
- The worker-CSV file upload and the "Laden und prüfen" button both run input through
  `trimWorkersCsv` (app.js) first, which drops every column past the second (`;`-delimited) —
  this app runs on a public server, so a source file with a third "real name" column (common when
  the loginname is a pseudonym like `user01`) must never leave the browser. `parseWorkers` on the
  server only ever reads the first two columns anyway, but the client-side trim means that data
  is never even transmitted, not just "not stored". Keep this in mind if the CSV format changes.
- Task import (`POST /admin/import`, `lagerplatz;itemcode;aufgabe_num;buchbestand`) and worker
  import (`POST /admin/import-workers`, `name;pincode`) are fully independent — separate buttons
  in the UI, separate repo calls (`importRun` / `importWorkers`), neither touches the other's
  tables. `parseCsv` rejects duplicate lagerplatz/itemcode pairs and flags any lagerplatz that
  spans two tasks. `itemcode` may be empty — that represents a lagerplatz that's expected to be
  empty (worker just confirms `menge=0`, or corrects the itemcode in place if something is
  actually found there). `buchbestand` is optional and, unlike everything else in `lines`, is
  **never sent to workers** (`getLines` doesn't select it) — it only shows up in the admin export
  (`exportRows`), for the Lagerist's own evaluation. Both imports fully replace their table for
  the run — re-importing workers wipes everyone not in the new list, including anyone added
  individually via the worker-management page.
- A line with an empty `itemcode` can only take `menge<=0` — a positive quantity requires an
  itemcode first (checked both client-side in `onEdit`, app.js, and server-side in the `lines`
  POST action, which silently drops offending updates rather than erroring). `0` stays valid so a
  worker can still confirm a lagerplatz is genuinely empty without naming an item.
- A task must be `open` to be claimed, and claiming is a single conditional UPDATE (`status='open'`
  in the WHERE clause) so two workers racing for the same task can't both succeed. The same UPDATE
  also carries a `NOT EXISTS` check against `worker`'s other `taken` tasks, so a worker can only
  ever have one active task at a time — must `complete` or `releaseTask` it before claiming another.
  Re-requesting a claim on a task the worker already holds is not an error; it just returns that
  task's lines.
- If the item actually found at a lagerplatz differs from the import, the worker corrects the
  itemcode in place; the original expected value is preserved in `lines.itemcode_soll` (see
  `setItemcode`) so the export can still show what was expected (`buchartikel`, status
  `geaendert`).
- Extra items not in the import are added via `addLine` with `added=1`; only those can be removed
  again (`removeLine` requires `added=1`) — imported rows must stay and get closed out with
  `menge=0` instead.
- `completeTask` refuses to close a task with empty (`menge IS NULL`) lines unless the client
  passes `force`.
- `releaseTask` ("Aufgabe verlassen" — for an accidentally claimed task) is destructive by design:
  besides reopening the task, it deletes any `added=1` lines, restores `itemcode` from
  `itemcode_soll` where set, and clears all `menge`/`counted_at` — the task goes back to exactly
  its post-import state. This is different from `completeTask`, which keeps everything entered.
- `adminResetTask` is the admin-triggered equivalent of `releaseTask` (same line-cleanup logic,
  factored into a shared `resetLines` helper in each repo adapter) but skips the worker-ownership
  check and also accepts `done` tasks, not just `taken` — for a task someone left half-finished (or
  finished wrong) and never released themselves. Reachable via `POST /admin/tasks/:n/reset`.
