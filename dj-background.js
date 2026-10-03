'use strict';
let queueMutation = Promise.resolve();
async function destination() {
  const data = await chrome.storage.local.get(['downloadDestination', 'subfolder']);
  return data.downloadDestination || { type: 'browser', name: 'Загрузки Chrome', subfolder: data.subfolder ?? '1_Music' };
}
async function openDownloads(focus = true) {
  const url = chrome.runtime.getURL('downloads.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs[0]) { if (focus) await chrome.tabs.update(tabs[0].id, { active: true }); return; }
  await chrome.tabs.create({ url, active: focus });
}
async function vkRequest(action, data) {
  const tabs = await chrome.tabs.query({ url: ['https://vk.ru/*', 'https://vk.com/*', 'https://m.vk.ru/*', 'https://m.vk.com/*'] });
  const tab = tabs.find(t => /audio|music/.test(t.url)) || tabs[0];
  if (!tab) throw new Error('Откройте музыку VK в отдельной вкладке и войдите в аккаунт');
  let result;
  try { result = await chrome.tabs.sendMessage(tab.id, { ...data, type: 'YM_DJ_VK', action }); }
  catch { throw new Error('Обновите вкладку VK после установки расширения'); }
  if (!result?.ok) throw new Error(result?.error || 'VK не ответил');
  return result;
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!['YM_DL_BUILD_AND_DOWNLOAD', 'YM_DJ_API', 'YM_DJ_VK_REQUEST', 'YM_DJ_VK_RELOAD', 'YM_DJ_OPEN_DOWNLOADS', 'YM_DJ_DESTINATION', 'YM_DJ_QUEUE', 'YM_DJ_UPDATE_JOB'].includes(msg?.type)) return;
  (async () => {
    if (msg.type === 'YM_DJ_DESTINATION') return destination();
    if (msg.type === 'YM_DJ_OPEN_DOWNLOADS') { await openDownloads(); return { ok: true }; }
    if (msg.type === 'YM_DJ_API') {
      if (!/^\/(cached|track|lookup|search|analyse|jobs\/[a-f0-9-]+)$/.test(msg.path)) throw new Error('Недопустимый маршрут');
      return { ok: true, ...await YM_DJ_API.request(msg.path, msg.body) };
    }
    if (msg.type === 'YM_DJ_VK_REQUEST') return vkRequest(msg.action, msg);
    if (msg.type === 'YM_DJ_VK_RELOAD') {
      // The mobile endpoint is cross-origin from the desktop VK tab. Extension host permissions allow this request.
      if (!/^https:\/\/(?:m\.)?vk\.(?:ru|com)\//.test(sender.url || '') || !/^-?\d+_\d+_[a-zA-Z0-9]+_[a-zA-Z0-9]+$/.test(msg.fullId || '')) throw new Error('Неверный запрос аудио VK');
      const response = await fetch('https://m.vk.ru/audio', { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        body: new URLSearchParams({ act: 'reload_audio', ids: msg.fullId }), signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`VK: HTTP ${response.status}`);
      const data = await response.json().catch(() => { throw new Error('VK запросил вход или изменил формат аудио'); });
      return { ok: true, data };
    }
    if (msg.type === 'YM_DJ_UPDATE_JOB') {
      if (sender.url !== chrome.runtime.getURL('downloads.html')) throw new Error('Изменять очередь может только центр загрузок');
      queueMutation = queueMutation.catch(() => {}).then(async () => {
        const { downloadJobs = [] } = await chrome.storage.local.get('downloadJobs');
        const job = downloadJobs.find(j => j.id === msg.id);
        if (job) Object.assign(job, msg.patch);
        await chrome.storage.local.set({ downloadJobs }); return { ok: true };
      });
      return queueMutation;
    }
    const target = msg.destination || await destination();
    if (target.type === 'directory' && !target.id) throw new Error('Выберите папку в центре загрузок');
    queueMutation = queueMutation.catch(() => {}).then(async () => {
      const { downloadJobs = [] } = await chrome.storage.local.get('downloadJobs');
      if (downloadJobs.filter(j => ['queued', 'running', 'waiting'].includes(j.status)).length >= 30) throw new Error('Очередь загрузок заполнена');
      const job = { id: crypto.randomUUID(), status: 'queued', created: Date.now(), destination: target,
        filename: msg.payload?.filename || msg.filename, payload: msg.payload || null, track: msg.track || null };
      const remaining = downloadJobs.filter(j => j.status !== 'done').concat(downloadJobs.filter(j => j.status === 'done').slice(-20));
      await chrome.storage.local.set({ downloadJobs: [...remaining, job] });
      await openDownloads(false); return { ok: true, id: job.id };
    });
    return queueMutation;
  })().then(sendResponse, err => sendResponse({ ok: false, error: err.message }));
  return true;
});
