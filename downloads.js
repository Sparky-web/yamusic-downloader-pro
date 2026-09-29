'use strict';
const $ = id => document.getElementById(id);
const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open('ym-downloads', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('directories');
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function directory(id, value) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('directories', value ? 'readwrite' : 'readonly');
    const store = tx.objectStore('directories'), req = value ? store.put(value, id) : store.get(id);
    tx.oncomplete = () => resolve(req.result); tx.onerror = () => reject(tx.error);
  });
}
const status = message => { $('status').textContent = message; };
async function update(id, patch) {
  const response = await chrome.runtime.sendMessage({ type: 'YM_DJ_UPDATE_JOB', id, patch });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось обновить очередь');
}
$('choose').onclick = async () => {
  try {
    const handle = await showDirectoryPicker({ mode: 'readwrite' });
    const id = crypto.randomUUID(); await directory(id, handle);
    await chrome.storage.local.set({ downloadDestination: { type: 'directory', id, name: handle.name } });
    status('Папка выбрана. Новые задания будут сохранены в неё.');
  } catch (err) { if (err.name !== 'AbortError') status(err.message); }
};
$('browser').onclick = async () => {
  const { subfolder = '1_Music' } = await chrome.storage.local.get('subfolder');
  await chrome.storage.local.set({ downloadDestination: { type: 'browser', name: 'Загрузки Chrome', subfolder } });
  status('Новые задания используют папку загрузок Chrome.');
};
$('authorize').onclick = async () => {
  try {
    const { downloadDestination } = await chrome.storage.local.get('downloadDestination');
    if (downloadDestination?.type !== 'directory') return status('Сначала выберите папку.');
    const handle = await directory(downloadDestination.id);
    if (!handle) throw new Error('Папка не найдена. Выберите её повторно.');
    if (await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Доступ к папке не предоставлен');
    status('Доступ разрешён. Нажмите «Повторить» у нужного задания.');
  } catch (err) { status(err.message); }
};
function safeFilename(name) {
  let stem = String(name || 'Unknown Artist - Unknown Title.mp3').replace(/[\x00-\x1f/\\?%*:|"<>]/g, '_').replace(/^\.+/, '_').replace(/\.mp3$/i, '');
  // Leave room for the extension and collision suffix on filesystems with a 255-byte name limit.
  const encoder = new TextEncoder();
  while (encoder.encode(stem).length > 220) stem = [...stem].slice(0, -1).join('');
  return `${stem}.mp3`;
}
async function uniqueFile(handle, filename) {
  const stem = filename.replace(/\.mp3$/i, '');
  for (let i = 0; i < 10000; i++) {
    const name = i ? `${stem} (${i}).mp3` : filename;
    try { await handle.getFileHandle(name); }
    catch (err) { if (err.name === 'NotFoundError') return handle.getFileHandle(name, { create: true }); throw err; }
  }
  throw new Error('Слишком много файлов с одинаковым именем');
}
async function getAudio(job) {
  if (job.payload) {
    const { directUrl, coverUrl, tags } = job.payload;
    const response = await fetch(directUrl, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Яндекс Музыка: HTTP ${response.status}. Повторно нажмите скачать у трека.`);
    const audio = await response.arrayBuffer();
    let cover = null;
    if (coverUrl) try { const res = await fetch(coverUrl, { signal: AbortSignal.timeout(10000) }); if (res.ok) cover = await res.arrayBuffer(); } catch {}
    return new Blob([buildID3v2Tag(tags, cover), audio], { type: 'audio/mpeg' });
  }
  const jobInfo = await YM_DJ_API.request('/download', { track: job.track });
  const result = await YM_DJ_API.waitJob(jobInfo.id);
  return YM_DJ_API.request(result.download, undefined, true);
}
async function saveBrowser(blob, name, target) {
  const url = URL.createObjectURL(blob);
  try {
    const sub = String(target.subfolder || '').split(/[\\/]/).filter(Boolean).map(s => s.replace(/\.\.|[<>:"|?*\x00-\x1f]/g, '_')).join('/');
    const id = await chrome.downloads.download({ url, filename: sub ? `${sub}/${name}` : name, conflictAction: 'uniquify', saveAs: false });
    await new Promise((resolve, reject) => {
      const listener = change => {
        if (change.id !== id || !['complete', 'interrupted'].includes(change.state?.current)) return;
        chrome.downloads.onChanged.removeListener(listener);
        change.state.current === 'complete' ? resolve() : reject(new Error('Chrome прервал загрузку'));
      };
      chrome.downloads.onChanged.addListener(listener);
      chrome.downloads.search({ id }).then(items => {
        if (['complete', 'interrupted'].includes(items[0]?.state)) listener({ id, state: { current: items[0].state } });
      });
    });
  } finally { URL.revokeObjectURL(url); }
}
let running = false, hasLock = false;
async function pump() {
  if (running || !hasLock) return;
  running = true;
  try {
    for (;;) {
      const { downloadJobs = [] } = await chrome.storage.local.get('downloadJobs');
      const job = downloadJobs.find(j => j.status === 'queued');
      if (!job) break;
      try {
        let handle;
        if (job.destination.type === 'directory') {
          handle = await directory(job.destination.id);
          if (!handle || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
            await update(job.id, { status: 'waiting', error: 'Разрешите доступ к папке этого задания через «Повторить».' }); continue;
          }
        }
        await update(job.id, { status: 'running', error: null });
        const blob = await getAudio(job), name = safeFilename(job.filename);
        if (handle) {
          const file = await uniqueFile(handle, name), writer = await file.createWritable();
          try { await writer.write(blob); await writer.close(); } catch (err) { await writer.abort().catch(() => {}); throw err; }
        } else await saveBrowser(blob, name, job.destination);
        await update(job.id, { status: 'done', payload: null, track: null });
      } catch (err) { await update(job.id, { status: 'error', error: err.message }); }
    }
  } finally { running = false; }
}
const labels = { queued: 'В очереди', running: 'Загружаем…', done: 'Сохранено', error: 'Ошибка', waiting: 'Нужен доступ к папке' };
async function render() {
  const { downloadJobs = [], downloadDestination, subfolder = '1_Music' } = await chrome.storage.local.get(['downloadJobs', 'downloadDestination', 'subfolder']);
  $('destination').textContent = downloadDestination?.name || `Загрузки Chrome / ${subfolder}`;
  $('jobs').replaceChildren();
  if (!downloadJobs.length) $('jobs').textContent = 'Пока нет загрузок. Нажмите «Скачать» рядом с треком.';
  for (const job of [...downloadJobs].reverse()) {
    const row = document.createElement('div'); row.className = 'job';
    const info = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('p');
    title.textContent = job.filename; detail.textContent = `${labels[job.status]} · ${job.destination.name}${job.error ? ` · ${job.error}` : ''}`;
    info.append(title, detail); row.append(info);
    if (['error', 'waiting'].includes(job.status)) {
      const retry = document.createElement('button'); retry.textContent = 'Повторить';
      retry.onclick = async () => {
        try {
          if (job.destination.type === 'directory') {
            const handle = await directory(job.destination.id);
            if (!handle || await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Нет доступа к исходной папке задания');
          }
          await update(job.id, { status: 'queued', error: null }); pump();
        } catch (err) { status(err.message); }
      }; row.append(retry);
    }
    $('jobs').append(row);
  }
}
chrome.storage.onChanged.addListener(() => { render(); pump(); });
navigator.locks.request('ym-download-writer', { ifAvailable: true }, async lock => {
  if (!lock) { status('Очередь уже работает в другой вкладке. Закройте эту копию.'); return; }
  hasLock = true;
  const { downloadJobs = [] } = await chrome.storage.local.get('downloadJobs');
  for (const job of downloadJobs.filter(j => j.status === 'running')) await update(job.id, { status: 'error', error: 'Вкладка была закрыта. Проверьте папку перед повторной загрузкой.' });
  await render(); pump();
  await new Promise(() => {});
});
