import { resolve } from 'node:path';
import { run } from './process.mjs';
const executable = process.env.YTDLP_PATH || resolve('.local/venv/bin/yt-dlp');
const common = ['--ignore-config', '--impersonate', 'chrome', '--no-warnings', '--socket-timeout', '15', '--retries', '1', '--extractor-retries', '1', '--no-playlist'];
const detailsCache = new Map(), pendingDetails = new Map();
export function soundcloudUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'soundcloud.com' || url.username || url.password || url.port || !/^\/[^/]+\/[^/]+\/?$/.test(url.pathname)) throw new Error('Нужна ссылка на трек SoundCloud');
  if (['you', 'discover', 'search', 'tags', 'settings', 'stations', 'charts', 'pages', 'artists'].includes(url.pathname.split('/')[1])) throw new Error('Нужна ссылка на трек SoundCloud');
  return url.origin + url.pathname;
}
async function trackDetails(value) {
  const url = soundcloudUrl(value), cached = detailsCache.get(url);
  if (cached?.expires > Date.now()) return cached.data;
  if (pendingDetails.has(url)) return pendingDetails.get(url);
  if (pendingDetails.size >= 4) throw new Error('SoundCloud занят. Повторите запрос через несколько секунд');
  const task = (async () => {
    const buffer = await run(executable, [...common, '--dump-single-json', '--skip-download', '--ignore-no-formats-error', url]);
    const data = JSON.parse(buffer);
    if (!/^\d+$/.test(String(data.id)) || !data.title || data._type === 'playlist') throw new Error('SoundCloud не вернул трек');
    if (detailsCache.size >= 100) detailsCache.delete(detailsCache.keys().next().value);
    detailsCache.set(url, { data, expires: Date.now() + 5 * 60000 });
    return data;
  })();
  pendingDetails.set(url, task);
  try { return await task; } finally { pendingDetails.delete(url); }
}
export async function getSoundcloudTrack(value) {
  const data = await trackDetails(value);
  return { source: 'soundcloud', id: String(data.id), title: data.title, artist: data.artist || data.uploader || '',
    duration: Number(data.duration) || 0, url: soundcloudUrl(data.webpage_url || value) };
}
export async function searchSoundcloud(query) {
  const buffer = await run(executable, [...common, '--flat-playlist', '--dump-single-json', `scsearch20:${query}`]);
  const data = JSON.parse(buffer);
  return (data.entries || []).map(t => ({ source: 'soundcloud', id: String(t.id), title: t.title,
    artist: t.artist || t.uploader || '', duration: t.duration || 0, url: t.webpage_url || t.url,
    metadata: Number(t.bpm) > 0 ? { bpm: Number(t.bpm), key: null, origin: 'SoundCloud', method: 'metadata' } : null }));
}
export async function resolveSoundcloud(track) {
  const data = await trackDetails(track.url);
  if (String(data.id) !== String(track.id)) throw new Error('SoundCloud вернул другой трек');
  // Progressive MP3 supports byte ranges and avoids transcoding on download.
  const rank = f => (f.acodec === 'mp3' ? 1000 : 0) + (f.protocol === 'http' || f.protocol === 'https' ? 500 : 0) + (f.abr || 0);
  const format = data.formats?.filter(f => f.acodec !== 'none' && f.url && !f.has_drm).sort((a, b) => rank(b) - rank(a))[0];
  if (!format) throw new Error('SoundCloud не предоставил доступное аудио. Возможны DRM, ограничения региона или требование входа.');
  return format.url;
}
