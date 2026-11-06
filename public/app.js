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
const cacheKey = (type) => `v2|${cfg.server}|${cfg.username}|${type}`;

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

function ratingStars(x) {
  const five = Number(x.rating_5based);
  const ten = Number(x.rating);
  const r = five > 0 ? five : ten > 0 ? ten / 2 : 0;
  return Math.min(5, Math.round(r * 10) / 10);
}

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
        added: Number(x.added || x.last_modified) || 0,
        rating5: ratingStars(x),
        genre: x.genre ? String(x.genre) : (type === 'series' ? '' : undefined), // undefined = unbekannt (Filme)
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
    if (nav.section === type || nav.section === 'fav') { saveView(); render(); }
  }).catch(() => { /* alte Liste bleibt gültig */ });
}

function setStatus(text) {
  const s = $('#status');
  s.textContent = text || '';
  show(s, Boolean(text));
}

/* ---------- Navigation: Start -> Bereich -> Anbieter/Kategorie -> Liste ---------- */

const SECTIONS = { live: 'Live', vod: 'Filme', series: 'Serien', fav: 'Favoriten', offline: 'Offline' };
const GROUPED = new Set(['vod', 'series']); // hier gibt es erst eine Auswahl nach Anbieter
const nav = { section: null, group: null }; // group: { id, label, catIds: Set | null }
const providers = (window.PROVIDERS || []).map((p) => ({ ...p, rx: new RegExp(p.re, 'i') }));
const isGroupsScreen = () => GROUPED.has(nav.section) && !nav.group;

/* Bewertung in Sternen (rating5 = Wert von 0 bis 5). Vorerst zählt nur die ganze Zahl:
   3,2 und 3,5 sind 3 Sterne, auch 3,9 bleibt bei 3. Hier ändern, falls später anders gerundet werden soll. */
const starBucket = (it) => Math.min(5, Math.floor(it.rating5 || 0));
const fmtRating = (r) => r.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const genreList = (it) => String(it.genre || '').split(/[,/|]/).map((g) => g.trim()).filter(Boolean);

/* Ansicht pro Liste merken: Filter, Suche, Scrollposition */
const view = {};
const viewKey = () => `${nav.section}:${nav.group?.id ?? '*'}`;
const getView = (key = viewKey()) => (view[key] ||= {
  cat: '', q: '', sort: '', playable: '', lang: '', genre: '', rating: '', scroll: 0, shown: PAGE_SIZE, filters: false,
});

function saveView() {
  if (!nav.section) return;
  if (isGroupsScreen()) { (view[`groups:${nav.section}`] ||= {}).scroll = window.scrollY; return; }
  const v = getView();
  v.cat = $('#category').value;
  v.q = $('#search').value;
  v.sort = $('#sort').value;
  v.playable = $('#playable').value;
  v.lang = $('#lang').value;
  v.genre = $('#genre').value;
  v.rating = $('#rating').value;
  v.scroll = window.scrollY;
  v.shown = shown;
}

async function render() {
  const { section, group } = nav;
  const groups = isGroupsScreen();
  if (genreJob) genreJob.cancel = true;
  const offline = section === 'offline';
  show($('#home'), !section);
  show($('#groups'), Boolean(section) && groups);
  show($('#listview'), Boolean(section) && !groups && !offline);
  show($('#offline'), offline);
  show($('#nav-back'), Boolean(section));
  $('#nav-title').textContent = !section ? 'PlayerIP' : group ? group.label : SECTIONS[section];
  if (!section) { window.scrollTo(0, 0); return; }
  if (offline) { await renderOffline(); window.scrollTo(0, 0); return; }
  if (groups) await renderGroups(); else await renderList();
}

function openSection(section) {
  saveView();
  nav.section = section;
  nav.group = null;
  pushLayer('section');
  render();
}

function openGroup(group) {
  saveView();
  nav.group = group;
  pushLayer('group');
  render();
}

$('#nav-back').addEventListener('click', () => history.back());
$('#home').addEventListener('click', (e) => {
  const b = e.target.closest('[data-section]');
  if (b) openSection(b.dataset.section);
});

/* ---------- Anbieter-Kacheln ---------- */

const countCache = new WeakMap();
function categoryCounts(d) {
  if (!countCache.has(d)) {
    const m = new Map();
    for (const it of d.items) m.set(it.cat, (m.get(it.cat) || 0) + 1);
    countCache.set(d, m);
  }
  return countCache.get(d);
}

let currentGroups = new Map();
let moreOpen = false;

function tileEl(g) {
  const p = g.provider;
  const b = el('button', 'tile');
  b.type = 'button';
  b.dataset.gid = g.id;
  b.setAttribute('aria-label', `${g.label}, ${g.count}`);
  b.style.setProperty('--tile-bg', p.bg);
  b.style.setProperty('--tile-fg', p.fg);
  if (p.icon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', p.icon);
    svg.append(path);
    b.append(svg);
  } else {
    b.append(el('span', 'word', p.word || p.label));
  }
  b.append(el('span', 'count', String(g.count)));
  return b;
}

function barEl(g) {
  const b = el('button', 'bar');
  b.type = 'button';
  b.dataset.gid = g.id;
  b.append(el('span', null, g.label), el('span', 'count', String(g.count)));
  return b;
}

