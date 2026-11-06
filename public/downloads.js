'use strict';

/* ---------- Offline-Downloads ----------
   Filme und Serienfolgen werden in Stücken (Range-Anfragen über den Proxy) heruntergeladen und als Blobs in
   IndexedDB gespeichert. Das ist fortsetzbar und braucht nie die ganze Datei im Arbeitsspeicher.
   Abspielen: MP4 & Co. direkt aus dem zusammengesetzten Blob, MKV über die Umwandlung im Browser (aus dem Blob).
   Grenzen: iOS lässt Web-Apps im Hintergrund nichts laden. Beim Sperren oder Wechseln pausiert der Download und
   läuft beim Zurückkommen automatisch weiter. Benutzt werden `$`, `el`, `show`, `proxify`, `cfg`, `formatSize`
   aus app.js (erst beim Aufruf, nicht beim Laden). */

const DL_CHUNK_DEFAULT = 8 * 1024 * 1024;
const dlChunk = () => window.__dlChunk || DL_CHUNK_DEFAULT; // window.__dlChunk nur für Tests
const DL_MIME = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm', avi: 'video/x-msvideo' };

/* ----- Speicher ----- */
const dlDb = (() => {
  let dbp;
  const open = () => (dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('playerip-dl', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'id' });
      r.result.createObjectStore('chunks');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const run = async (stores, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      const out = fn(...stores.map((s) => tx.objectStore(s)));
      tx.oncomplete = () => resolve(out?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new DOMException('Speicher voll', 'QuotaExceededError'));
    });
  };
  const key = (id, i) => `${id}|${String(i).padStart(6, '0')}`;
  const range = (id) => IDBKeyRange.bound(`${id}|`, `${id}|￿`);
  return {
    metaAll: () => run(['meta'], 'readonly', (m) => m.getAll()),
    metaPut: (meta) => run(['meta'], 'readwrite', (m) => m.put(JSON.parse(JSON.stringify(meta)))),
    chunkPut: (id, i, blob) => run(['chunks'], 'readwrite', (c) => c.put(blob, key(id, i))),
    chunksGet: (id) => run(['chunks'], 'readonly', (c) => c.getAll(range(id))),
    remove: (id) => run(['meta', 'chunks'], 'readwrite', (m, c) => { c.delete(range(id)); return m.delete(id); }),
  };
})();

/* ----- Zustand ----- */
const dlMetas = new Map(); // id -> meta
const dl = { active: null, wake: null, speed: 0 };

function dlEmit(meta, structural = false) {
  document.dispatchEvent(new CustomEvent('dlchange', { detail: { id: meta.id, structural } }));
  dlUpdateHomeBadge();
}

function dlUpdateHomeBadge() {
  const n = [...dlMetas.values()].length;
  const b = $('#offline-count');
  if (b) { b.textContent = n ? String(n) : ''; b.hidden = !n; }
}

// Stream-Adresse aus den gemerkten Angaben bauen (Zugangsdaten werden nicht in der Datei-Info gespeichert)
function dlUrl(meta) {
  const path = meta.kind === 'vod' ? 'movie' : 'series';
  return `${cfg.server}/${path}/${cfg.username}/${cfg.password}/${meta.itemId}.${meta.ext}`;
}

async function dlInit() {
  try {
    for (const m of await dlDb.metaAll()) {
      if (m.state === 'downloading' || m.state === 'queued') { m.state = 'paused'; dlDb.metaPut(m); }
      dlMetas.set(m.id, m);
    }
  } catch { /* Speicher nicht verfügbar (z. B. privater Modus) */ }
  dlUpdateHomeBadge();
}

/* ----- Steuerung ----- */
async function dlStart(desc) {
  const meta = { ...desc, state: 'queued', got: 0, size: 0, chunks: 0, created: Date.now(), error: '', auto: false };
  dlMetas.set(meta.id, meta);
  try { await dlDb.metaPut(meta); } catch { /* wird beim ersten Stück erneut versucht */ }
  navigator.storage?.persist?.().catch(() => {});
  dlEmit(meta, true);
  dlPump();
}

