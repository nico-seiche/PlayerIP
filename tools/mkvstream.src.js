// MKV im Browser abspielen: Matroska lesen, ohne Neukodierung in fragmentiertes MP4 umpacken
// und per Media Source Extensions in ein <video> einspeisen. Läuft nur, wenn der Browser
// Bild- und Tonformat des Films ohnehin dekodieren kann (z. B. H.264/HEVC + AAC/AC-3).
import { Input, UrlSource, MATROSKA, Output, Mp4OutputFormat, NullTarget, Conversion } from 'mediabunny';

const AHEAD = 45; // Sekunden, die vor der Abspielposition vorbereitet werden
const STEP = 6; // Schrittweite beim Vorarbeiten (Sekunden)
const BEHIND = 40; // Sekunden hinter der Position, die im Puffer bleiben
const PASS_AUDIO = new Set(['aac', 'ac3', 'eac3', 'opus', 'mp3']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mime = (kind, codecs) => `${kind}/mp4; codecs="${codecs}"`;

export async function playMkv(video, url, { preferLangs = ['ger', 'deu', 'de'], onStatus = () => {}, onError = () => {}, debug = () => {} } = {}) {
  const MS = window.ManagedMediaSource || window.MediaSource;
  if (!MS) throw new Error('Dieser Browser unterstützt keine Media Source Extensions.');

  onStatus('Lese Dateiinfos …');
  const input = new Input({ source: new UrlSource(url), formats: [MATROSKA] });
  const duration = (await input.getDurationFromMetadata()) ?? (await input.computeDuration());

  // ---- Bild
  const vTrack = await input.getPrimaryVideoTrack();
  if (!vTrack) throw new Error('Keine Videospur gefunden.');
  const vCodec = await vTrack.getCodecParameterString();
  if (!vCodec || !MS.isTypeSupported(mime('video', vCodec))) {
    throw new Error(`Videoformat (${vTrack.codec || 'unbekannt'}) wird von diesem Gerät nicht unterstützt.`);
  }

  // ---- Ton: bevorzugte Sprache, nur Spuren, die der Browser abspielen kann
  let aTrack = null;
  let aCodec = null;
  let aTranscode = false;
  const rank = (t) => {
    const i = preferLangs.indexOf(String(t.languageCode || '').toLowerCase());
    return i === -1 ? preferLangs.length : i;
  };
  const audios = (await input.getAudioTracks()).sort((a, b) => rank(a) - rank(b));
  for (const t of audios) {
    const cs = await t.getCodecParameterString();
    if (PASS_AUDIO.has(t.codec) && cs && MS.isTypeSupported(mime('audio', cs))) { aTrack = t; aCodec = cs; break; }
  }
  const skipped = audios.length && !aTrack ? audios.map((t) => t.codec).join(', ') : '';
  const readyText = skipped ? `Ton nicht unterstützt (${skipped}) – ohne Ton` : aTrack ? `Ton: ${aTrack.languageCode || '?'} ${aTrack.codec}` : 'ohne Ton';
  const codecs = aCodec ? `${vCodec},${aCodec}` : vCodec;
  const fullMime = mime('video', codecs);
  if (!MS.isTypeSupported(fullMime)) throw new Error('Diese Kombination aus Bild- und Tonformat wird nicht unterstützt.');

  // ---- MediaSource
  const ms = new MS();
  const objectUrl = URL.createObjectURL(ms);
  video.disableRemotePlayback = true; // bei ManagedMediaSource nötig (AirPlay ist hier nicht möglich)
  video.src = objectUrl;
  await new Promise((resolve, reject) => {
    ms.addEventListener('sourceopen', resolve, { once: true });
    setTimeout(() => reject(new Error('Media Source wurde nicht geöffnet.')), 10000);
  });
  if (Number.isFinite(duration)) ms.duration = duration;
  const sb = ms.addSourceBuffer(fullMime);

  let destroyed = false;
  let runId = 0;
  let conv = null;
  let queue = [];
  let appendedEnd = 0; // Ende des zuletzt angehängten Fragments (Filmzeit)
  let fatal = null;
  const fail = (e) => { if (!fatal && !destroyed) { fatal = e; onError(e); } };

  const waitIdle = () => (sb.updating ? new Promise((r) => sb.addEventListener('updateend', r, { once: true })) : null);

  async function append(data) {
    await waitIdle();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        sb.appendBuffer(data);
        await waitIdle();
        return;
      } catch (e) {
        if (e.name !== 'QuotaExceededError') throw e;
        // Speicher voll: alles weit hinter der Position entfernen
        const keep = Math.max(0, video.currentTime - 10);
        if (keep > 0) { sb.remove(0, keep); await waitIdle(); } else { await sleep(500); }
      }
    }
    throw new Error('Puffer voll.');
  }

  async function trimBehind() {
    if (sb.updating || !sb.buffered.length) return;
    const start = sb.buffered.start(0);
    const cut = video.currentTime - BEHIND;
    if (cut - start > 10) { sb.remove(start, cut); await waitIdle(); }
  }

  const buffered = (t) => { for (let i = 0; i < sb.buffered.length; i++) if (t >= sb.buffered.start(i) - 0.1 && t <= sb.buffered.end(i)) return true; return false; };

  let current = Promise.resolve();

  async function run(startAt) {
    const my = ++runId;
    if (conv) { conv.cancel().catch(() => {}); conv = null; }
    queue = [];
    const parts = { init: [], frag: [] };
    let firstTs = null;
    const copy = (d) => d.slice();
    const output = new Output({
      format: new Mp4OutputFormat({
        fastStart: 'fragmented',
        minimumFragmentDuration: 2,
        onFtyp: (d) => parts.init.push(copy(d)),
        onMoov: (d) => parts.init.push(copy(d)),
        onMoof: (d, _p, ts) => { if (firstTs == null) firstTs = ts; parts.frag = [copy(d)]; },
        onMdat: (d) => {
          queue.push(concat([...parts.frag, copy(d)]));
          parts.frag = [];
        },
      }),
      target: new NullTarget(),
    });
    conv = await Conversion.init({
      input,
      output,
      trim: startAt > 0 ? { start: startAt } : undefined,
      audio: (t) => (aTrack && t === aTrack ? {} : { discard: true }),
      tracks: 'all',
    });
    if (!conv.isValid) throw new Error('Umwandlung nicht möglich.');
    const myConv = conv;
    const alive = () => my === runId && !destroyed;

    // Treiber: die Umwandlung läuft nur so weit voraus, wie nötig. `until` zählt in der Zeitachse der
    // Ausgabe, die bei einem Sprung (trim) wieder bei 0 beginnt, daher + startAt für die Filmzeit.
    let finished = false;
    let driverError = null;
    (async () => {
      try {
        let until = STEP;
        for (;;) {
          await myConv.execute({ until });
          if (!alive()) return;
          if (myConv.state === 'done') { finished = true; return; }
          while (alive() && startAt + until - video.currentTime > AHEAD) await sleep(300);
          if (!alive()) return;
          until += STEP;
        }
      } catch (e) {
        if (alive() && e?.name !== 'ConversionCanceledError') driverError = e;
      }
    })();

    // Einziger Verbraucher: hängt Fragmente nacheinander an den Puffer
    let initDone = false;
    let announced = false;
    while (alive()) {
      if (driverError) throw driverError;
      if (queue.length && (initDone || parts.init.length)) {
        if (!initDone) {
          await waitIdle();
          sb.abort();
          sb.timestampOffset = startAt;
          await append(concat(parts.init));
          initDone = true;
          debug({ startAt, firstTs });
        }
        await append(queue.shift());
        if (!alive()) break;
        if (!announced) { announced = true; onStatus(readyText); }
        appendedEnd = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : appendedEnd;
        await trimBehind();
        continue;
      }
      if (finished && !queue.length) break;
      await sleep(60);
    }
    if (alive() && finished && ms.readyState === 'open') {
      await waitIdle();
      try { ms.endOfStream(); } catch { /* ignore */ }
    }
  }

  function concat(arrs) {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.byteLength, 0));
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.byteLength; }
    return out;
  }

  let seekTimer;
  const onSeeking = () => {
    clearTimeout(seekTimer);
    seekTimer = setTimeout(async () => {
      const t = video.currentTime;
      if (destroyed || buffered(t)) return;
      onStatus('Springe …');
      runId++; // laufenden Durchgang beenden und dessen letzten Schritt abwarten
      await current.catch(() => {});
      if (destroyed) return;
      try {
        await waitIdle();
        sb.abort();
        sb.remove(0, Infinity);
        await waitIdle();
        appendedEnd = 0;
        current = run(t);
        current.catch(fail);
      } catch (e) { fail(e); }
    }, 150);
  };
  video.addEventListener('seeking', onSeeking);

  onStatus(skipped ? `Ton nicht unterstützt (${skipped}) – Film läuft ohne Ton …` : 'Bereite Film vor …');
  const first = run(0);
  current = first;
  const ctrl = {
    info: { duration, audio: aTrack ? `${aTrack.languageCode || '?'} ${aTrack.codec}` : null, skipped },
    get error() { return fatal; },
    done: first,
    destroy() {
      destroyed = true;
      runId++;
      clearTimeout(seekTimer);
      video.removeEventListener('seeking', onSeeking);
      conv?.cancel().catch(() => {});
      try { input.dispose?.(); } catch { /* ignore */ }
      URL.revokeObjectURL(objectUrl);
    },
  };
  first.catch(fail);
  return ctrl;
}
