(() => {
  'use strict';
  const presentation = globalThis.YM_DJ_PRESENTATION;
  const vkSource = globalThis.YM_DJ_VK_SOURCE;
  if (!presentation) return;
  const isSoundcloud = location.hostname === 'soundcloud.com';
  if (!isSoundcloud && !vkSource) return;
  const mounted = new WeakMap(), trackRequests = new Map();
  const reserved = new Set(['you', 'discover', 'search', 'tags', 'settings', 'stations', 'charts', 'pages', 'artists', 'upload', 'terms-of-use']);
  function soundcloudTrackUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== 'https:' || url.hostname !== 'soundcloud.com' || url.username || url.password || url.port) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'n') parts.shift();
      if (parts.length !== 2 || reserved.has(parts[0]) || parts[1] === 'sets' || parts[1] === 'tracks' || parts[1] === 'likes' || parts[1] === 'followers') return null;
      return `https://soundcloud.com/${parts.join('/')}`;
    } catch { return null; }
  }
  async function message(data) {
    const response = await chrome.runtime.sendMessage(data);
    if (!response?.ok) throw new Error(response?.error || 'Расширение не ответило. Обновите страницу.');
    return response;
  }
  const api = (path, body) => message({ type: 'YM_DJ_API', path, body });
  async function soundcloudTrack(url) {
    if (!trackRequests.has(url)) {
      const task = api('/track', { source: 'soundcloud', url }).then(result => result.track).catch(error => { trackRequests.delete(url); throw error; });
      if (trackRequests.size >= 100) trackRequests.delete(trackRequests.keys().next().value);
      trackRequests.set(url, task);
    }
    return trackRequests.get(url);
  }
  async function withAudio(track) {
    return track.source === 'vk' ? { ...track, directUrl: await vkSource.resolveTrack(track) } : track;
  }
  function filename(track) {
    return `${track.artist || 'Unknown Artist'} - ${track.title || 'Unknown Title'}${track.version ? ` (${track.version})` : ''}.mp3`.replace(/[\/\\?%*:|"<>]/g, '_');
  }
  async function download(getTrack) {
    // Snapshot the folder before metadata requests: changing it must not redirect this download.
    const destination = await chrome.runtime.sendMessage({ type: 'YM_DJ_DESTINATION' });
    if (destination?.ok === false) throw new Error(destination.error);
    const track = await withAudio(await getTrack());
    await message({ type: 'YM_DJ_QUEUE', destination, track, filename: filename(track) });
    return track;
  }
  async function analyse(getTrack, progress, force = false) {
    progress('Получаем трек…');
    const track = await getTrack();
    if (!force) {
      const cached = await api('/lookup', { track, analysisOnly: true });
      if (cached.metadata) return { ...cached.metadata, cached: true };
    }
    const job = await api('/analyse', { track: await withAudio(track), force });
    for (let attempt = 0; attempt < 300; attempt++) {
      const state = await api(`/jobs/${job.id}`);
      if (state.status === 'done') return { ...state.result, cached: Boolean(state.cached) };
      if (state.status === 'error') throw new Error(state.error);
      progress(state.status === 'queued' ? 'Анализ в очереди…' : 'Анализируем фрагмент…');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('Анализ ещё не завершён. Проверьте сервер.');
  }
  globalThis.YM_DJ_SOURCE_ACTIONS = { soundcloudTrackUrl, filename, download, analyse };

  function mount(target, identity, getTrack, dock = false) {
    const previous = mounted.get(target);
    if (previous?.identity === identity && previous.host.isConnected) return;
    previous?.host.remove();
    const host = document.createElement('span'); host.className = 'ym-source-controls';
    host.dataset.track = identity;
    Object.assign(host.style, { display: 'block', margin: '6px 0', position: 'relative', zIndex: '1' });
    if (dock) {
      host.id = 'ym-source-page-controls';
      Object.assign(host.style, { position: 'fixed', right: '18px', bottom: '88px', zIndex: '2147483645', margin: '0', maxWidth: 'calc(100vw - 36px)' });
    }
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = `
      :host{font:12px/1.4 system-ui;color:#18212f}*{box-sizing:border-box}.panel{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.dock{padding:12px;background:#20242c;color:#f5f5f5;border:1px solid #77808d;border-radius:12px;box-shadow:0 5px 20px #0005;max-width:420px}.caption{flex-basis:100%;font-weight:600;max-height:3em;overflow:hidden}.caption:empty{display:none}button{background:#eef2f6;color:#18212f;border:1px solid #8993a3;border-radius:6px;padding:5px 9px;font:600 12px system-ui;cursor:pointer}button:hover{background:#fff}button:focus-visible{outline:2px solid #3770dd;outline-offset:2px}button:disabled{opacity:.6;cursor:wait}.status{flex-basis:100%;padding:4px 7px;background:#eef2f6;color:#18212f;border-radius:5px;max-width:480px;overflow-wrap:anywhere}.status:empty,.values:empty{display:none}.values{white-space:nowrap}`;
    const panel = document.createElement('span'); panel.className = dock ? 'panel dock' : 'panel';
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'YaMusic Downloader PRO');
    const caption = document.createElement('span'); caption.className = 'caption';
    if (dock) caption.textContent = `Трек на странице: ${document.title.split(' | ')[0].replace(/^Stream /, '')}`;
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Скачать'; save.title = 'Скачать в общую папку YaMusic Downloader PRO';
    const scan = document.createElement('button'); scan.type = 'button'; scan.textContent = 'Анализировать';
    const values = document.createElement('span'); values.className = 'values';
    const status = document.createElement('span'); status.className = 'status'; status.setAttribute('role', 'status');
    let force = false;
    const busy = value => { save.disabled = value; scan.disabled = value; };
    save.onclick = async () => {
      busy(true); status.textContent = 'Готовим загрузку…';
      try {
        const track = await download(getTrack);
        status.textContent = `В очереди: ${track.artist} — ${track.title}`;
      } catch (error) { status.textContent = error.message; }
      finally { busy(false); }
    };
    scan.onclick = async () => {
      busy(true);
      try {
        const result = await analyse(getTrack, text => { status.textContent = text; }, force);
        presentation.render(values, result);
        status.textContent = `${result.cached ? 'Из кэша. ' : ''}${result.seconds || 40} с аудио. Приблизительный результат.${result.disagreement ? ` Каталог: ${presentation.label(result.reference)}. Результаты расходятся.` : ''}`;
        force = true; scan.textContent = 'Пересчитать';
      } catch (error) { status.textContent = error.message; }
      finally { busy(false); }
    };
    for (const type of ['click', 'dblclick', 'pointerdown', 'pointerup']) host.addEventListener(type, event => event.stopPropagation());
    panel.append(caption, save, scan, values, status); shadow.append(style, panel); target.append(host);
    mounted.set(target, { identity, host });
  }
  function soundcloudRow(link) {
    const known = link.closest('.soundList__item, .searchList__item, .trackList__item, .trackItem, article, li, [role="listitem"]');
    if (known) {
      const urls = new Set([...known.querySelectorAll('a[href]')].map(a => soundcloudTrackUrl(a.href)).filter(Boolean));
      return urls.size === 1 ? known : null;
    }
    // The new SoundCloud layout uses unnamed containers around each track's toolbar.
    let current = link.parentElement;
    for (let depth = 0; current && depth < 4; depth++, current = current.parentElement) {
      if (!current.querySelector('[role="toolbar"], button[aria-label="Play"], button[title="Play"]')) continue;
      const urls = new Set([...current.querySelectorAll('a[href]')].map(a => soundcloudTrackUrl(a.href)).filter(Boolean));
      if (urls.size === 1) return current;
      return null;
    }
    return null;
  }
  function injectSoundcloud() {
    const pageUrl = soundcloudTrackUrl(location.href);
    const topFrame = window.top === window;
    if (topFrame && pageUrl) {
      const heading = document.querySelector('[aria-label="Track header"] h1, h1.soundTitle__title, main h1');
      const target = heading?.parentElement || document.body;
      mount(target, pageUrl, () => {
        if (soundcloudTrackUrl(location.href) !== pageUrl) throw new Error('Страница обновилась. Нажмите кнопку ещё раз.');
        return soundcloudTrack(pageUrl);
      }, !heading);
      if (heading) document.getElementById('ym-source-page-controls')?.remove();
    } else if (topFrame) document.getElementById('ym-source-page-controls')?.remove();
    const visited = new Set();
    for (const link of document.querySelectorAll('a[href]')) {
      if (link.closest('header, footer, [role="contentinfo"], .playControls, .ym-source-controls')) continue;
      const url = soundcloudTrackUrl(link.href); if (!url || url === pageUrl && link.closest('[aria-label="Track header"]')) continue;
      const row = soundcloudRow(link);
      if (!row || visited.has(row) || row.matches('body, main')) continue;
      visited.add(row);
      mount(row, url, () => {
        if (!link.isConnected || !row.contains(link) || soundcloudTrackUrl(link.href) !== url) throw new Error('Список обновился. Нажмите кнопку у нужного трека ещё раз.');
        return soundcloudTrack(url);
      });
    }
  }
  function injectVK() {
    for (const row of document.querySelectorAll('[data-audio]')) {
      const track = vkSource.readElement(row); if (!track) continue;
      mount(row, track.id, () => {
        const current = vkSource.readElement(row);
        if (!current || current.id !== track.id) throw new Error('Список обновился. Нажмите кнопку у нужного трека ещё раз.');
        return Promise.resolve(current);
      });
    }
  }
  if (!document.body) return;
  let timer, lastUrl = location.href;
  const inject = () => isSoundcloud ? injectSoundcloud() : injectVK();
  const schedule = () => { clearTimeout(timer); timer = setTimeout(inject, 250); };
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'data-audio', 'data-full-id'] });
  window.addEventListener('popstate', schedule);
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; schedule(); } }, 1000);
  inject();
})();
