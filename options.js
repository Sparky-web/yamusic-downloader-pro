'use strict';
const $ = id => document.getElementById(id);
chrome.storage.local.get(['serverUrl', 'serviceToken', 'subfolder']).then(data => {
  $('server-url').value = data.serverUrl || YM_DJ_CONFIG.serverUrl;
  $('service-token').value = data.serviceToken || YM_DJ_CONFIG.serviceToken;
  $('subfolder').value = data.subfolder ?? '1_Music';
});
$('downloads').onclick = () => chrome.runtime.sendMessage({ type: 'YM_DJ_OPEN_DOWNLOADS' });
$('save').onclick = async () => {
  try {
    const url = new URL($('server-url').value.trim());
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Укажите HTTPS-сервер или localhost');
    if ($('service-token').value.trim().length < 32) throw new Error('Укажите токен сервера из .env.local');
    if (!await chrome.permissions.request({ origins: [`${url.origin}/*`] })) throw new Error('Доступ к серверу не разрешён');
    const subfolder = $('subfolder').value.trim();
    const { downloadDestination } = await chrome.storage.local.get('downloadDestination');
    await chrome.storage.local.set({ serverUrl: url.origin, serviceToken: $('service-token').value.trim(), subfolder,
      ...(downloadDestination?.type === 'browser' ? { downloadDestination: { ...downloadDestination, subfolder } } : {}) });
    $('status').textContent = 'Настройки сохранены';
  } catch (err) { $('status').textContent = err.message; }
};
$('check').onclick = async () => {
  try { await YM_DJ_API.request('/lookup', { track: { source: 'vk', id: 'health', title: 'health' } }); $('status').textContent = 'Сервер доступен. Токен принят.'; }
  catch (err) { $('status').textContent = err.message; }
};
