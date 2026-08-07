// Gibt fertiges SQL zum Setzen eines Codes in D1 aus (keine lokale DB nötig).
//   node server/pinsql.js admin ACHTSTELLIG
import { hashPin } from '../src/auth.js';

const [role, pin] = process.argv.slice(2);
if (!['admin', 'worker'].includes(role) || !pin) {
  console.error('Aufruf: node server/pinsql.js <admin|worker> <Code>');
  process.exit(1);
}
if (role === 'admin' && pin.length < 8) { console.error('Admin-Code: mindestens 8 Zeichen'); process.exit(1); }

const { hash, salt } = await hashPin(pin);
console.log(
  `INSERT INTO auth(k,hash,salt) VALUES('${role}','${hash}','${salt}') ` +
  `ON CONFLICT(k) DO UPDATE SET hash=excluded.hash, salt=excluded.salt;`
);