async function renderGroups() {
  const section = nav.section;
  const status = $('#groups-status');
  const stale = () => nav.section !== section || !isGroupsScreen();
  $('#tiles').replaceChildren();
  $('#all-wrap').replaceChildren();
  $('#more-list').replaceChildren();
  show($('#more'), false);
  status.textContent = 'Lade …';
  show(status, true);

  try {
    const d = await loadType(section);
    if (stale()) return;
    const counts = categoryCounts(d);
    const used = new Set();
    const tiles = [];
    for (const p of providers) {
      const ids = new Set(d.cats
        .filter((c) => !used.has(String(c.category_id)) && p.rx.test(String(c.category_name || '')))
        .map((c) => String(c.category_id)));
      const count = [...ids].reduce((n, id) => n + (counts.get(id) || 0), 0);
      if (!count) continue;
      ids.forEach((id) => used.add(id));
      tiles.push({ id: `p:${p.id}`, label: p.label, catIds: ids, count, provider: p });
    }
    const rest = d.cats
      .filter((c) => !used.has(String(c.category_id)) && (counts.get(String(c.category_id)) || 0) > 0)
      .map((c) => ({ id: `c:${c.category_id}`, label: c.category_name || '(ohne Namen)', catIds: new Set([String(c.category_id)]), count: counts.get(String(c.category_id)) }));
    const all = { id: 'all', label: section === 'vod' ? 'Alle Filme' : 'Alle Serien', catIds: null, count: d.items.length };

    currentGroups = new Map([...tiles, ...rest, all].map((g) => [g.id, g]));
    $('#tiles').replaceChildren(...tiles.map(tileEl));
    $('#all-wrap').replaceChildren(barEl(all));
    if (rest.length) {
      $('#more-title').textContent = `Weitere Kategorien (${rest.length})`;
      $('#more-list').replaceChildren(...rest.map(barEl));
      $('#more').open = moreOpen || tiles.length === 0;
      show($('#more'), true);
    }
    show(status, false);
    window.scrollTo(0, view[`groups:${section}`]?.scroll || 0);
  } catch (ex) {
    if (!stale()) status.textContent = `Laden fehlgeschlagen: ${ex.message}`;
  }
}

$('#groups').addEventListener('click', (e) => {
  const b = e.target.closest('[data-gid]');
  const g = b && currentGroups.get(b.dataset.gid);
  if (g) openGroup(g);
});
$('#more').addEventListener('toggle', () => { moreOpen = $('#more').open; });

/* ---------- Liste ---------- */

let pool = []; // Basis der aktuellen Liste, bevor Filter greifen

function poolFor() {
  if (nav.section === 'fav') return Object.values(data).flatMap((d) => d.items).filter((it) => favs.has(favKey(it)));
  const items = data[nav.section].items;
  const ids = nav.group?.catIds;
  return ids ? items.filter((it) => ids.has(it.cat)) : items;
}

async function renderList() {
  const section = nav.section;
  const group = nav.group;
  const stale = () => nav.section !== section || nav.group !== group || isGroupsScreen();
  if (section === 'fav' || !data[section]) $('#list').replaceChildren();
  setStatus('Lade …');

  try {
    if (section === 'fav') await Promise.all(Object.keys(TYPES).map((t) => loadType(t)));
    else await loadType(section);
    if (stale()) return;
    pool = poolFor();
    buildControls(getView());
    applyFilter({ restore: true });
  } catch (ex) {
    if (!stale()) setStatus(`Laden fehlgeschlagen: ${ex.message}`);
  }
}

function fillSelect(sel, first, options, selected) {
  sel.replaceChildren(new Option(first, ''), ...options.map(([value, label]) => new Option(label, value)));
  sel.value = selected;
  sel.hidden = options.length === 0;
}

function buildLangOptions(items, selected) {
  const counts = {};
  let without = 0;
  for (const it of items) {
    if (it.lang) counts[it.lang] = (counts[it.lang] || 0) + 1; else without += 1;
  }
  const codes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const opts = codes.map((c) => [c, `${LANGS[c].label} (${counts[c]})`]);
  if (codes.length && without) opts.push(['-', `Ohne erkannte Sprache (${without})`]);
  fillSelect($('#lang'), 'Alle Sprachen', opts, selected);
}

