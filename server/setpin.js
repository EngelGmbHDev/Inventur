// Verwaltungscode setzen:  node server/setpin.js admin ACHTSTELLIG
// Mitarbeiter-Codes gibt es nicht mehr gemeinsam — die kommen individuell
// je Person aus dem CSV-Import (Verwaltung → „Aufgaben laden").
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepo } from '../src/repo/sqlite.js';
import { hashPin } from '../src/auth.js';

const [role, pin] = process.argv.slice(2);
if (role !== 'admin' || !pin) {
  console.error('Aufruf: node server/setpin.js admin <Code>');
  process.exit(1);
}
if (pin.length < 8) { console.error('Admin-Code: mindestens 8 Zeichen'); process.exit(1); }

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = createRepo(process.env.DB_PATH ?? join(root, 'data', 'inventur.db'), join(root, 'schema.sql'));
const { hash, salt } = await hashPin(pin);
repo.setAuth(role, hash, salt);
console.log(`Code für „${role}“ gesetzt.`);
