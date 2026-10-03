import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, rm, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { validateTrack, cacheKey } from './music.mjs';
import { createCatalogue } from './catalogue.mjs';
import { acquireAudio, validateMediaUrl } from './media.mjs';
import { searchSoundcloud, resolveSoundcloud, getSoundcloudTrack, soundcloudUrl } from './soundcloud.mjs';
import { run } from './process.mjs';

const token = process.env.SERVICE_TOKEN;
if (!token || token.length < 32) throw new Error('Сначала выполните pnpm configure');
const dataDir = resolve('server/data');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
for (const name of await readdir(dataDir)) if (/^[a-f0-9-]{36}$/.test(name)) {
  const path = join(dataDir, name);
  if (Date.now() - (await stat(path)).mtimeMs > 3600000) await rm(path, { force: true, recursive: true });
}
const db = new DatabaseSync(join(dataDir, 'cache.sqlite'));
db.exec('CREATE TABLE IF NOT EXISTS metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)');
const catalogue = createCatalogue(db, process.env.GETSONG_API_KEY);
const jobs = new Map();
const inflight = new Map();
let queue = Promise.resolve();
let searchRunning = 0;
function analyse(path) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analyse-worker.mjs', import.meta.url), { workerData: { path } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('Анализ превысил лимит времени')); }, 90000);
    worker.once('message', data => { clearTimeout(timer); worker.terminate(); data.error ? reject(new Error(data.error)) : resolve(data); });
    worker.once('error', err => { clearTimeout(timer); reject(err); });
    worker.once('exit', code => { if (code) { clearTimeout(timer); reject(new Error('Процесс анализа завершился')); } });
  });
}
async function processJob(job, track) {
  job.status = 'running';
  const directory = join(dataDir, job.id);
  const input = join(directory, 'audio.bin'), pcm = join(directory, 'audio.f32');
  try {
    await mkdir(directory, { mode: 0o700 });
    const url = track.source === 'soundcloud' ? await resolveSoundcloud(track) : track.directUrl;
    validateMediaUrl(url, track.source);
    const transfer = await acquireAudio(url, track, input, { full: job.kind === 'download' });
    if (job.kind === 'download') {
      job.file = join(directory, 'track.mp3');
      const codec = (await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', input])).toString().trim();
      await run('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-i', input, '-vn', '-map_metadata', '-1',
        '-metadata', `title=${track.title}${track.version ? ` (${track.version})` : ''}`, '-metadata', `artist=${track.artist}`,
        '-codec:a', codec === 'mp3' ? 'copy' : 'libmp3lame', ...(codec === 'mp3' ? [] : ['-q:a', '2']), '-y', job.file], { timeout: 180000 });
      job.result = { download: `/files/${job.id}`, transfer };
    } else {
      const sample = async (transfer) => {
        await run('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe', '-ss', String(transfer.decodeStart || 0), '-i', input, '-t', '40', '-vn', '-ac', '1', '-ar', '44100', '-f', 'f32le', '-y', pcm]);
        return analyse(pcm);
      };
      const first = await sample(transfer);
      const fragments = [{ ...first, transfer }];
      const reference = catalogue.get(cacheKey(track));
      const disagrees = value => reference?.method === 'catalogue' &&
        (reference.key && reference.key !== value.key || reference.bpm && Math.abs(reference.bpm - value.bpm) > 3);
      if ((first.rhythmConfidence < 1.5 || first.keyStrength < 0.65 || disagrees(first)) && track.duration > 90) {
        const secondTransfer = await acquireAudio(url, track, input, { fraction: 0.6 });
        fragments.push({ ...await sample(secondTransfer), transfer: secondTransfer });
      }
      const second = fragments[1];
      const consistent = !second || Math.abs(first.bpm - second.bpm) < 2 && first.key === second.key;
      const best = fragments.reduce((a, b) => b.keyStrength + b.rhythmConfidence > a.keyStrength + a.rhythmConfidence ? b : a);
      job.result = { bpm: best.bpm || null, key: best.key, musicalKey: best.musicalKey, origin: 'Анализ фрагмента', method: 'analysis',
        approximate: true, uncertain: !consistent || best.rhythmConfidence < 1.5 || best.keyStrength < 0.65 || disagrees(best),
        reference: reference?.method === 'catalogue' ? reference : null, disagreement: Boolean(disagrees(best)),
        fragments, seconds: fragments.reduce((n, f) => n + f.seconds, 0), bytes: fragments.reduce((n, f) => n + f.transfer.bytes, 0),
        partialTransfer: fragments.every(f => f.transfer.partial) };
      catalogue.put(`analysis:${cacheKey(track)}`, job.result);
    }
    job.status = 'done';
  } catch (err) { job.status = 'error'; job.error = err.message; }
  finally {
    await rm(input, { force: true }); await rm(pcm, { force: true });
    inflight.delete(`${job.kind}:${cacheKey(track)}`);
  }
}
function enqueue(kind, track, force = false) {
  const key = `${kind}:${cacheKey(track)}`;
  if (inflight.has(key)) return jobs.get(inflight.get(key));
  const cached = kind === 'analysis' && !force && catalogue.getAnalysis(track);
  if (cached) {
    const job = { id: randomUUID(), kind, status: 'done', created: Date.now(), cached: true, result: cached };
    jobs.set(job.id, job); return job;
  }
  if ([...jobs.values()].filter(j => ['queued', 'running'].includes(j.status)).length >= 12) throw new Error('Очередь заполнена. Дождитесь завершения заданий');
  const job = { id: randomUUID(), kind, status: 'queued', created: Date.now() };
  jobs.set(job.id, job); inflight.set(key, job.id);
  queue = queue.catch(() => {}).then(() => processJob(job, track));
  return job;
}
const prune = setInterval(async () => {
  for (const [id, job] of jobs) if (!['running', 'queued'].includes(job.status) && Date.now() - job.created > 3600000) {
    jobs.delete(id); await rm(join(dataDir, id), { force: true, recursive: true });
  }
}, 60000);
prune.unref();
const publicJob = ({ file, ...job }) => job;
const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) { res.writeHead(403); res.end(); return; }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin'); res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }); res.end(); return;
  }
  if (req.url === '/health' && req.method === 'GET') return json({ ok: true, name: 'YaMusic Downloader PRO', version: '1.5.0' });
  const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
  const expected = Buffer.from(token);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json({ error: 'Неверный токен сервера' }, 401);
  try {
    if (req.method === 'GET' && /^\/jobs\/[a-f0-9-]{36}$/.test(req.url)) {
      const job = jobs.get(req.url.split('/')[2]); return job ? json(publicJob(job)) : json({ error: 'Задание не найдено' }, 404);
    }
    if (req.method === 'GET' && /^\/files\/[a-f0-9-]{36}$/.test(req.url)) {
      const job = jobs.get(req.url.split('/')[2]);
      if (!job?.file || job.status !== 'done') return json({ error: 'Файл не готов' }, 404);
      const info = await stat(job.file);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': info.size });
      const stream = createReadStream(job.file); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res); return;
    }
    if (req.method !== 'POST') return json({ error: 'Маршрут не найден' }, 404);
    let size = 0; const parts = [];
    for await (const part of req) { size += part.length; if (size > 32768) return json({ error: 'Запрос слишком большой' }, 413); parts.push(part); }
    const body = JSON.parse(Buffer.concat(parts).toString());
    if (req.url === '/cached') {
      if (!Array.isArray(body.urls) || body.urls.length > 100) throw new Error('Нужно не более 100 ссылок');
      return json({ metadata: catalogue.soundcloudCached([...new Set(body.urls.map(soundcloudUrl))]) });
    }
    if (req.url === '/track') {
      if (body.source !== 'soundcloud') throw new Error('Этот источник получает метаданные из вкладки');
      const url = soundcloudUrl(body.url), cacheId = `track:${url}`;
      const cached = catalogue.get(cacheId);
      if (cached) return json({ track: cached });
      const track = await getSoundcloudTrack(url);
      catalogue.rememberSoundcloud(track);
      catalogue.put(cacheId, track, 86400000);
      return json({ track });
    }
    if (req.url === '/lookup') {
      const track = validateTrack(body.track);
      return json({ metadata: body.analysisOnly === true ? catalogue.getAnalysis(track) : await catalogue.lookup(track) });
    }
    if (req.url === '/search') {
      const query = String(body.query || '').trim();
      if (!query || query.length > 300) throw new Error('Неверный поисковый запрос');
      if (searchRunning >= 2) throw new Error('Поиск занят. Повторите запрос позже');
      searchRunning++;
      try { return json({ tracks: await searchSoundcloud(query) }); } finally { searchRunning--; }
    }
    if (['/analyse', '/download'].includes(req.url)) {
      const track = validateTrack(body.track);
      if (track.source === 'soundcloud') { track.url = soundcloudUrl(track.url); catalogue.rememberSoundcloud(track); }
      return json(publicJob(enqueue(req.url === '/analyse' ? 'analysis' : 'download', track, body.force === true)), 202);
    }
    json({ error: 'Маршрут не найден' }, 404);
  } catch (err) { json({ error: err instanceof SyntaxError ? 'Неверный JSON' : err.message }, 400); }
});
server.requestTimeout = 120000;
server.listen(Number(process.env.PORT || 8789), '127.0.0.1', () => console.log('YaMusic Downloader PRO: http://127.0.0.1:' + (process.env.PORT || 8789)));
