import { selectCatalogueMatch, fullTitle, camelot, cacheKey, normalize } from './music.mjs';

export function createCatalogue(db, apiKey) {
  db.exec('CREATE TABLE IF NOT EXISTS soundcloud_tracks (url TEXT PRIMARY KEY, track_id TEXT NOT NULL)');
  const rememberSoundcloud = track => {
    if (track.source === 'soundcloud' && /^\d+$/.test(String(track.id)) && track.url) {
      const url = new URL(track.url); url.search = ''; url.hash = '';
      db.prepare('INSERT OR REPLACE INTO soundcloud_tracks VALUES (?, ?)').run(url.href.replace(/\/$/, ''), String(track.id));
    }
  };
  // Backfill the URL index from previously resolved tracks, including expired identity records.
  for (const row of db.prepare("SELECT value FROM metadata WHERE id GLOB 'track:https://soundcloud.com/*'").all()) {
    try { rememberSoundcloud(JSON.parse(row.value)); } catch { /* Ignore malformed legacy identity records. */ }
  }
  // Zero means permanent. Preserve older analyses, including those whose TTL has passed.
  db.prepare("UPDATE metadata SET expires = 0 WHERE id GLOB 'analysis:*' AND expires <> 0").run();
  let nextRequest = Promise.resolve();
  const inFlight = new Map();
  const get = (key) => {
    const row = db.prepare('SELECT value FROM metadata WHERE id = ? AND (expires = 0 OR expires > ?)').get(key, Date.now());
    return row ? JSON.parse(row.value) : undefined;
  };
  const put = (key, value, ttl = 30 * 86400000) => db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?, ?)').run(key, JSON.stringify(value), key.startsWith('analysis:') ? 0 : Date.now() + ttl);
  async function lookup(track) {
    if (track.source === 'vk') return null;
    const key = cacheKey(track), cached = get(key), analysed = get(`analysis:${key}`);
    if (cached !== undefined) return cached || analysed || null;
    if (!apiKey || track.source !== 'yandex') return analysed || null;
    if (inFlight.has(key)) return inFlight.get(key);
    const task = nextRequest.catch(() => {}).then(async () => {
      const query = new URLSearchParams({ type: 'both', lookup: `song:${normalize(fullTitle(track))} artist:${normalize(track.artists?.[0] || track.artist)}` });
      const response = await fetch(`https://api.getsong.co/search/?${query}`, { headers: { 'X-API-KEY': apiKey }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`GetSongBPM: HTTP ${response.status}`);
      const body = await response.json();
      const match = selectCatalogueMatch(track, Array.isArray(body.search) ? body.search : []);
      const value = match ? { bpm: Number(match.tempo) || null, key: camelot(match.key_of), musicalKey: match.key_of,
        bpmRange: match.tempoRange.length > 1 ? match.tempoRange : null,
        origin: 'GetSongBPM', method: 'catalogue', reference: match.uri } : null;
      put(key, value, value ? 30 * 86400000 : 86400000);
      return value || analysed || null;
    });
    nextRequest = task.finally(() => new Promise(resolve => setTimeout(resolve, 600)));
    nextRequest.catch(() => {});
    inFlight.set(key, task);
    try { return await task; } finally { inFlight.delete(key); }
  }
  const getAnalysis = track => get(`analysis:${cacheKey(track)}`) || null;
  const soundcloudCached = urls => Object.fromEntries(urls.map(url => {
    const row = db.prepare('SELECT track_id FROM soundcloud_tracks WHERE url = ?').get(url);
    return [url, row ? getAnalysis({ source: 'soundcloud', id: row.track_id }) : null];
  }));
  return { lookup, get, put, getAnalysis, rememberSoundcloud, soundcloudCached };
}
