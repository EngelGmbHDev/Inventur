// Adapter Cloudflare Workers (statische Assets + API) → src/handlers.js
import { handle } from '../src/handlers.js';
import { createRepo } from '../src/repo/d1.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Alles außerhalb von /api/ liefert die Asset-Bindung aus public/
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    let body = null;
    if (request.method !== 'GET') { try { body = await request.json(); } catch { /* leer */ } }

    const req = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
      ip: request.headers.get('cf-connecting-ip') ?? '0.0.0.0',
      token: (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''),
    };

    let res;
    try {
      res = await handle(req, createRepo(env.DB), env);
    } catch (e) {
      res = { status: 500, json: { error: 'Serverfehler: ' + e.message } };
    }

    const headers = { 'cache-control': 'no-store', ...(res.headers ?? {}) };
    if (res.text !== undefined) return new Response(res.text, { status: res.status, headers });
    return new Response(JSON.stringify(res.json), {
      status: res.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    });
  },
};
