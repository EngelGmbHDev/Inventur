# Inventur

Bestandsaufnahme über die privaten Smartphones der Mitarbeiter. Jede Aufgabe wird
genau einmal vergeben; ein zweiter Zugriff auf dieselbe Aufgabe ist ausgeschlossen.

```
public/        Statik — wird unverändert übernommen
src/           Fachlogik, ohne Plattformbindung
  handlers.js  alle Regeln: Anmeldung, Aufgabenvergabe, Import, Export
  auth.js      PBKDF2 + HMAC über WebCrypto
  repo/        d1.js | sqlite.js — hier liegt das gesamte SQL
worker/        Adapter Cloudflare Workers (~35 Zeilen)
server/        Adapter Node: http + node:sqlite, ohne Abhängigkeiten
```

Regel für den Umzug: in `handlers.js` dürfen `env`, `context`, `waitUntil` und
`meta.changes` nicht auftauchen. Alles Plattformabhängige lebt in den beiden
Adaptern und in `repo/`.

## Eigener Server

```bash
openssl rand -hex 32                      # → TOKEN_SECRET
node server/setpin.js admin ACHTSTELLIG   # Code für die Verwaltung
TOKEN_SECRET=... node server/index.js     # http://localhost:8080
```

Docker: `docker compose up -d` (Domain in `compose.yaml` an das eigene Traefik anpassen).
Codes einmalig setzen: `docker compose exec inventur node server/setpin.js admin ...`

Erfordert Node 24. Unter Node 22 mit `--experimental-sqlite` starten.

## Cloudflare Workers

Ein Worker liefert sowohl die Statik aus `public/` (Asset-Bindung) als auch die
API unter `/api/*`. Reihenfolge zählt: erst die Datenbank anlegen, dann deployen.

```bash
wrangler d1 create inventur          # id → in wrangler.toml eintragen
wrangler d1 execute inventur --remote --file=schema.sql
wrangler deploy
wrangler secret put TOKEN_SECRET     # openssl rand -hex 32

wrangler d1 execute inventur --remote --command="$(node server/pinsql.js admin Sommer2026)"
```

Über die Dashboard-Oberfläche (Workers Builds, Git-Anbindung): Build command
leer lassen, Deploy command `npx wrangler deploy`. Die D1-Bindung und das Secret
kommen aus `wrangler.toml` bzw. den Worker-Settings — nicht in das Repository legen.

## Ablauf

1. Als Verwaltung anmelden → „Durchgang leeren", falls noch Daten vom letzten Mal vorliegen.
2. CSV `lagerplatz;itemcode;aufgabe_num` und die Mitarbeiterliste `name;pincode` einfügen
   → „Laden und prüfen". Jeder Mitarbeiter bekommt hier seinen eigenen Code (mind. 4 Zeichen,
   im Klartext in der Datenbank — kein sensibler Login). Geprüft werden doppelte Paare und
   Lagerplätze, die in zwei Aufgaben geraten sind.
3. Anzahl Aufgaben und Zeilen gegen die Quelle abgleichen.
4. „Freigeben" — erst jetzt sind die Aufgaben auf den Telefonen sichtbar.
5. Zum Schluss „Sperren", danach „CSV herunterladen".

## Abweichender Artikel am Lagerplatz

Liegt am Platz etwas anderes als auf der Liste, tippt der Mitarbeiter auf die
Artikelnummer und korrigiert sie. Die ursprünglich erwartete Nummer bleibt in
`lines.itemcode_soll` erhalten und steht im Export in der Spalte `artikel_soll`,
Status `geaendert` — sonst wäre später nicht mehr erkennbar, dass der Sollartikel
gar nicht am Platz war.

Findet sich ein zusätzlicher Artikel, wird er über „Artikel hinzufügen" erfasst
(Status `neu`). Der Lagerplatz lässt sich nur aus den Plätzen der eigenen Aufgabe
wählen. Nur selbst hinzugefügte Zeilen lassen sich wieder entfernen; Zeilen aus
dem Import bleiben stehen und werden mit Menge 0 abgeschlossen.

## Verhalten bei Verbindungsabbruch

Jede eingegebene Menge landet sofort im `localStorage` des Telefons und geht in
Paketen an den Server. Ohne Netz bleibt die Zeile gelb, ein neuer Versuch läuft
alle 15 Sekunden. „Abgeben" greift nicht, solange Zeilen offen sind.

## Farbe des linken Streifens einer Zeile

grau — noch nicht gezählt · gelb — erfasst, aber noch nicht übertragen · grün — auf dem Server

Zusätzliche Kennzeichnung an der Zeile: `Soll: 12345` — Artikel wurde korrigiert;
`neu erfasst` — Zeile stammt nicht aus dem Import.
