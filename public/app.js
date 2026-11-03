'use strict';

/* ---------- Zustand & Hilfsfunktionen ---------- */

const $ = (sel) => document.querySelector(sel);
const PAGE_SIZE = 100;
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

async function loadType(type) {
  if (data[type]) return data[type];
  const def = TYPES[type];
  const [cats, items] = await Promise.all([api(def.cats), api(def.items)]);
  data[type] = {
    cats: Array.isArray(cats) ? cats : [],
    items: (Array.isArray(items) ? items : []).map((x) => ({
      type,
      id: x.stream_id ?? x.series_id,
      name: x.name || '(ohne Namen)',
      icon: x.stream_icon || x.cover || '',
      cat: String(x.category_id ?? ''),
      ext: x.container_extension || 'mp4',
    })),
  };
  return data[type];
}

function setStatus(text) {
  const s = $('#status');
  s.textContent = text || '';
  show(s, Boolean(text));
}

async function renderTab() {
  const list = $('#list');
  const sel = $('#category');
  list.replaceChildren();
  setStatus('Lade …');

  try {
    if (tab === 'fav') {
      await Promise.all(Object.keys(TYPES).map(loadType));
      sel.replaceChildren(new Option('Alle Favoriten', ''));
    } else {
      const d = await loadType(tab);
      const keep = sel.dataset.tab === tab ? sel.value : '';
      sel.replaceChildren(new Option('Alle Kategorien', ''), ...d.cats.map((c) => new Option(c.category_name, c.category_id)));
      sel.value = keep;
    }
    sel.dataset.tab = tab;
    sel.disabled = tab === 'fav';
    applyFilter();
  } catch (ex) {
    setStatus(`Laden fehlgeschlagen: ${ex.message}`);
  }
}

function applyFilter() {
  const q = $('#search').value.trim().toLowerCase();
  const cat = $('#category').value;
  let pool;
  if (tab === 'fav') {
    pool = Object.values(data).flatMap((d) => d.items).filter((it) => favs.has(favKey(it)));
  } else {
    pool = data[tab].items;
  }
  filtered = pool.filter((it) => (!cat || it.cat === cat) && (!q || it.name.toLowerCase().includes(q)));
  shown = 0;
  const list = $('#list');
  list.replaceChildren();
  list.classList.toggle('grid', tab !== 'live' && tab !== 'fav' && TYPES[tab].grid);
  setStatus(filtered.length ? '' : 'Nichts gefunden.');
  renderMore();
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

    li.append(img, name, fav);
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
    if (tab === 'fav') applyFilter();
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
  tab = b.dataset.tab;
  $('#search').value = '';
  for (const t of document.querySelectorAll('#tabs button')) t.setAttribute('aria-selected', String(t === b));
  renderTab();
});

$('#category').addEventListener('change', applyFilter);
let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilter, 150);
});

function openItem(it) {
  const base = cfg.server;
  const { username: u, password: p } = cfg;
  if (it.type === 'live') {
    playStream(`${base}/live/${u}/${p}/${it.id}.m3u8`, it.name, '', it.id);
  } else if (it.type === 'vod') {
    playStream(`${base}/movie/${u}/${p}/${it.id}.${it.ext}`, it.name, it.ext.toUpperCase());
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
  if (name === 'series') show($('#series-detail'), false);
});

/* ---------- Serien ---------- */

async function openSeries(it) {
  $('#series-title').textContent = it.name;
  const body = $('#series-body');
  body.replaceChildren(Object.assign(document.createElement('p'), { className: 'status', textContent: 'Lade …' }));
  if (!layers.includes('series')) pushLayer('series');
  show($('#series-detail'), true);

  try {
    const info = await api('get_series_info', { series_id: it.id });
    const seasons = info.episodes && !Array.isArray(info.episodes) ? info.episodes : { 1: info.episodes || [] };
    body.replaceChildren();
    const keys = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));
    if (!keys.length) throw new Error('Keine Episoden gefunden.');
    for (const s of keys) {
      const h = document.createElement('h3');
      h.textContent = `Staffel ${s}`;
      body.append(h);
      for (const ep of seasons[s]) {
        const row = document.createElement('div');
        row.className = 'item';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        const label = document.createElement('span');
        label.className = 'name';
        label.textContent = `${ep.episode_num ?? ''}. ${ep.title || 'Episode'}`;
        row.append(label);
        const go = () => playStream(
          `${cfg.server}/series/${cfg.username}/${cfg.password}/${ep.id}.${ep.container_extension || 'mp4'}`,
          it.name, `S${s} · ${label.textContent}`);
        row.addEventListener('click', go);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
        body.append(row);
      }
    }
  } catch (ex) {
    body.replaceChildren(Object.assign(document.createElement('p'), { className: 'status', textContent: ex.message }));
  }
}

$('#series-back').addEventListener('click', () => history.back());

/* ---------- Player ---------- */

const video = $('#video');
let hls = null;
let idleTimer;

function showPlayerError(msg) {
  const el = $('#player-error');
  el.textContent = msg || '';
  show(el, Boolean(msg));
}

function teardownPlayer() {
  if (hls) { hls.destroy(); hls = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
  show($('#player'), false);
  showPlayerError('');
}

function attach(url, { allowRetry }) {
  const isHls = /\.m3u8(\?|$)/i.test(url);
  const nativeHls = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
  showPlayerError('');

  if (hls) { hls.destroy(); hls = null; }

  // hls.js (Desktop-Chrome etc.) braucht CORS -> immer Proxy. Safari spielt HLS nativ (und kann AirPlay).
  if (isHls && !nativeHls && window.Hls?.isSupported()) {
    hls = new Hls();
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) showPlayerError('Stream konnte nicht geladen werden.'); });
    hls.loadSource(proxify(url));
    hls.attachMedia(video);
    video.play().catch(() => {});
    return;
  }

  const useProxy = needsProxy(url) || !allowRetry;
  video.src = useProxy ? proxify(url) : url;
  video.play().catch(() => {});

  video.onerror = () => {
    if (allowRetry && !useProxy) {
      attach(url, { allowRetry: false }); // einmal über den Proxy versuchen
    } else {
      showPlayerError('Wiedergabe nicht möglich. Das Format (z. B. MKV) wird vom Browser evtl. nicht unterstützt.');
    }
  };
}

async function playStream(url, title, sub, liveId) {
  $('#player-title').textContent = title;
  $('#player-sub').textContent = sub || '';
  if (!layers.includes('player')) pushLayer('player');
  show($('#player'), true);
  bumpControls();
  attach(url, { allowRetry: true });

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
$('#refresh-btn').addEventListener('click', () => {
  for (const k of Object.keys(data)) delete data[k];
  $('#settings').close();
  renderTab();
});
$('#logout-btn').addEventListener('click', () => {
  store.del('cfg');
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
