'use strict';
globalThis.YM_DJ_API = {
  async config() {
    const saved = await chrome.storage.local.get(['serverUrl', 'serviceToken']);
    const config = { ...globalThis.YM_DJ_CONFIG, ...saved };
    const url = new URL(config.serverUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Укажите HTTPS-сервер или локальный адрес');
    return { url: url.origin, token: config.serviceToken };
  },
  async request(path, body, binary = false) {
    const config = await this.config();
    if (!/^\/(cached|track|lookup|search|analyse|download|health|jobs\/[a-f0-9-]+|files\/[a-f0-9-]+)$/.test(path)) throw new Error('Недопустимый маршрут');
    let response;
    try {
      response = await fetch(config.url + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    } catch { throw new Error('Сервер недоступен. Запустите pnpm start или проверьте настройки'); }
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    return binary ? response.blob() : response.json();
  },
  async waitJob(id, progress = () => {}) {
    for (let i = 0; i < 300; i++) {
      const job = await this.request(`/jobs/${id}`); progress(job.status);
      if (job.status === 'done') return job.result;
      if (job.status === 'error') throw new Error(job.error);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('Задание ещё не завершилось. Проверьте сервер');
  }
};
