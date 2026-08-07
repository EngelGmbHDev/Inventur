// Codes setzen:  node server/setpin.js admin ACHTSTELLIG
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepo } from '../src/repo/sqlite.js';
import { hashPin } from '../src/auth.js';

const [role, pin] = process.argv.slice(2);
if (!['admin', 'worker'].includes(role) || !pin) {
  console.error('Aufruf: node server/setpin.js <admin|worker> <Code>');
  process.exit(1);
}
if (role === 'admin' && pin.length < 8) { console.error('Admin-Code: mindestens 8 Zeichen'); process.exit(1); }

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = createRepo(process.env.DB_PATH ?? join(root, 'data', 'inventur.db'), join(root, 'schema.sql'));
const { hash, salt } = await hashPin(pin);
repo.setAuth(role, hash, salt);
console.log(`Code für „${role}“ gesetzt.`);