function dlPause(id) {
  const m = dlMetas.get(id);
  if (!m || m.state === 'done') return;
  m.state = 'paused';
  m.auto = false;
  if (dl.active?.id === id) dl.active.ctl.abort();
  dlDb.metaPut(m).catch(() => {});
  dlEmit(m);
}

function dlResume(id) {
  const m = dlMetas.get(id);
  if (!m || m.state === 'done') return;
  m.state = 'queued';
  m.error = '';
  dlDb.metaPut(m).catch(() => {});
  dlEmit(m);
  dlPump();
}

async function dlRemove(id) {
  const m = dlMetas.get(id);
  if (!m) return;
  if (dl.active?.id === id) dl.active.ctl.abort();
  dlMetas.delete(id);
  await dlDb.remove(id).catch(() => {});
  dlEmit(m, true);
}

function dlPump() {
  if (dl.active) return;
  const next = [...dlMetas.values()].filter((m) => m.state === 'queued').sort((a, b) => a.created - b.created)[0];
  if (next) dlRun(next);
}

async function dlWake(on) {
  try {
    if (on && !dl.wake && navigator.wakeLock) {
      dl.wake = await navigator.wakeLock.request('screen');
      dl.wake.addEventListener?.('release', () => { dl.wake = null; });
    } else if (!on && dl.wake) {
      await dl.wake.release();
      dl.wake = null;
    }
  } catch { /* nicht unterstützt oder abgelehnt */ }
}

/* ----- Herunterladen ----- */
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new TypeError('Zeitüberschreitung')), ms))]);

