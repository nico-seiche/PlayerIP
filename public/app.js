'use strict';

/* ---------- Zustand & Hilfsfunktionen ---------- */

const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 100;
// Formate, die Safari (iPhone/iPad/Mac) direkt abspielt. MKV, AVI usw. nicht.
const PLAYABLE_EXT = new Set(['mp4', 'm4v', 'mov', 'm3u8']);
const isPlayable = (it) => PLAYABLE_EXT.has(String(it.ext).toLowerCase());
// MKV kann Safari nicht direkt, aber die App kann es im Browser umpacken (experimentell, braucht Media Source).
const canRemux = () => Boolean(window.ManagedMediaSource || window.MediaSource);
const fmtClass = (ext) => (PLAYABLE_EXT.has(String(ext).toLowerCase()) ? 'ok' : (/^mkv$/i.test(ext) && canRemux() ? 'warn' : 'bad'));
const fmtTitle = (ext) => ({ ok: 'Wird abgespielt', warn: 'MKV: wird im Browser umgewandelt (experimentell)', bad: 'Safari kann dieses Format evtl. nicht abspielen' }[fmtClass(ext)]);
const TYPES = {
  live: { cats: 'get_live_categories', items: 'get_live_streams', grid: false },
  vod: { cats: 'get_vod_categories', items: 'get_vod_streams', grid: true },
  series: { cats: 'get_series_categories', items: 'get_series', grid: true },
};

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Speicher gesperrt */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

let cfg = store.get('cfg', null);
let favs = new Set(store.get('favs', []));
const data = {}; // type -> { cats: [], items: [] }
let tab = 'live';
let filtered = [];
let shown = 0;

function proxify(url) {
  return `/api/proxy?u=${encodeURIComponent(url)}&k=${encodeURIComponent(cfg.key)}`;
}

function needsProxy(url) {
  return cfg.alwaysProxy || (location.protocol === 'https:' && url.startsWith('http:'));
}

function normalizeServer(raw) {
  let s = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  return s;
}

