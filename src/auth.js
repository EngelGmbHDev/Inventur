// PBKDF2 + HMAC über WebCrypto — identisch auf Workers und Node 18+.
const enc = new TextEncoder();

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const unb64u = (s) => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const ITER = 100000;

export async function hashPin(pin, saltB64) {
  const salt = saltB64 ? unb64u(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, key, 256);
  return { hash: b64u(bits), salt: b64u(salt) };
}

export async function checkPin(pin, hash, salt) {
  const got = await hashPin(pin, salt);
  // constant-time-ish compare
  if (got.hash.length !== hash.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= got.hash.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function makeToken(payload, secret, ttlSec = 14 * 3600) {
  const p = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const body = b64u(enc.encode(JSON.stringify(p)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + b64u(sig);
}

export async function readToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = b64u(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  if (expect !== sig) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(body)));
    if (p.exp && p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}
