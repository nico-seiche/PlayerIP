# PlayerIP

IPTV-Player (Xtream Codes) als PWA für Browser, iPhone und iPad, mit AirPlay zum Apple TV.

- `public/` – App (Vanilla JS, kein Build-Schritt, hls.js liegt in `public/vendor/`)
- `api/proxy.js` – Vercel-Funktion, die Xtream-API und Streams durchreicht (CORS / http → https)

## Deploy (Vercel)

1. Repo in Vercel importieren (Framework: *Other*, kein Build-Befehl nötig).
2. Umgebungsvariable `ACCESS_KEY` setzen (langer zufälliger Wert). Ohne sie lehnt der Proxy alles ab.
3. Auf dem iPhone/iPad in Safari öffnen, anmelden, *Teilen → Zum Home-Bildschirm*.

## AirPlay

Im Player erscheint oben rechts ein AirPlay-Symbol, sobald ein Apple TV im Netz erreichbar ist.
Safari spielt HLS nativ, nur dann ist AirPlay möglich. Auf Desktop-Chrome läuft die Wiedergabe über hls.js (ohne AirPlay).

## Hinweise

- Streams laufen direkt zum Anbieter, solange das geht. Nur bei http-Servern (Mixed Content) oder
  wenn "Streams immer über den Proxy" aktiv ist, laufen sie über Vercel (Kontingent beachten).
- MKV-Dateien spielt Safari nicht direkt ab. Die App versucht dann zuerst eine HLS-Variante des Anbieters und packt
  sonst das MKV im Browser um (`public/vendor/mkvstream.js`, experimentell, ohne AirPlay). Das läuft nur, wenn das
  Gerät Bild- und Tonformat ohnehin dekodieren kann (z. B. H.264/HEVC + AAC/AC-3, kein DTS). Die Daten laufen dabei
  über den Proxy (Vercel-Kontingent!).
- Offline: Filme und Folgen lassen sich über „Herunterladen“ in den Speicher der PWA laden (`public/downloads.js`,
  Stücke à 8 MB über den Proxy, in IndexedDB, fortsetzbar). Das läuft nur im Vordergrund; beim Sperren pausiert der
  Download und läuft danach weiter. Kostet einmal so viel Vercel-Datenvolumen wie das Anschauen.
- Der Proxy blockt private/lokale Ziele (SSRF-Schutz).

## MKV-Umwandlung neu bauen

`public/vendor/mkvstream.js` wird aus `tools/mkvstream.src.js` mit esbuild und der Bibliothek
[mediabunny](https://mediabunny.dev) (MPL-2.0) erzeugt:

```
cd tools && npm install && npm run build
```
