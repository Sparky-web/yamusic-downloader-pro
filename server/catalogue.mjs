import { selectCatalogueMatch, fullTitle, camelot, cacheKey, normalize } from './music.mjs';

export function createCatalogue(db, apiKey) {
  let nextRequest = Promise.resolve();
  const inFlight = new Map();
  const get = (key) => {
    const row = db.prepare('SELECT value FROM metadata WHERE id = ? AND expires > ?').get(key, Date.now());
    return row ? JSON.parse(row.value) : undefined;
  };
  const put = (key, value, ttl = 30 * 86400000) => db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?, ?)').run(key, JSON.stringify(value), Date.now() + ttl);
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
  return { lookup, get, put };
}
