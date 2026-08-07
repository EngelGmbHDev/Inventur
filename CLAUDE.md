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
server/setpin.js   Sets an admin/worker PIN directly against the local sqlite DB
server/pinsql.js   Prints the equivalent SQL for setting a PIN remotely against D1
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
node server/setpin.js worker 4711         # set the starting worker PIN
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

# Set PINs against the remote D1 database (no local DB needed)
wrangler d1 execute inventur --remote --command="$(node server/pinsql.js admin Sommer2026)"
wrangler d1 execute inventur --remote --command="$(node server/pinsql.js worker 4711)"
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

- CSV import (`lagerplatz;itemcode;aufgabe_num`) rejects duplicate lagerplatz/itemcode pairs and
  flags any lagerplatz that spans two tasks (`parseCsv` in handlers.js).
- A task must be `open` to be claimed, and claiming is a single conditional UPDATE (`status='open'`
  in the WHERE clause) so two workers racing for the same task can't both succeed.
- If the item actually found at a lagerplatz differs from the import, the worker corrects the
  itemcode in place; the original expected value is preserved in `lines.itemcode_soll` (see
  `setItemcode`) so the export can still show what was expected (`artikel_soll`, status
  `geaendert`).
- Extra items not in the import are added via `addLine` with `added=1`; only those can be removed
  again (`removeLine` requires `added=1`) — imported rows must stay and get closed out with
  `menge=0` instead.
- `completeTask` refuses to close a task with empty (`menge IS NULL`) lines unless the client
  passes `force`.