function buildGenreOptions(items, selected) {
  const names = new Map(); // klein -> Anzeigename
  const counts = new Map();
  for (const it of items) {
    for (const g of genreList(it)) {
      const k = g.toLowerCase();
      if (!names.has(k)) names.set(k, g);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const opts = [...names].sort((a, b) => a[1].localeCompare(b[1], 'de')).map(([k, n]) => [k, `${n} (${counts.get(k)})`]);
  fillSelect($('#genre'), 'Alle Genres', opts, selected);
}

function buildRatingOptions(items, selected) {
  const counts = [0, 0, 0, 0, 0, 0];
  for (const it of items) counts[starBucket(it)] += 1;
  const label = (n) => (n === 0 ? 'Ohne Bewertung' : `${n} ${n === 1 ? 'Stern' : 'Sterne'}`);
  const opts = [5, 4, 3, 2, 1, 0].filter((n) => counts[n]).map((n) => [String(n), `${label(n)} (${counts[n]})`]);
  fillSelect($('#rating'), 'Alle Bewertungen', opts, selected);
}

function buildControls(v) {
  const section = nav.section;
  const content = section === 'vod' || section === 'series';

  // Kategorie nur, wenn die Auswahl mehrere enthält (Live: alle Kategorien)
  let cats = [];
  if (section === 'live') cats = data.live.cats;
  else if (content && nav.group?.catIds && nav.group.catIds.size > 1) cats = data[section].cats.filter((c) => nav.group.catIds.has(String(c.category_id)));
  fillSelect($('#category'), 'Alle Kategorien', cats.map((c) => [String(c.category_id), c.category_name]), v.cat);

  if (section === 'fav') {
    for (const id of ['#lang', '#genre', '#rating', '#sort', '#playable']) $(id).hidden = true;
  } else {
    buildLangOptions(pool, v.lang);
    if (content) { buildGenreOptions(pool, v.genre); buildRatingOptions(pool, v.rating); } else { $('#genre').hidden = true; $('#rating').hidden = true; }
    const sorts = {
      vod: [['name', 'Name A–Z'], ['new', 'Neueste zuerst'], ['rating', 'Beste Bewertung'], ['playable', 'Abspielbare zuerst']],
      series: [['name', 'Name A–Z'], ['new', 'Neueste zuerst'], ['rating', 'Beste Bewertung']],
      live: [['name', 'Name A–Z']],
    }[section];
    fillSelect($('#sort'), 'Standard-Sortierung', sorts, v.sort);
    $('#playable').value = v.playable;
    $('#playable').hidden = section !== 'vod';
  }
  $('#search').value = v.q;
  updateGenreLoad();
  setFiltersOpen(v.filters);
}

function setFiltersOpen(open) {
  getView().filters = open;
  $('#filter-toggle').setAttribute('aria-expanded', String(open));
  show($('#filter-panel'), open);
}

function updateFilterBadge() {
  const n = ['#category', '#lang', '#genre', '#rating', '#sort', '#playable'].filter((id) => !$(id).hidden && $(id).value).length;
  const badge = $('#filter-badge');
  badge.textContent = String(n);
  show(badge, n > 0);
}

$('#filter-toggle').addEventListener('click', () => setFiltersOpen($('#filter-toggle').getAttribute('aria-expanded') !== 'true'));

function applyFilter({ restore = false } = {}) {
  const q = $('#search').value.trim().toLowerCase();
  const cat = $('#category').value;
  const lang = $('#lang').value;
  const genre = $('#genre').value;
  const rating = $('#rating').value;
  const onlyPlayable = nav.section === 'vod' && $('#playable').value === '1';
  if (nav.section === 'fav') pool = poolFor();

  filtered = pool.filter((it) => (!cat || it.cat === cat)
    && (!lang || (lang === '-' ? !it.lang : it.lang === lang))
    && (!genre || genreList(it).some((g) => g.toLowerCase() === genre))
    && (!rating || String(starBucket(it)) === rating)
    && (!q || it.name.toLowerCase().includes(q))
    && (!onlyPlayable || isPlayable(it)));

  const sort = $('#sort').hidden ? '' : $('#sort').value;
  if (sort === 'name') filtered.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  else if (sort === 'new') filtered.sort((a, b) => b.added - a.added);
  else if (sort === 'rating') filtered.sort((a, b) => (b.rating5 || 0) - (a.rating5 || 0));
  else if (sort === 'playable') filtered.sort((a, b) => Number(isPlayable(b)) - Number(isPlayable(a)));

  const list = $('#list');
  list.replaceChildren();
  list.classList.toggle('grid', nav.section === 'vod' || nav.section === 'series');
  setStatus(filtered.length ? '' : 'Nichts gefunden.');
  updateFilterBadge();

  const v = getView();
  const target = restore ? v.shown : PAGE_SIZE;
  shown = 0;
  do { renderMore(); } while (shown < target && shown < filtered.length);
  window.scrollTo(0, restore ? v.scroll : 0);
}

/* Genres: Die Filmliste enthält keine Genres, sie stehen nur in den Einzelinfos. Auf Wunsch holen wir sie für die
   aktuelle Auswahl (4 Anfragen gleichzeitig) und speichern sie, damit das nur einmal nötig ist. */
let genreJob = null;

function updateGenreLoad() {
  const missing = nav.section === 'vod' ? pool.filter((it) => it.type === 'vod' && it.genre === undefined).length : 0;
  show($('#genre-load'), missing > 0 || Boolean(genreJob));
  if (!genreJob) {
    $('#genre-load-text').textContent = `Genres sind nur einzeln abrufbar (${missing} Filme).`;
    $('#genre-load-btn').textContent = 'Genres laden';
    $('#genre-load-info').textContent = '';
  }
}

$('#genre-load-btn').addEventListener('click', async () => {
  if (genreJob) { genreJob.cancel = true; return; }
  const todo = pool.filter((it) => it.type === 'vod' && it.genre === undefined);
  if (!todo.length) return;
  const job = { cancel: false };
  genreJob = job;
  const total = todo.length;
  let done = 0;
  let errors = 0;
  $('#genre-load-btn').textContent = 'Abbrechen';
  const worker = async () => {
    while (!job.cancel && errors < 5) {
      const it = todo.shift();
      if (!it) return;
      try {
        const r = await api('get_vod_info', { vod_id: it.id });
        it.genre = String(r?.info?.genre || '').trim();
        errors = 0;
      } catch { errors += 1; }
      done += 1;
      $('#genre-load-info').textContent = `${done} / ${total}`;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  genreJob = null;
  idb.set(cacheKey('vod'), { ts: Date.now(), d: data.vod });
  if (nav.section === 'vod') {
    buildGenreOptions(pool, $('#genre').value);
    updateGenreLoad();
    if (errors >= 5) $('#genre-load-info').textContent = 'Abgebrochen: Der Anbieter antwortet nicht.';
  }
});

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

    const text = el('div', 'text');
    text.append(el('span', 'name', it.name));
    if (it.rating5 > 0) text.append(el('span', 'sub stars', `★ ${fmtRating(it.rating5)}`));

    const fav = document.createElement('button');
    fav.className = `fav${favs.has(favKey(it)) ? ' on' : ''}`;
    fav.type = 'button';
    fav.textContent = '★';
    fav.setAttribute('aria-label', 'Favorit');

    li.append(img, text);
    if (it.lang) {
      const l = el('span', 'fmt lang', it.lang);
      l.title = LANGS[it.lang].label;
      li.append(l);
    }
    if (it.type === 'vod') {
      const fmt = el('span', `fmt ${fmtClass(it.ext)}`, String(it.ext).toUpperCase());
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
    if (nav.section === 'fav') { saveView(); applyFilter({ restore: true }); }
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

for (const id of ['#category', '#sort', '#playable', '#lang', '#genre', '#rating']) $(id).addEventListener('change', () => applyFilter());
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
  else if (name === 'detail') show($('#detail'), false);
  else if (name === 'group') { saveView(); nav.group = null; render(); }
  else if (name === 'section') { saveView(); nav.section = null; nav.group = null; render(); }
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

// "Serie (MULTI) - S01E01 - Episode 1" -> "Episode 1": Serienname und Staffel stehen schon darüber.
function episodeTitle(raw, seriesName, num) {
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let t = String(raw || '').trim();
  const marked = t.match(/\bS\d+\s*E\d+\b\s*[-–:|]*\s*(.*)$/i); // alles nach "S01E01"
  if (marked) t = marked[1];
  else if (seriesName) t = t.replace(new RegExp(`^${esc(seriesName.trim())}\\s*[-–:|]*\\s*`, 'i'), '');
  t = t.replace(/^[-–:|\s]+/, '').trim();
  if (!t) return `Episode ${num ?? ''}`.trim();
  return /^(episode|folge)\s*\d+$/i.test(t) || !num ? t : `${num}. ${t}`;
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

/* ---------- In VLC öffnen ---------- */
// VLC (iOS) nimmt Links dieser Form entgegen und spielt den Film direkt vom Anbieter ab, ohne Proxy.
const vlcLink = (url) => `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(url)}`;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try { window.prompt('Link kopieren:', text); } catch { /* ignorieren */ }
    return false;
  }
}

let toastTimer;
function hideToast() {
  clearTimeout(toastTimer);
  show($('#toast'), false);
}

// opts.busy: läuft etwas im Hintergrund? Dann zeigt ein laufender Balken, dass die App arbeitet.
function toast(text, action, opts = {}) {
  const t = $('#toast');
  t.replaceChildren(el('span', null, text));
  t.classList.toggle('busy', Boolean(opts.busy));
  if (opts.busy) t.append(el('div', 'toast-bar'));
  if (action) {
    const b = el('button', null, action.label);
    b.type = 'button';
    b.addEventListener('click', () => { show(t, false); action.fn(); });
    t.append(b);
  }
  show(t, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show(t, false), opts.busy ? 60000 : 9000);
}

// vlc://<Adresse>: VLC öffnet sich und fragt sichtbar "Herunterladen oder Abspielen?". Der Befehl .../download?url=...
// wird zwar angenommen, zeigt aber weder bei Erfolg noch bei einem Fehler etwas an (VLC-Quellcode, URLHandler.swift).
// Der Dateiname kommt dabei aus dem Pfad der Adresse (z. B. 123.mkv).
const vlcPromptLink = (url) => `vlc://${url}`;

function callVlc(link, failText) {
  let left = false;
  const onHide = () => { if (document.hidden) left = true; };
  document.addEventListener('visibilitychange', onHide);
  const a = document.createElement('a');
  a.href = link;
  a.click();
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (!left) toast(failText || 'VLC hat sich nicht geöffnet. Ist die App installiert?');
  }, 1800);
}

function openInVlcDownload(url) {
  callVlc(vlcPromptLink(url), 'VLC hat sich nicht geöffnet. Ist die App installiert? Alternativ den Link kopieren und in VLC unter „Netzwerk“ einfügen.');
}

/* In "Dateien" laden: Eine installierte Web-App darf auf dem iPhone keine Dateien in "Dateien" ablegen. Safari selbst
   kann das (Download-Symbol, läuft im Hintergrund weiter, Datei landet in Dateien > Downloads). Der Link zeigt auf
   eine andere Adresse derselben App als die installierte, damit er sich außerhalb der App in Safari öffnet. Die Datei
   kommt über den Proxy (Content-Disposition: attachment) und verbraucht Vercel-Datenvolumen. */
const ALT_HOSTS = ['playerip-seiche.vercel.app', 'playerip-git-claude-playerip-pwa-seiche.vercel.app'];

function filesDownloadHref(url, filename) {
  let origin = location.origin;
  if (ALT_HOSTS.includes(location.hostname)) origin = `https://${ALT_HOSTS.find((h) => h !== location.hostname)}`;
  return `${origin}/api/proxy?u=${encodeURIComponent(url)}&k=${encodeURIComponent(cfg.key)}&dl=1&name=${encodeURIComponent(filename)}`;
}

function saveToFiles(url, filename) {
  const href = filesDownloadHref(url, filename);
  const copyAction = { label: 'Link kopieren', fn: async () => { if (await copyText(href)) toast('Download-Link kopiert. In Safari einfügen und öffnen.'); } };
  const w = window.open(href, '_blank');
  if (w) toast('Safari öffnet den Download. Fortschritt am Download-Symbol in Safari, fertig in „Dateien“, Ordner „Downloads“.', copyAction);
  else toast('Safari konnte nicht geöffnet werden. Kopiere den Link und öffne ihn in Safari.', copyAction);
}

function openSheet(title, items) {
  $('#sheet-title').textContent = title;
  $('#sheet-items').replaceChildren(...items.map((i) => {
    const b = el('button', null, i.label);
    b.type = 'button';
    if (i.hint) b.append(el('small', null, i.hint));
    b.addEventListener('click', () => { show($('#sheet'), false); i.fn(); });
    return b;
  }));
  show($('#sheet'), true);
}
$('#sheet-cancel').addEventListener('click', () => show($('#sheet'), false));
$('#sheet').addEventListener('click', (e) => { if (e.target.id === 'sheet') show($('#sheet'), false); });

function vlcMenu(title, url, filename) {
  openSheet(title, [
    { label: '▶ In VLC abspielen', hint: 'Streamt direkt vom Anbieter', fn: () => openInVlc(url) },
    { label: '⬇ In „Dateien“ laden', hint: 'Safari speichert den Film im Ordner „Downloads“ der App Dateien (läuft über Vercel)', fn: () => saveToFiles(url, filename) },
    { label: '⬇ In VLC herunterladen', hint: 'VLC fragt nach, dann „Herunterladen“ wählen. Danach offline und per AirPlay nutzbar', fn: () => openInVlcDownload(url) },
    { label: 'Link kopieren', hint: 'Für „Netzwerk“ in VLC. Der Link enthält dein Passwort', fn: async () => { if (await copyText(url)) toast('Link kopiert.'); } },
  ]);
}

function openInVlc(url) {
  let left = false;
  const onHide = () => { if (document.hidden) left = true; };
  document.addEventListener('visibilitychange', onHide);
  const a = document.createElement('a');
  a.href = vlcLink(url);
  a.click();
  setTimeout(() => {
    document.removeEventListener('visibilitychange', onHide);
    if (left) return;
    toast('VLC hat sich nicht geöffnet. Ist die App installiert?', {
      label: 'Link kopieren',
      fn: async () => { if (await copyText(url)) toast('Link kopiert. In VLC: Netzwerk, Netzwerkstream öffnen, Link einfügen.'); },
    });
  }, 1800);
}

function vlcControl(url, filename) {
  const root = el('div', 'vlc');
  const open = el('button', 'vlc-btn', '▶ In VLC abspielen');
  open.type = 'button';
  open.addEventListener('click', () => openInVlc(url));
  const down = el('button', 'vlc-btn', '⬇ In VLC laden');
  down.type = 'button';
  down.addEventListener('click', () => openInVlcDownload(url));
  const files = el('button', 'vlc-btn vlc-wide', '⬇ In „Dateien“ laden (Safari)');
  files.type = 'button';
  files.addEventListener('click', () => saveToFiles(url, filename));
  const copy = el('button', 'vlc-btn vlc-wide', 'Link kopieren');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    const ok = await copyText(url);
    copy.textContent = ok ? '✓ Kopiert' : 'Link kopieren';
    if (ok) setTimeout(() => { copy.textContent = 'Link kopieren'; }, 2000);
  });
  root.append(open, down, files, copy, el('p', 'vlc-note', '„In „Dateien“ laden“ öffnet Safari und speichert den Film im Ordner „Downloads“ der App Dateien (über Vercel, verbraucht Datenvolumen). „In VLC laden“: VLC fragt nach, dann „Herunterladen“ wählen. VLC speichert den Film selbst (lokal, offline, auch MKV, per AirPlay übertragbar). Der Name in VLC ist die Filmnummer. Der Link enthält dein Passwort.'));
  return root;
}

