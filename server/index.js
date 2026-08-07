// Adapter Node → src/handlers.js. Ohne Abhängigkeiten: node:http + node:sqlite.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../src/handlers.js';
import { createRepo } from '../src/repo/sqlite.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const env = { TOKEN_SECRET: process.env.TOKEN_SECRET };
if (!env.TOKEN_SECRET) { console.error('TOKEN_SECRET ist nicht gesetzt'); process.exit(1); }

const repo = createRepo(process.env.DB_PATH ?? join(root, 'data', 'inventur.db'), join(root, 'schema.sql'));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

const readBody = (r) => new Promise((res) => {
  let d = ''; r.on('data', (c) => { d += c; if (d.length > 8e6) r.destroy(); }); r.on('end', () => res(d));
});

createServer(async (rq, rs) => {
  const url = new URL(rq.url, 'http://x');

  if (url.pathname.startsWith('/api/')) {
    let body = null;
    if (rq.method !== 'GET') { try { body = JSON.parse(await readBody(rq)); } catch { /* leer */ } }
    const req = {
      method: rq.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      ip: rq.headers['x-forwarded-for']?.split(',')[0].trim() ?? rq.socket.remoteAddress ?? '0.0.0.0',
      token: (rq.headers.authorization ?? '').replace(/^Bearer\s+/i, ''),
    };
    let res;
    try { res = await handle(req, repo, env); }
    catch (e) { console.error(e); res = { status: 500, json: { error: 'Serverfehler: ' + e.message } }; }

    const headers = { 'cache-control': 'no-store', ...(res.headers ?? {}) };
    if (res.text !== undefined) { rs.writeHead(res.status, headers); return rs.end(res.text); }
    rs.writeHead(res.status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    return rs.end(JSON.stringify(res.json));
  }

  // Statische Dateien aus public/
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = await readFile(join(root, 'public', rel));
    rs.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
    rs.end(file);
  } catch {
    rs.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    rs.end('Nicht gefunden');
  }
}).listen(PORT, () => console.log(`Inventur → http://localhost:${PORT}`));
