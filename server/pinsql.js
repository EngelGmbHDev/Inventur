// Gibt fertiges SQL zum Setzen des Verwaltungscodes in D1 aus (keine lokale DB nötig).
//   node server/pinsql.js admin ACHTSTELLIG
// Mitarbeiter-Codes gibt es nicht mehr gemeinsam — die kommen individuell
// je Person aus dem CSV-Import (Verwaltung → „Aufgaben laden").
import { hashPin } from '../src/auth.js';

const [role, pin] = process.argv.slice(2);
if (role !== 'admin' || !pin) {
  console.error('Aufruf: node server/pinsql.js admin <Code>');
  process.exit(1);
}
if (pin.length < 8) { console.error('Admin-Code: mindestens 8 Zeichen'); process.exit(1); }

const { hash, salt } = await hashPin(pin);
console.log(
  `INSERT INTO auth(k,hash,salt) VALUES('${role}','${hash}','${salt}') ` +
  `ON CONFLICT(k) DO UPDATE SET hash=excluded.hash, salt=excluded.salt;`
);