async function dlRequest(url, offset, want, signal) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
    try {
      const res = await withTimeout(fetch(url, { headers: { Range: `bytes=${offset}-${offset + want - 1}` }, signal }), 45000);
      if (res.status >= 500 || res.status === 429) throw new TypeError(`Server antwortet mit ${res.status}`);
      return res;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function dlReadUpTo(res, want, signal) {
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  try {
    while (n < want) {
      const { done, value } = await withTimeout(reader.read(), 30000);
      if (done) break;
      parts.push(value);
      n += value.length;
    }
  } finally {
    reader.cancel().catch(() => {}); // beendet auch die Verbindung zum Anbieter, wenn er mehr liefert als gewünscht
  }
  if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
  const blob = new Blob(parts);
  return blob.size > want ? blob.slice(0, want) : blob;
}

// Server ignoriert Range: ganze Datei als Strom lesen und selbst in Stücke teilen (nicht fortsetzbar)
async function dlStreamAll(res, meta, signal) {
  const reader = res.body.getReader();
  let buf = [];
  let n = 0;
  const flush = async () => {
    if (!n) return;
    const blob = new Blob(buf);
    await dlDb.chunkPut(meta.id, meta.chunks, blob);
    meta.chunks += 1;
    meta.got += blob.size;
    buf = [];
    n = 0;
    await dlDb.metaPut(meta);
    dlEmit(meta);
  };
  try {
    for (;;) {
      const { done, value } = await withTimeout(reader.read(), 30000);
      if (done) break;
      buf.push(value);
      n += value.length;
      if (n >= dlChunk()) await flush();
    }
    await flush();
  } finally {
    reader.cancel().catch(() => {});
  }
  if (signal.aborted) throw new DOMException('Abgebrochen', 'AbortError');
  if (!meta.size) meta.size = meta.got;
}

async function dlRun(meta) {
  const ctl = new AbortController();
  dl.active = { id: meta.id, ctl };
  meta.state = 'downloading';
  meta.error = '';
  dlEmit(meta);
  dlWake(true);
  let lastT = performance.now();
  let lastB = meta.got;
  try {
    const url = proxify(dlUrl(meta));
    if (meta.noRange && meta.got > 0) { // nicht fortsetzbar: von vorn beginnen
      await dlDb.remove(meta.id).catch(() => {});
      await dlDb.metaPut(meta);
      meta.got = 0;
      meta.chunks = 0;
    }
    while (!meta.size || meta.got < meta.size) {
      const want = dlChunk();
      const res = await dlRequest(url, meta.got, want, ctl.signal);
      if (!res.ok) throw new Error(`Der Server antwortet mit Fehler ${res.status}.`);
      const range = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
      if (res.status === 200) {
        if (meta.got > 0) throw new Error('Der Server unterstützt keine Teil-Downloads. Bitte Download neu starten.');
        meta.noRange = true;
        meta.size = Number(res.headers.get('content-length')) || 0;
        await dlStreamAll(res, meta, ctl.signal);
        break;
      }
      if (range) meta.size = Number(range[1]);
      const blob = await dlReadUpTo(res, want, ctl.signal);
      if (!blob.size) throw new Error('Der Server hat keine Daten geliefert.');
      await dlDb.chunkPut(meta.id, meta.chunks, blob);
      meta.chunks += 1;
      meta.got += blob.size;
      meta.auto = false;
      await dlDb.metaPut(meta);
      const now = performance.now();
      dl.speed = (meta.got - lastB) / Math.max(0.001, (now - lastT) / 1000);
      lastT = now;
      lastB = meta.got;
      dlEmit(meta);
    }
    if (meta.size && meta.got < meta.size) throw new TypeError('Download unvollständig');
    meta.state = 'done';
    meta.finished = Date.now();
    await dlDb.metaPut(meta);
  } catch (e) {
    if (ctl.signal.aborted || e.name === 'AbortError') {
      // Pause oder Löschen: Zustand setzt der Aufrufer
    } else if (e.name === 'QuotaExceededError' || /quota/i.test(e.message || '')) {
      meta.state = 'error';
      meta.error = 'Speicher voll. Lösche andere Downloads oder Platz auf dem Gerät.';
    } else if (e instanceof TypeError) { // Verbindung weg, Gerät gesperrt: später selbst fortsetzen
      meta.state = 'paused';
      meta.auto = true;
      meta.error = 'Unterbrochen. Läuft automatisch weiter, sobald die App wieder offen ist.';
    } else {
      meta.state = 'error';
      meta.error = e.message || 'Download fehlgeschlagen.';
    }
    if (dlMetas.has(meta.id)) dlDb.metaPut(meta).catch(() => {});
  } finally {
    if (!dlMetas.has(meta.id)) dlDb.remove(meta.id).catch(() => {}); // währenddessen gelöscht: Reste entfernen
    dl.active = null;
    dl.speed = 0;
    dlEmit(meta);
    if (![...dlMetas.values()].some((m) => m.state === 'queued')) dlWake(false);
    dlPump();
  }
}

function dlAutoResume() {
  if (document.hidden || navigator.onLine === false) return;
  for (const m of dlMetas.values()) if (m.state === 'paused' && m.auto) dlResume(m.id);
  if (dl.active) dlWake(true);
}
window.addEventListener('online', dlAutoResume);
document.addEventListener('visibilitychange', dlAutoResume);

/* ----- Oberfläche ----- */
// el() nimmt nur Text; für Kinder-Elemente:
const dlBox = (cls, ...children) => { const d = el('div', cls); d.append(...children); return d; };
const dlPct = (m) => (m.size ? Math.min(100, Math.floor((m.got / m.size) * 100)) : 0);
const dlActive = (m) => m && m.state !== 'done';
const dlStateText = (m) => ({
  queued: 'Wartet …',
  downloading: dl.speed > 1e5 ? `Lädt · ${formatSize(dl.speed)}/s` : 'Lädt …',
  paused: m.auto ? 'Unterbrochen' : 'Pausiert',
  error: 'Fehler',
}[m.state] || '');

// Download-Bedienung, die sich bei Änderungen selbst aktualisiert. compact = nur ein runder Knopf (Folgenliste).
function dlControl(desc, compact = false) {
  const root = el('div', compact ? 'dl dl-compact' : 'dl');
  const btn = (label, cls, fn) => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    b.addEventListener('keydown', (e) => e.stopPropagation());
    return b;
  };
  const paint = () => {
    const m = dlMetas.get(desc.id);
    if (compact) {
      let b;
      if (!m) b = btn('⬇', 'dl-circle', () => dlStart(desc));
      else if (m.state === 'done') b = btn('✓', 'dl-circle done', () => { if (confirm('Offline-Datei löschen?')) dlRemove(m.id); });
      else if (m.state === 'downloading' || m.state === 'queued') b = btn(`${dlPct(m)}%`, 'dl-circle busy', () => dlPause(m.id));
      else b = btn('▶', 'dl-circle', () => dlResume(m.id));
      b.setAttribute('aria-label', m ? dlStateText(m) || 'Offline verfügbar' : 'Herunterladen');
      root.replaceChildren(b);
      return;
    }
    if (!m) { root.replaceChildren(btn('⬇ Herunterladen', 'dl-btn', () => dlStart(desc))); return; }
    if (m.state === 'done') {
      root.replaceChildren(el('span', 'dl-done', `✓ Offline verfügbar (${formatSize(m.size || m.got)})`),
        btn('Löschen', 'dl-small', () => { if (confirm('Offline-Datei löschen?')) dlRemove(m.id); }));
      return;
    }
    root.replaceChildren(dlProgress(m), dlBox('dl-actions',
      ...(m.state === 'downloading' || m.state === 'queued' ? [btn('Pause', 'dl-small', () => dlPause(m.id))] : [btn(m.state === 'error' ? 'Erneut versuchen' : 'Fortsetzen', 'dl-small', () => dlResume(m.id))]),
      btn('Abbrechen', 'dl-small', () => dlRemove(m.id))));
  };
  const on = (e) => {
    if (!root.isConnected) { document.removeEventListener('dlchange', on); return; }
    if (e.detail.id === desc.id) paint();
  };
  document.addEventListener('dlchange', on);
  paint();
  return root;
}