async function api(action, params = {}, creds = cfg) {
  const qs = new URLSearchParams({ username: creds.username, password: creds.password, ...(action && { action }), ...params });
  const target = `${creds.server}/player_api.php?${qs}`;
  const res = await fetch(`/api/proxy?u=${encodeURIComponent(target)}&k=${encodeURIComponent(creds.key)}`);
  if (res.status === 401) throw new Error('Proxy-Zugriffsschlüssel ist falsch.');
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 150);
    throw new Error(`Server antwortet mit Fehler ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

function decodeB64(s) {
  try { return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))); } catch { return s; }
}

function show(el, on) { el.hidden = !on; }
const favKey = (it) => `${it.type}:${it.id}`;

/* ---------- Zwischenspeicher (IndexedDB) ---------- */

const idb = (() => {
  let dbp;
  const open = () => (dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('playerip', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  const run = async (mode, fn) => {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', mode);
        const req = fn(tx.objectStore('kv'));
        tx.oncomplete = () => resolve(req?.result);
        tx.onerror = () => reject(tx.error);
      });
    } catch { return undefined; } // z. B. privater Modus: dann eben ohne Cache
  };
  return {
    get: (k) => run('readonly', (s) => s.get(k)),
    set: (k, v) => run('readwrite', (s) => s.put(v, k)),
    clear: () => run('readwrite', (s) => s.clear()),
  };
})();

const CACHE_TTL = 6 * 3600 * 1000; // danach werden Listen im Hintergrund aktualisiert
const cacheKey = (type) => `v1|${cfg.server}|${cfg.username}|${type}`;

/* ---------- Spracherkennung ---------- */

const LANGS = {
  DE: { label: 'Deutsch', keys: ['de', 'ger', 'deu', 'german', 'deutsch', 'deutsche', 'germany', 'deutschland'] },
  EN: { label: 'Englisch', keys: ['en', 'eng', 'english', 'uk', 'us', 'usa', 'gb', 'englisch'] },
  TR: { label: 'Türkisch', keys: ['tr', 'tur', 'turkish', 'turk', 'türkisch', 'turkey', 'türkei'] },
  FR: { label: 'Französisch', keys: ['fr', 'fra', 'fre', 'french', 'france', 'französisch'] },
  ES: { label: 'Spanisch', keys: ['es', 'esp', 'spa', 'spanish', 'spain', 'spanisch', 'español'] },
  IT: { label: 'Italienisch', keys: ['it', 'ita', 'italian', 'italy', 'italienisch', 'italiano'] },
  NL: { label: 'Niederländisch', keys: ['nl', 'dut', 'dutch', 'netherlands', 'niederländisch'] },
  PL: { label: 'Polnisch', keys: ['pl', 'pol', 'polish', 'poland', 'polnisch'] },
  RU: { label: 'Russisch', keys: ['ru', 'rus', 'russian', 'russia', 'russisch'] },
  AR: { label: 'Arabisch', keys: ['ar', 'ara', 'arabic', 'arabisch'] },
  PT: { label: 'Portugiesisch', keys: ['pt', 'por', 'portuguese', 'portugal', 'portugiesisch'] },
};
const LOOKUP = new Map(Object.entries(LANGS).flatMap(([code, l]) => l.keys.map((k) => [k, code])));
const langLabel = (code) => LANGS[LOOKUP.get(String(code || '').toLowerCase())]?.label || '';

// loose=true für Kategorienamen (kurz, aussagekräftig), false für Filmtitel (nur eindeutige Markierungen).
// Kurzkürzel wie "de" zählen nur in Klammern/Pipes oder am Anfang/Ende, damit "Films de France" nicht als Deutsch gilt.
function detectLang(text, loose) {
  const t = String(text).toLowerCase();
  const tokens = t.split(/[^a-zäöüß]+/).filter(Boolean);
  if (loose) {
    for (const w of tokens) if (w.length > 3 && LOOKUP.has(w)) return LOOKUP.get(w);
  }
  const marker = /[[(|]\s*([a-zäöüß]{2,10})\s*[\])|]/g;
  for (let m; (m = marker.exec(t));) if (LOOKUP.has(m[1])) return LOOKUP.get(m[1]);
  const prefix = t.match(/^\s*([a-zäöüß]{2,10})\s*[:|\-–]/);
  if (prefix && LOOKUP.has(prefix[1])) return LOOKUP.get(prefix[1]);
  if (loose) {
    for (const w of [tokens[0], tokens[tokens.length - 1]]) if (w && LOOKUP.has(w)) return LOOKUP.get(w);
  }
  return '';
}

/* ---------- Login ---------- */

function showScreen(name) {
  show($('#login'), name === 'login');
  show($('#browse'), name === 'browse');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const creds = {
    server: normalizeServer(f.get('server')),
    username: f.get('username').trim(),
    password: f.get('password'),
    key: f.get('key'),
    alwaysProxy: false,
  };
  const err = $('#login-error');
  const btn = e.target.querySelector('button[type=submit]');
  show(err, false);
  btn.disabled = true;
  btn.textContent = 'Prüfe …';
  try {
    const info = await api(null, {}, creds);
    if (!info?.user_info || Number(info.user_info.auth) !== 1) throw new Error('Anmeldung abgelehnt. Zugangsdaten prüfen.');
    cfg = creds;
    store.set('cfg', cfg);
    startBrowse();
  } catch (ex) {
    err.textContent = ex.message || 'Verbindung fehlgeschlagen.';
    show(err, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Anmelden';
  }
});

/* ---------- Listen ---------- */

async function fetchType(type) {
  const def = TYPES[type];
  const [cats, items] = await Promise.all([api(def.cats), api(def.items)]);
  const catList = Array.isArray(cats) ? cats : [];
  const catName = new Map(catList.map((c) => [String(c.category_id), c.category_name || '']));
  const d = {
    cats: catList,
    items: (Array.isArray(items) ? items : []).map((x) => {
      const cat = String(x.category_id ?? '');
      const name = x.name || '(ohne Namen)';
      return {
        type,
        id: x.stream_id ?? x.series_id,
        name,
        icon: x.stream_icon || x.cover || '',
        cat,
        ext: x.container_extension || 'mp4',
        added: Number(x.added) || 0,
        lang: detectLang(name, false) || detectLang(catName.get(cat) || '', true), // Markierung im Titel ist genauer als die Kategorie
      };
    }),
  };
  data[type] = d;
  idb.set(cacheKey(type), { ts: Date.now(), d });
  return d;
}

// Erst aus dem Speicher, dann aus dem Zwischenspeicher; nur sonst (oder bei force) vom Server.
async function loadType(type) {
  if (data[type]) return data[type];
  const hit = await idb.get(cacheKey(type));
  if (hit?.d) {
    data[type] = hit.d;
    if (Date.now() - hit.ts > CACHE_TTL) refreshInBackground(type);
    return hit.d;
  }
  return fetchType(type);
}

function refreshInBackground(type) {
  fetchType(type).then(() => {
    if (tab === type || tab === 'fav') { saveView(); renderTab(); }
  }).catch(() => { /* alte Liste bleibt gültig */ });
}

function setStatus(text) {
  const s = $('#status');
  s.textContent = text || '';
  show(s, Boolean(text));
}

/* Ansicht pro Tab merken: Kategorie, Suche, Filter, Scrollposition */
const view = {};
const getView = (t) => (view[t] ||= { cat: '', q: '', sort: '', playable: '', lang: '', scroll: 0, shown: PAGE_SIZE });

function saveView() {
  const v = getView(tab);
  v.cat = $('#category').value;
  v.q = $('#search').value;
  v.sort = $('#sort').value;
  v.playable = $('#playable').value;
  v.lang = $('#lang').value;
  v.scroll = window.scrollY;
  v.shown = shown;
}

function buildLangOptions(items, selected) {
  const counts = {};
  let without = 0;
  for (const it of items) {
    if (it.lang) counts[it.lang] = (counts[it.lang] || 0) + 1; else without += 1;
  }
  const codes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const sel = $('#lang');
  sel.replaceChildren(
    new Option('Alle Sprachen', ''),
    ...codes.map((c) => new Option(`${LANGS[c].label} (${counts[c]})`, c)),
    ...(codes.length && without ? [new Option(`Ohne erkannte Sprache (${without})`, '-')] : []),
  );
  sel.value = selected;
  sel.hidden = codes.length === 0;
}

async function renderTab() {
  const t = tab;
  const sel = $('#category');
  const v = getView(t);
  if (t === 'fav' || !data[t]) $('#list').replaceChildren();
  setStatus('Lade …');

  try {
    let items = [];
    if (t === 'fav') {
      await Promise.all(Object.keys(TYPES).map(loadType));
      if (t !== tab) return;
      sel.replaceChildren(new Option('Alle Favoriten', ''));
    } else {
      const d = await loadType(t);
      if (t !== tab) return;
      sel.replaceChildren(new Option('Alle Kategorien', ''), ...d.cats.map((c) => new Option(c.category_name, c.category_id)));
      items = d.items;
    }
    sel.value = v.cat;
    sel.disabled = t === 'fav';
    $('#search').value = v.q;
    buildLangOptions(items, v.lang);
    $('#sort').value = v.sort;
    $('#playable').value = v.playable;
    const isVod = t === 'vod';
    $('#sort').hidden = !isVod;
    $('#playable').hidden = !isVod;
    show($('#extra-filters'), t !== 'fav' && (isVod || !$('#lang').hidden));
    applyFilter({ restore: true });
  } catch (ex) {
    if (t === tab) setStatus(`Laden fehlgeschlagen: ${ex.message}`);
  }
}

function applyFilter({ restore = false } = {}) {
  const q = $('#search').value.trim().toLowerCase();
  const cat = $('#category').value;
  const lang = $('#lang').value;
  const pool = tab === 'fav'
    ? Object.values(data).flatMap((d) => d.items).filter((it) => favs.has(favKey(it)))
    : data[tab].items;
  const onlyPlayable = tab === 'vod' && $('#playable').value === '1';
  filtered = pool.filter((it) => (!cat || it.cat === cat)
    && (!lang || (lang === '-' ? !it.lang : it.lang === lang))
    && (!q || it.name.toLowerCase().includes(q))
    && (!onlyPlayable || isPlayable(it)));
  if (tab === 'vod') {
    const sort = $('#sort').value;
    if (sort === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    else if (sort === 'new') filtered.sort((a, b) => b.added - a.added);
    else if (sort === 'playable') filtered.sort((a, b) => Number(isPlayable(b)) - Number(isPlayable(a)));
  }

  const list = $('#list');
  list.replaceChildren();
  list.classList.toggle('grid', tab !== 'live' && tab !== 'fav' && TYPES[tab].grid);
  setStatus(filtered.length ? '' : 'Nichts gefunden.');

  const v = getView(tab);
  const target = restore ? v.shown : PAGE_SIZE;
  shown = 0;
  do { renderMore(); } while (shown < target && shown < filtered.length);
  window.scrollTo(0, restore ? v.scroll : 0);
}

function iconSrc(url) {
  if (!url) return '';
  return location.protocol === 'https:' && url.startsWith('http:') ? proxify(url) : url;
}

function renderMore() {
  const list = $('#list');
  const frag = document.createDocumentFragment();
  for (const it of filtered.slice(shown, shown + PAGE_SIZE)) {
    const li = document.createElement('li');
    li.className = 'item';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.dataset.type = it.type;
    li.dataset.id = it.id;

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    if (it.icon) img.src = iconSrc(it.icon);
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name;

    const fav = document.createElement('button');
    fav.className = `fav${favs.has(favKey(it)) ? ' on' : ''}`;
    fav.type = 'button';
    fav.textContent = '★';
    fav.setAttribute('aria-label', 'Favorit');

    li.append(img, name);
    if (it.lang) {
      const l = document.createElement('span');
      l.className = 'fmt lang';
      l.textContent = it.lang;
      l.title = LANGS[it.lang].label;
      li.append(l);
    }
    if (it.type === 'vod') {
      const fmt = document.createElement('span');
      fmt.className = `fmt ${fmtClass(it.ext)}`;
      fmt.textContent = String(it.ext).toUpperCase();
      fmt.title = fmtTitle(it.ext);
      li.append(fmt);
    }
    li.append(fav);
    frag.append(li);
  }
  shown += PAGE_SIZE;
  list.append(frag);
}

new IntersectionObserver((entries) => {
  if (entries.some((e) => e.isIntersecting) && shown < filtered.length) renderMore();
}, { rootMargin: '600px' }).observe($('#sentinel'));

function findItem(type, id) {
  return data[type]?.items.find((x) => String(x.id) === String(id));
}

$('#list').addEventListener('click', (e) => {
  const li = e.target.closest('.item');
  if (!li) return;
  const it = findItem(li.dataset.type, li.dataset.id);
  if (!it) return;

  if (e.target.closest('.fav')) {
    const k = favKey(it);
    if (favs.has(k)) favs.delete(k); else favs.add(k);
    store.set('favs', [...favs]);
    if (tab === 'fav') { saveView(); applyFilter({ restore: true }); }
    else e.target.closest('.fav').classList.toggle('on', favs.has(k));
    return;
  }
  openItem(it);
});

$('#list').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('item')) {
    e.preventDefault();
    e.target.click();
  }
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b || b.dataset.tab === tab) return;
  saveView(); // Kategorie, Suche und Scrollposition des alten Tabs merken
  tab = b.dataset.tab;
  for (const t of document.querySelectorAll('#tabs button')) t.setAttribute('aria-selected', String(t === b));
  renderTab();
});

for (const id of ['#category', '#sort', '#playable', '#lang']) $(id).addEventListener('change', () => applyFilter());
let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applyFilter(), 150);
});

function openItem(it) {
  if (it.type === 'live') {
    playStream(`${cfg.server}/live/${cfg.username}/${cfg.password}/${it.id}.m3u8`, it.name, '', it.id);
  } else if (it.type === 'vod') {
    openMovie(it);
  } else {
    openSeries(it);
  }
}

/* ---------- Layer-Navigation (Zurück-Geste) ---------- */

const layers = [];
function pushLayer(name) {
  layers.push(name);
  history.pushState({ layer: name }, '');
}
window.addEventListener('popstate', () => {
  const name = layers.pop();
  if (name === 'player') teardownPlayer();
  if (name === 'detail') show($('#detail'), false);
});

/* ---------- Detailseite (Filme & Serien) ---------- */

const detailCache = new Map();
let detailToken = 0;

async function cachedApi(key, action, params) {
  if (!detailCache.has(key)) detailCache.set(key, await api(action, params));
  return detailCache.get(key);
}

// Dateigröße ohne Download: Range-Anfrage über den Proxy, die Gesamtgröße steht im Content-Range-Header.
async function fileSize(url) {
  if (detailCache.has(`size:${url}`)) return detailCache.get(`size:${url}`);
  const res = await fetch(proxify(url), { headers: { Range: 'bytes=0-0' } });
  let bytes = null;
  const range = res.headers.get('content-range');
  if (res.ok && range && /\/(\d+)$/.test(range)) bytes = Number(range.match(/\/(\d+)$/)[1]);
  else if (res.status === 200) bytes = Number(res.headers.get('content-length')) || null; // Server ignoriert Range
  res.body?.cancel();
  if (bytes) detailCache.set(`size:${url}`, bytes);
  return bytes;
}

function formatSize(bytes) {
  const n = (v, d) => v.toLocaleString('de-DE', { maximumFractionDigits: d, minimumFractionDigits: d });
  if (bytes >= 1e9) return `${n(bytes / 1e9, 1)} GB`;
  if (bytes >= 1e8) return `${n(bytes / 1e6, 0)} MB`;
  if (bytes >= 1e6) return `${n(bytes / 1e6, 1)} MB`;
  return `${n(bytes / 1e3, 0)} KB`;
}

function addChip(c) {
  const meta = $('#detail-head .detail-meta');
  if (!meta) return;
  let row = meta.querySelector('.chips');
  if (!row) { row = el('div', 'chips'); meta.prepend(row); }
  row.append(el('span', `chip${c.cls ? ` ${c.cls}` : ''}`, c.text));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const toArray = (x) => {
  if (Array.isArray(x)) return x;
  return x && typeof x === 'object' && Object.keys(x).length ? [x] : [];
};
const BAD_AUDIO = new Set(['dts', 'truehd', 'dca', 'mlp']); // Safari spielt diese Tonformate nicht
const pick = (...vals) => vals.find((v) => v != null && String(v).trim() !== '' && String(v) !== '0');

function openDetail(title) {
  detailToken += 1;
  $('#detail-title').textContent = title;
  $('#detail-head').replaceChildren();
  $('#detail-body').replaceChildren(el('p', 'status', 'Lade …'));
  if (!layers.includes('detail')) pushLayer('detail');
  show($('#detail'), true);
  $('#detail').scrollTop = 0;
  return detailToken;
}

function renderHead({ cover, chips, lines, plot }) {
  const head = $('#detail-head');
  head.replaceChildren();
  if (cover) {
    const img = el('img');
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = iconSrc(cover);
    img.addEventListener('error', () => img.remove());
    head.append(img);
  }
  const meta = el('div', 'detail-meta');
  const chipRow = el('div', 'chips');
  for (const c of chips.filter(Boolean)) chipRow.append(el('span', `chip${c.cls ? ` ${c.cls}` : ''}`, c.text));
  if (chipRow.childNodes.length) meta.append(chipRow);
  for (const l of lines.filter(Boolean)) meta.append(el('div', 'line', l));
  if (plot) meta.append(el('p', 'plot', plot));
  head.append(meta);
}

function techInfo(info) {
  const lines = [];
  const chips = [];
  const v = toArray(info?.video)[0];
  if (v?.codec_name) lines.push(`Video: ${String(v.codec_name).toUpperCase()}${v.width ? ` ${v.width}×${v.height}` : ''}`);
  const audios = toArray(info?.audio);
  if (audios.length) {
    lines.push(`Ton: ${audios.map((a) => [langLabel(a.tags?.language || a.language), a.codec_name && String(a.codec_name).toUpperCase()]
      .filter(Boolean).join(' ')).filter(Boolean).join(' · ')}`.replace(/Ton: $/, ''));
    if (audios.every((a) => BAD_AUDIO.has(String(a.codec_name).toLowerCase()))) {
      chips.push({ text: 'Tonformat evtl. nicht abspielbar', cls: 'bad' });
    }
  }
  return { lines: lines.filter((l) => l && !/:\s*$/.test(l)), chips };
}

async function openMovie(it) {
  const token = openDetail(it.name);
  const { username: u, password: p } = cfg;
  const body = $('#detail-body');
  const play = el('button', 'primary play', '▶ Abspielen');
  play.addEventListener('click', () => playStream(
    `${cfg.server}/movie/${u}/${p}/${it.id}.${it.ext}`, it.name, it.ext.toUpperCase(), null,
    `${cfg.server}/movie/${u}/${p}/${it.id}.m3u8`));
  const fmtChip = { text: it.ext.toUpperCase(), cls: fmtClass(it.ext) };
  const langChip = it.lang && { text: LANGS[it.lang].label };

  renderHead({ cover: it.icon, chips: [fmtChip, langChip], lines: [], plot: '' });
  body.replaceChildren(play);
  const sizeP = fileSize(`${cfg.server}/movie/${u}/${p}/${it.id}.${it.ext}`).catch(() => null);

  try {
    const r = await cachedApi(`vod:${it.id}`, 'get_vod_info', { vod_id: it.id });
    if (token !== detailToken) return;
    const info = r?.info || {};
    const tech = techInfo(info);
    const year = pick(info.year, String(info.releasedate || info.releaseDate || '').slice(0, 4));
    const rating = pick(info.rating, info.rating_5based && Number(info.rating_5based) * 2);
    renderHead({
      cover: pick(info.movie_image, info.cover_big, it.icon),
      chips: [fmtChip, langChip, year && { text: year }, pick(info.duration) && { text: info.duration }, rating && { text: `★ ${Number(rating).toFixed(1)}` },
        pick(info.age, info.mpaa_rating) && { text: info.age || info.mpaa_rating }, ...tech.chips],
      lines: [pick(info.genre) && `Genre: ${info.genre}`, pick(info.country) && `Land: ${info.country}`,
        pick(info.director) && `Regie: ${info.director}`, pick(info.cast, info.actors) && `Besetzung: ${pick(info.cast, info.actors)}`, ...tech.lines],
      plot: pick(info.plot, info.description) || '',
    });
  } catch { /* Details sind optional, Abspielen geht trotzdem */ }

  const bytes = await sizeP;
  if (bytes && token === detailToken) addChip({ text: formatSize(bytes) });
}

async function openSeries(it) {
  const token = openDetail(it.name);
  const body = $('#detail-body');
  renderHead({ cover: it.icon, chips: [it.lang && { text: LANGS[it.lang].label }], lines: [], plot: '' });

  try {
    const r = await cachedApi(`series:${it.id}`, 'get_series_info', { series_id: it.id });
    if (token !== detailToken) return;
    const info = r?.info || {};
    const rating = pick(info.rating, info.rating_5based && Number(info.rating_5based) * 2);
    renderHead({
      cover: pick(info.cover, it.icon),
      chips: [it.lang && { text: LANGS[it.lang].label }, pick(info.releaseDate, info.releasedate) && { text: String(pick(info.releaseDate, info.releasedate)).slice(0, 4) },
        pick(info.episode_run_time) && { text: `${info.episode_run_time} Min.` }, rating && { text: `★ ${Number(rating).toFixed(1)}` }],
      lines: [pick(info.genre) && `Genre: ${info.genre}`, pick(info.director) && `Regie: ${info.director}`, pick(info.cast) && `Besetzung: ${info.cast}`],
      plot: pick(info.plot) || '',
    });

    const seasons = r.episodes && !Array.isArray(r.episodes) ? r.episodes : { 1: r.episodes || [] };
    body.replaceChildren();
    const keys = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));
    if (!keys.length) throw new Error('Keine Episoden gefunden.');
    for (const s of keys) {
      body.append(el('h3', null, `Staffel ${s}`));
      for (const ep of seasons[s]) {
        const row = el('div', 'item');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        const label = el('span', 'name', `${ep.episode_num ?? ''}. ${ep.title || 'Episode'}`);
        const epExt = ep.container_extension || 'mp4';
        row.append(label, el('span', `fmt ${fmtClass(epExt)}`, epExt.toUpperCase()));
        const go = () => playStream(
          `${cfg.server}/series/${cfg.username}/${cfg.password}/${ep.id}.${epExt}`,
          it.name, `S${s} · ${label.textContent}`, null,
          `${cfg.server}/series/${cfg.username}/${cfg.password}/${ep.id}.m3u8`);
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        body.append(row);
      }
    }
  } catch (ex) {
    if (token === detailToken) body.replaceChildren(el('p', 'status', ex.message));
  }
}

$('#detail-back').addEventListener('click', () => history.back());

/* ---------- Player ---------- */

const video = $('#video');
let hls = null;
let idleTimer;

function showPlayerError(msg) {
  const el = $('#player-error');
  el.textContent = msg || '';
  show(el, Boolean(msg));
}

let remux = null;

function stopRemux() {
  if (remux) { remux.destroy(); remux = null; }
}

function teardownPlayer() {
  playToken++;
  stopRemux();
  video.onerror = null;
  if (hls) { hls.destroy(); hls = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
  show($('#player'), false);
  showPlayerError('');
}

let playToken = 0;

// Kandidatenliste: direkt -> Proxy, danach (falls vorhanden) die HLS-Variante desselben Titels.
function buildCandidates(urls) {
  const nativeHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  const [main, ...alts] = urls.filter(Boolean);
  const mkv = /\.mkv(\?|$)/i.test(main);
  const nativeMkv = Boolean(video.canPlayType('video/x-matroska'));
  const list = [];
  const add = (url) => {
    const isHls = /\.m3u8(\?|$)/i.test(url);
    if (isHls && !nativeHls && window.Hls?.isSupported()) {
      // hls.js braucht CORS -> immer Proxy. Safari spielt HLS nativ (und kann AirPlay).
      list.push({ url, kind: 'hlsjs', src: proxify(url) });
    } else {
      if (!needsProxy(url)) list.push({ url, kind: 'native', src: url });
      list.push({ url, kind: 'native', src: proxify(url) });
    }
  };
  // Safari kann kein MKV: direkt zur HLS-Variante (falls der Anbieter eine hat), dann Umwandlung im Browser.
  if (!mkv || nativeMkv) add(main);
  for (const a of alts) add(a);
  if (mkv && canRemux()) list.push({ url: main, kind: 'remux', src: proxify(main) });
  else if (mkv && !list.length) add(main);
  return list;
}

async function probe(url) {
  const ext = (new URL(url).pathname.match(/\.(\w+)$/) || [])[1] || '?';
  try {
    const r = await fetch(proxify(url), { headers: { Range: 'bytes=0-0' } });
    const type = (r.headers.get('content-type') || '').split(';')[0];
    let note = '';
    if (/text|json|mpegurl/.test(type)) {
      note = (await r.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    } else {
      r.body?.cancel();
    }
    return `.${ext}: ${r.status} ${type}${note ? ` „${note}“` : ''}`;
  } catch {
    return `.${ext}: nicht erreichbar`;
  }
}

async function describeFailure(urls) {
  const lines = await Promise.all([...new Set(urls)].map(probe));
  return `Wiedergabe nicht möglich (Fehlercode ${video.error?.code ?? '–'}).\n${lines.join('\n')}`;
}

function attach(urls) {
  tryCandidate(buildCandidates(urls), 0, ++playToken);
}

function tryCandidate(list, index, token) {
  const cand = list[index];
  showPlayerError('');
  stopRemux();
  if (hls) { hls.destroy(); hls = null; }

  const next = async () => {
    if (token !== playToken) return;
    if (index + 1 < list.length) tryCandidate(list, index + 1, token);
    else showPlayerError(await describeFailure(list.map((c) => c.url)));
  };

  if (cand.kind === 'remux') {
    stopRemux();
    const base = $('#player-sub').textContent.split(' · ')[0];
    const note = (txt) => { if (token === playToken) $('#player-sub').textContent = [base, txt].filter(Boolean).join(' · '); };
    note('MKV wird im Browser umgewandelt (experimentell) …');
    import('/vendor/mkvstream.js')
      .then(({ playMkv }) => playMkv(video, cand.src, {
        onStatus: note,
        onError: (e) => { if (token === playToken) showPlayerError(`Umwandlung fehlgeschlagen: ${e.message}`); },
      }))
      .then((ctrl) => {
        if (token !== playToken) { ctrl.destroy(); return; }
        remux = ctrl;
        const a = ctrl.info.audio ? `Ton: ${ctrl.info.audio}` : 'ohne Ton';
        note(ctrl.info.skipped ? `Ton nicht unterstützt (${ctrl.info.skipped}) – ohne Ton` : a);
        video.onerror = () => showPlayerError('Wiedergabe nicht möglich (Bild- oder Tonformat wird nicht unterstützt).');
        video.play().catch(() => {});
      })
      .catch((e) => { if (token === playToken) showPlayerError(`Umwandlung nicht möglich: ${e.message}`); });
    return;
  }

  if (cand.kind === 'hlsjs') {
    hls = new Hls();
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) next(); });
    hls.loadSource(cand.src);
    hls.attachMedia(video);
    video.play().catch(() => {});
    return;
  }

  video.onerror = next;
  video.src = cand.src;
  video.play().catch(() => {});
}

async function playStream(url, title, sub, liveId, alt) {
  $('#player-title').textContent = title;
  $('#player-sub').textContent = sub || '';
  if (!layers.includes('player')) pushLayer('player');
  show($('#player'), true);
  bumpControls();
  attach([url, alt]);

  if (liveId) {
    try {
      const r = await api('get_short_epg', { stream_id: liveId, limit: 1 });
      const now = r?.epg_listings?.[0];
      if (now && $('#player-title').textContent === title) $('#player-sub').textContent = `Jetzt: ${decodeB64(now.title)}`;
    } catch { /* EPG ist optional */ }
  }
}

$('#player-close').addEventListener('click', () => history.back());

function bumpControls() {
  $('#player').classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!video.paused) $('#player').classList.add('idle'); }, 3500);
}
for (const ev of ['pointermove', 'pointerdown', 'keydown']) $('#player').addEventListener(ev, bumpControls);
video.addEventListener('pause', bumpControls);

// AirPlay (nur Safari/WebKit): Button erscheint, sobald ein Ziel (Apple TV) erreichbar ist.
if (window.WebKitPlaybackTargetAvailabilityEvent) {
  video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
    show($('#airplay'), e.availability === 'available');
  });
  $('#airplay').addEventListener('click', () => video.webkitShowPlaybackTargetPicker());
}

/* ---------- Einstellungen ---------- */

$('#menu-btn').addEventListener('click', () => {
  $('#opt-proxy').checked = Boolean(cfg.alwaysProxy);
  $('#settings').showModal();
});
$('#opt-proxy').addEventListener('change', (e) => {
  cfg.alwaysProxy = e.target.checked;
  store.set('cfg', cfg);
});
$('#refresh-btn').addEventListener('click', async () => {
  saveView();
  for (const k of Object.keys(data)) delete data[k];
  detailCache.clear();
  await idb.clear();
  $('#settings').close();
  renderTab();
});
$('#logout-btn').addEventListener('click', async () => {
  store.del('cfg');
  await idb.clear();
  location.reload();
});

/* ---------- Start ---------- */

function startBrowse() {
  showScreen('browse');
  renderTab();
}

if (cfg?.server && cfg.key) startBrowse(); else showScreen('login');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