async function openMovie(it) {
  const token = openDetail(it.name);
  const { username: u, password: p } = cfg;
  const body = $('#detail-body');
  const dlDesc = { id: `vod:${it.id}`, kind: 'vod', itemId: it.id, ext: it.ext, title: it.name, sub: '', icon: it.icon };
  const play = el('button', 'primary play', '▶ Abspielen');
  play.addEventListener('click', () => {
    const saved = dlMetas.get(dlDesc.id);
    if (saved?.state === 'done') { playDownloaded(saved); return; } // lokal vorhanden: kein Datenverbrauch
    playStream(`${cfg.server}/movie/${u}/${p}/${it.id}.${it.ext}`, it.name, it.ext.toUpperCase(), null,
      `${cfg.server}/movie/${u}/${p}/${it.id}.m3u8`);
  });
  const fmtChip = { text: it.ext.toUpperCase(), cls: fmtClass(it.ext) };
  const langChip = it.lang && { text: LANGS[it.lang].label };

  renderHead({ cover: it.icon, chips: [fmtChip, langChip], lines: [], plot: '' });
  body.replaceChildren(play, dlControl(dlDesc), vlcControl(`${cfg.server}/movie/${u}/${p}/${it.id}.${it.ext}`, `${it.name}.${it.ext}`));
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
        const label = el('span', 'name', episodeTitle(ep.title, it.name, ep.episode_num));
        const epExt = ep.container_extension || 'mp4';
        const dlDesc = { id: `ep:${ep.id}`, kind: 'ep', itemId: ep.id, ext: epExt, title: it.name, sub: `S${s} · ${label.textContent}`, icon: it.icon };
        const vlc = el('button', 'dl-circle vlc-circle', 'VLC');
        vlc.type = 'button';
        vlc.setAttribute('aria-label', 'In VLC öffnen');
        vlc.addEventListener('click', (e) => {
          e.stopPropagation();
          vlcMenu(`${it.name} · ${label.textContent}`, `${cfg.server}/series/${cfg.username}/${cfg.password}/${ep.id}.${epExt}`, `${it.name} S${s} ${label.textContent}.${epExt}`);
        });
        vlc.addEventListener('keydown', (e) => e.stopPropagation());
        row.append(label, el('span', `fmt ${fmtClass(epExt)}`, epExt.toUpperCase()), vlc, dlControl(dlDesc, true));
        const go = () => dlMetas.get(dlDesc.id)?.state === 'done' ? playDownloaded(dlMetas.get(dlDesc.id)) : playStream(
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
  el.classList.remove('note');
  el.textContent = msg || '';
  show(el, Boolean(msg));
}

let remux = null;

// Startet die Umwandlung eines MKV im Browser; opts: { audioIndex, startAt } beim Wechsel der Tonspur.
function launchRemux(cand, token, opts = {}) {
  stopRemux();
  setAirplayMode('mirror');
  const base = $('#player-sub').textContent.split(' · ')[0];
  const note = (txt) => { if (token === playToken) $('#player-sub').textContent = [base, txt].filter(Boolean).join(' · '); };
  note('MKV wird im Browser umgewandelt (experimentell) …');
  remuxCtx = { cand, token };
  import('/vendor/mkvstream.js')
    .then(({ playMkv }) => playMkv(video, cand.blob || cand.src, {
      ...opts,
      onStatus: note,
      onError: (e) => { if (token === playToken) showPlayerError(`Umwandlung fehlgeschlagen: ${e.message}`); },
    }))
    .then((ctrl) => {
      if (token !== playToken) { ctrl.destroy(); return; }
      remux = ctrl;
      note(ctrl.info.skipped ? `Ton nicht unterstützt (${ctrl.info.skipped}) – ohne Ton` : (ctrl.info.audio ? `Ton: ${ctrl.info.audio}` : 'ohne Ton'));
      video.onerror = () => showPlayerError('Wiedergabe nicht möglich (Bild- oder Tonformat wird nicht unterstützt).');
      updateAudioButton();
      video.play().catch(() => {});
    })
    .catch((e) => { if (token === playToken) showPlayerError(`Umwandlung nicht möglich: ${e.message}`); });
}

let remuxCtx = null;
function switchRemuxAudio(index) {
  if (!remuxCtx) return;
  launchRemux(remuxCtx.cand, remuxCtx.token, { audioIndex: index, startAt: video.currentTime });
}

function stopRemux() {
  if (remux) { remux.destroy(); remux = null; }
}

function teardownPlayer() {
  playToken++;
  stopRemux();
  revokeLocal();
  setAirplayMode('native');
  remuxCtx = null;
  closeMenu();
  $('#audio-btn').hidden = true;
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
  if (cand.kind !== 'remux') setAirplayMode('native');
  if (hls) { hls.destroy(); hls = null; }

  const next = async () => {
    if (token !== playToken) return;
    if (index + 1 < list.length) tryCandidate(list, index + 1, token);
    else showPlayerError(await describeFailure(list.map((c) => c.url)));
  };

  if (cand.kind === 'remux') {
    launchRemux(cand, token);
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

let localUrl = null;
function revokeLocal() {
  if (localUrl) { URL.revokeObjectURL(localUrl); localUrl = null; }
}

// Heruntergeladene Datei abspielen (offline): MP4 & Co. direkt, MKV über die Umwandlung im Browser
async function playDownloaded(meta) {
  $('#player-title').textContent = meta.title;
  $('#player-sub').textContent = [meta.sub, 'Offline'].filter(Boolean).join(' · ');
  if (!layers.includes('player')) pushLayer('player');
  show($('#player'), true);
  showUi();
  stopRemux();
  revokeLocal();
  if (hls) { hls.destroy(); hls = null; }
  const token = ++playToken;
  showPlayerError('');
  try {
    const parts = await dlDb.chunksGet(meta.id);
    if (token !== playToken) return;
    const ext = String(meta.ext).toLowerCase();
    const blob = new Blob(parts, { type: DL_MIME[ext] || 'video/mp4' });
    if (ext === 'mkv' && !video.canPlayType('video/x-matroska') && canRemux()) { launchRemux({ kind: 'remux', blob }, token); return; }
    localUrl = URL.createObjectURL(blob);
    setAirplayMode('mirror'); // blob: kann der Apple TV nicht abrufen
    video.onerror = () => showPlayerError('Wiedergabe nicht möglich (Format wird von diesem Gerät nicht unterstützt).');
    video.src = localUrl;
    video.play().catch(() => {});
  } catch (e) {
    if (token === playToken) showPlayerError(`Die Offline-Datei konnte nicht geöffnet werden: ${e.message}`);
  }
}

async function playStream(url, title, sub, liveId, alt) {
  $('#player-title').textContent = title;
  $('#player-sub').textContent = sub || '';
  if (!layers.includes('player')) pushLayer('player');
  show($('#player'), true);
  showUi();
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

/* ---------- Eigene Bedienelemente ---------- */
/* Safaris Standardleiste lässt sich nicht verschieben oder teilweise ausblenden (AirPlay, Tempo-Menü, Ränder).
   Darum zeichnen wir die Bedienung selbst. Alles blendet gemeinsam aus und ein, auch der Titel. */

const UI_HIDE_MS = 5000;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const playerEl = $('#player');
const scrub = $('#scrub');
let scrubbing = false;
let scrubFrac = 0;
let menuKind = null;
let rate = 1;

const isLive = () => video.duration === Infinity;

function showUi() {
  playerEl.classList.remove('idle');
  clearTimeout(idleTimer);
  if (!video.paused && !scrubbing && !menuKind) idleTimer = setTimeout(hideUi, UI_HIDE_MS);
}

function hideUi() {
  clearTimeout(idleTimer);
  if (video.paused || scrubbing) return;
  closeMenu();
  playerEl.classList.add('idle');
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function setScrub(frac) {
  const f = Math.min(1, Math.max(0, frac || 0));
  scrub.value = String(Math.round(f * 1000));
  scrub.style.setProperty('--p', `${f * 100}%`);
}

function updateTimes() {
  const live = isLive();
  show($('#live-badge'), live);
  for (const id of ['#t-cur', '#t-rem', '#scrub', '#skip-back', '#skip-fwd', '#speed-btn']) $(id).hidden = live;
  if (live) return;
  const d = Number.isFinite(video.duration) ? video.duration : 0;
  const c = scrubbing ? scrubFrac * d : video.currentTime;
  $('#t-cur').textContent = fmtTime(c);
  $('#t-rem').textContent = `-${fmtTime(d - c)}`;
  if (!scrubbing) setScrub(d ? c / d : 0);
}

function updatePlayState() {
  playerEl.classList.toggle('playing', !video.paused);
}

for (const ev of ['timeupdate', 'durationchange', 'loadedmetadata', 'seeked', 'emptied']) video.addEventListener(ev, updateTimes);
for (const ev of ['play', 'pause', 'playing', 'emptied']) video.addEventListener(ev, updatePlayState);
video.addEventListener('play', showUi);
video.addEventListener('pause', showUi);
video.addEventListener('loadedmetadata', () => { video.playbackRate = rate; updateAudioButton(); });

$('#play-btn').addEventListener('click', () => { if (video.paused) video.play().catch(() => {}); else video.pause(); });
const skip = (delta) => {
  const d = Number.isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime = Math.min(Math.max(0, video.currentTime + delta), d);
};
$('#skip-back').addEventListener('click', () => skip(-10));
$('#skip-fwd').addEventListener('click', () => skip(10));

scrub.addEventListener('pointerdown', () => { scrubbing = true; showUi(); });
scrub.addEventListener('input', () => { scrubbing = true; scrubFrac = Number(scrub.value) / 1000; scrub.style.setProperty('--p', `${scrubFrac * 100}%`); updateTimes(); });
scrub.addEventListener('change', () => {
  if (Number.isFinite(video.duration)) video.currentTime = (Number(scrub.value) / 1000) * video.duration;
  scrubbing = false;
  showUi();
});

/* Tippen: auf Bedienelemente = sichtbar halten, aufs Bild = ein- bzw. ausblenden */
playerEl.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.player-bar, .side-stack, .center-ctl, .bottom-bar, .menu')) { showUi(); return; }
  if (menuKind) { closeMenu(); return; }
  if (e.pointerType === 'mouse') { showUi(); $('#play-btn').click(); return; } // Desktop: Klick aufs Bild = Start/Pause
  if (playerEl.classList.contains('idle') || video.paused) showUi(); else hideUi();
});
playerEl.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') showUi(); });
playerEl.addEventListener('keydown', (e) => {
  showUi();
  if (e.key === ' ' && !e.target.closest('button')) { e.preventDefault(); $('#play-btn').click(); }
  else if (e.key === 'ArrowLeft' && !isLive()) skip(-10);
  else if (e.key === 'ArrowRight' && !isLive()) skip(10);
});

/* ----- Menüs (Tempo, Tonspur) ----- */
function closeMenu() {
  menuKind = null;
  show($('#player-menu'), false);
}

function openMenu(kind, items) {
  if (menuKind === kind) { closeMenu(); return; }
  menuKind = kind;
  const menu = $('#player-menu');
  menu.replaceChildren(...items.map((i) => {
    const b = el('button', null, i.label);
    b.type = 'button';
    b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(Boolean(i.checked)));
    b.addEventListener('click', () => { i.pick(); closeMenu(); showUi(); });
    return b;
  }));
  show(menu, true);
  showUi();
}

const speedText = (r) => `${String(r).replace('.', ',')}×`;
function updateSpeedLabel() { $('#speed-label').textContent = speedText(rate); }
$('#speed-btn').addEventListener('click', () => openMenu('speed', SPEEDS.map((r) => ({
  label: speedText(r),
  checked: r === rate,
  pick: () => { rate = r; video.playbackRate = r; video.defaultPlaybackRate = r; updateSpeedLabel(); },
}))));

/* Tonspuren: Safari meldet sie bei normalen Dateien/HLS selbst; bei umgewandelten MKV kennt sie unser Modul */
function audioOptions() {
  if (remux?.info?.audioTracks?.length > 1) {
    return remux.info.audioTracks.map((t) => ({
      label: [langLabel(t.lang) || t.lang || `Spur ${t.index + 1}`, String(t.codec).toUpperCase()].filter(Boolean).join(' · '),
      checked: t.index === remux.info.audioIndex,
      pick: () => switchRemuxAudio(t.index),
    }));
  }
  const list = video.audioTracks;
  if (list && list.length > 1) {
    return [...list].map((t, i) => ({
      label: t.label || langLabel(t.language) || t.language || `Spur ${i + 1}`,
      checked: t.enabled,
      pick: () => { [...list].forEach((x, j) => { x.enabled = j === i; }); },
    }));
  }
  return [];
}

function updateAudioButton() {
  $('#audio-btn').hidden = audioOptions().length === 0;
}
$('#audio-btn').addEventListener('click', () => openMenu('audio', audioOptions()));
if (video.audioTracks) {
  video.audioTracks.addEventListener?.('addtrack', updateAudioButton);
  video.audioTracks.addEventListener?.('removetrack', updateAudioButton);
}

/* AirPlay: Safari gibt dem Apple TV die Adresse des Videos, und der lädt es selbst. Das geht nur bei echten
   Adressen (MP4/HLS vom Anbieter oder über den Proxy). Bei umgewandelten MKV (Media Source) und heruntergeladenen
   Dateien (blob:) hat der Apple TV nichts zum Abrufen. Dort bleibt nur die Bildschirmsynchronisierung. */
const isSafari = Boolean(window.WebKitPlaybackTargetAvailabilityEvent);
let airplayMode = 'native'; // 'native' = AirPlay-Video möglich, 'mirror' = nur Bildschirmsynchronisierung
let airAvailable = false;
let noteTimer;

function updateAirplayButton() {
  show($('#airplay'), isSafari && (airplayMode === 'mirror' || airAvailable));
  $('#airplay').classList.toggle('mirror', airplayMode === 'mirror');
}

function setAirplayMode(mode) {
  airplayMode = mode;
  video.disableRemotePlayback = mode === 'mirror'; // vorher blieb das nach einem MKV für alle weiteren Videos gesetzt
  updateAirplayButton();
}

function showPlayerNote(text, ms = 10000) {
  const e = $('#player-error');
  e.textContent = text;
  e.classList.add('note');
  show(e, true);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { if (e.classList.contains('note')) { show(e, false); e.classList.remove('note'); } }, ms);
}

if (isSafari) {
  video.addEventListener('webkitplaybacktargetavailabilitychanged', (e) => {
    airAvailable = e.availability === 'available';
    updateAirplayButton();
  });
  $('#airplay').addEventListener('click', () => {
    if (airplayMode === 'mirror') {
      showPlayerNote('Bei MKV-Filmen und heruntergeladenen Titeln geht kein AirPlay-Video, nur Spiegeln: Kontrollzentrum öffnen, „Bildschirmsynchronisierung“ antippen und den Apple TV wählen. Alternativ einen Film im MP4-Format nehmen.');
    } else {
      video.webkitShowPlaybackTargetPicker();
    }
  });
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
  render();
});
$('#logout-btn').addEventListener('click', async () => {
  store.del('cfg');
  await idb.clear();
  location.reload();
});

/* ---------- Start ---------- */

function updateOnlineBanner() {
  show($('#home-offline'), navigator.onLine === false);
}
window.addEventListener('online', updateOnlineBanner);
window.addEventListener('offline', updateOnlineBanner);

function startBrowse() {
  showScreen('browse');
  dlInit();
  updateOnlineBanner();
  render();
}

if (cfg?.server && cfg.key) startBrowse(); else showScreen('login');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