function dlProgress(m) {
  const bar = el('div', 'dl-bar');
  const fill = el('div');
  fill.style.width = `${dlPct(m)}%`;
  bar.append(fill);
  const text = el('div', 'dl-text', `${dlPct(m)} % · ${formatSize(m.got)}${m.size ? ` von ${formatSize(m.size)}` : ''} · ${dlStateText(m)}${m.error ? ` – ${m.error}` : ''}`);
  return dlBox('dl-progress', bar, text);
}

/* ----- Bereich "Offline" ----- */
async function renderOffline() {
  const list = $('#offline-list');
  const metas = [...dlMetas.values()].sort((a, b) => b.created - a.created);
  list.replaceChildren();
  show($('#offline-empty'), metas.length === 0);
  for (const m of metas) {
    const row = el('li', 'off-item');
    const head = dlBox('off-head', el('div', 'off-title', m.title), el('div', 'off-sub', [m.sub, String(m.ext).toUpperCase()].filter(Boolean).join(' · ')));
    const ctl = dlControl({ id: m.id }, false);
    row.append(head, ctl);
    if (m.state === 'done') {
      const play = el('button', 'primary dl-play', '▶ Abspielen');
      play.type = 'button';
      play.addEventListener('click', () => playDownloaded(m));
      row.append(play);
    }
    list.append(row);
  }
  try {
    const est = await navigator.storage?.estimate?.();
    const used = metas.reduce((n, m) => n + (m.got || 0), 0);
    $('#offline-storage').textContent = `Heruntergeladen: ${formatSize(used)}${est?.quota ? ` · Speicher des Browsers: ca. ${formatSize(est.usage)} von ${formatSize(est.quota)}` : ''}`;
  } catch { $('#offline-storage').textContent = ''; }
}

// Wenn sich ein fertiger Download ändert oder etwas hinzukommt/entfernt wird, die Liste neu aufbauen
document.addEventListener('dlchange', (e) => {
  if (typeof nav === 'undefined' || nav.section !== 'offline') return;
  const m = dlMetas.get(e.detail.id);
  if (e.detail.structural || m?.state === 'done') renderOffline();
});
