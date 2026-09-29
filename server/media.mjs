import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createDecipheriv } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const domains = {
  yandex: ['yandex.net', 'yandex.ru'],
  soundcloud: ['sndcdn.com', 'soundcloud.com', 'media-streaming.soundcloud.cloud'],
  vk: ['vkuseraudio.net', 'vkuseraudio.com', 'userapi.com', 'vk-cdn.net', 'vkuser.net', 'vkuseraudio.ru'],
};
export function validateMediaUrl(input, source) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !domains[source]?.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`))) throw new Error('Недопустимый адрес аудио');
  return url;
}
export function publicAddress(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 100 && b >= 64 && b <= 127) || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0);
}
export async function fetchMedia(input, source, { range, limit = 24 * 1024 * 1024, redirects = 0 } = {}) {
  const url = validateMediaUrl(input, source);
  if (redirects > 4) throw new Error('Слишком много переадресаций');
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Адрес аудио не является публичным');
  const result = await new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { ...(range ? { Range: `bytes=${range[0]}-${range[1]}` } : {}), 'User-Agent': 'Mozilla/5.0' },
      lookup: (_host, options, callback) => options.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4) }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) { res.resume(); resolve({ redirect: new URL(res.headers.location, url).href }); return; }
      if (![200, 206].includes(res.statusCode)) { res.resume(); reject(new Error(`Аудио: HTTP ${res.statusCode}`)); return; }
      let size = 0; const chunks = [];
      res.on('data', chunk => {
        size += chunk.length;
        if (size > limit) { req.destroy(new Error('Аудио превышает лимит размера')); } else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers: res.headers, status: res.statusCode, url: url.href }));
    });
    const timer = setTimeout(() => req.destroy(new Error('Истекло время загрузки аудио')), 45000);
    req.on('close', () => clearTimeout(timer)); req.on('error', reject);
  });
  return result.redirect ? fetchMedia(result.redirect, source, { range, limit, redirects: redirects + 1 }) : result;
}
export function parsePlaylist(text, base) {
  let duration = 0, time = 0, key = null, sequence = 0;
  const segments = [], variants = [];
  const lines = text.trim().split(/\r?\n/).map(s => s.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-STREAM-INF:')) variants.push(new URL(lines[++i], base).href);
    else if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line.startsWith('#EXT-X-KEY:')) {
      if (line.includes('METHOD=NONE')) key = null;
      else {
        if (!line.includes('METHOD=AES-128')) throw new Error('Формат шифрования HLS не поддерживается');
        const uri = line.match(/URI="([^"]+)"/)?.[1];
        if (!uri) throw new Error('В HLS отсутствует ключ');
        key = { url: new URL(uri, base).href, iv: line.match(/IV=0x([a-fA-F0-9]+)/)?.[1] };
      }
    } else if (line.startsWith('#EXT-X-MAP') || line.startsWith('#EXT-X-BYTERANGE')) throw new Error('Этот тип HLS пока не поддерживается');
    else if (line && !line.startsWith('#')) { segments.push({ url: new URL(line, base).href, duration, time, key, sequence: sequence++ }); time += duration; }
  }
  return { segments, variants, duration: time };
}
export async function acquireAudio(url, track, output, { full = false, fraction = 0.25, seconds = 40 } = {}) {
  const first = await fetchMedia(url, track.source, { range: [0, 65535], limit: 80 * 1024 * 1024 });
  let bytes = first.buffer.length;
  if (first.buffer.subarray(0, 7).toString() === '#EXTM3U') {
    let current = first;
    let playlist;
    for (let depth = 0; depth < 4; depth++) {
      // A range may truncate a large manifest. Refetch it with a strict manifest limit.
      if (current.status === 206) { current = await fetchMedia(current.url, track.source, { limit: 2 * 1024 * 1024 }); bytes += current.buffer.length; }
      playlist = parsePlaylist(current.buffer.toString(), current.url);
      if (!playlist.variants.length) break;
      current = await fetchMedia(playlist.variants[0], track.source, { limit: 2 * 1024 * 1024 }); bytes += current.buffer.length;
    }
    if (!playlist?.segments.length) throw new Error('Пустой список сегментов HLS');
    const start = full ? 0 : Math.max(0, Math.min(playlist.duration - seconds, playlist.duration * fraction));
    const selected = playlist.segments.filter(s => full || s.time + s.duration > start && s.time < start + seconds);
    const buffers = [], keys = new Map();
    for (const segment of selected) {
      let { buffer } = await fetchMedia(segment.url, track.source);
      bytes += buffer.length;
      if (bytes > 100 * 1024 * 1024) throw new Error('Аудио превышает лимит 100 МБ');
      if (segment.key) {
        if (!keys.has(segment.key.url)) keys.set(segment.key.url, (await fetchMedia(segment.key.url, track.source, { limit: 1024 })).buffer);
        const iv = segment.key.iv ? Buffer.from(segment.key.iv.padStart(32, '0'), 'hex') : Buffer.alloc(16);
        if (!segment.key.iv) iv.writeBigUInt64BE(BigInt(segment.sequence), 8);
        const decipher = createDecipheriv('aes-128-cbc', keys.get(segment.key.url), iv);
        buffer = Buffer.concat([decipher.update(buffer), decipher.final()]);
      }
      buffers.push(buffer);
    }
    await writeFile(output, Buffer.concat(buffers));
    return { bytes, start: selected[0]?.time || 0, partial: !full && selected.length < playlist.segments.length, format: 'HLS' };
  }
  const total = Number(first.headers['content-range']?.split('/')[1] || first.headers['content-length']);
  if (full || first.status !== 206 || !track.duration || !total) {
    const result = first.status === 200 ? first : await fetchMedia(url, track.source, { limit: 100 * 1024 * 1024 });
    await writeFile(output, result.buffer);
    const start = full ? 0 : Math.max(0, Math.min(track.duration - seconds, track.duration * fraction));
    return { bytes: bytes + (result === first ? 0 : result.buffer.length), start, decodeStart: start, partial: false, format: 'file' };
  }
  const start = Math.max(0, Math.min(track.duration - seconds - 5, track.duration * fraction));
  const from = Math.floor(total * start / track.duration);
  const to = Math.min(total - 1, from + Math.ceil(total * (seconds + 5) / track.duration));
  const result = await fetchMedia(url, track.source, { range: [from, to], limit: 80 * 1024 * 1024 });
  await writeFile(output, result.buffer);
  return { bytes: bytes + result.buffer.length, start, decodeStart: result.status === 206 ? 0 : start, partial: result.status === 206, format: 'range' };
}
