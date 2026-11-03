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
- MKV-Dateien spielt Safari nicht ab.
- Der Proxy blockt private/lokale Ziele (SSRF-Schutz).
