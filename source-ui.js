(() => {
  'use strict';
  const presentation = globalThis.YM_DJ_PRESENTATION;
  const vkSource = globalThis.YM_DJ_VK_SOURCE;
  if (!presentation) return;
  const isSoundcloud = location.hostname === 'soundcloud.com';
  if (!isSoundcloud && !vkSource) return;
  const mounted = new WeakMap(), trackRequests = new Map();
  const records = new Set(), cache = new Map(), waiting = new Set();
  let cacheTimer, cacheBusy = false;
  const reserved = new Set(['you', 'discover', 'search', 'tags', 'settings', 'stations', 'charts', 'pages', 'artists', 'upload', 'terms-of-use', 'feed', 'messages', 'notifications', 'premium', 'subscription', 'jobs', 'people', 'mobile', 'getstarted', 'company', 'press', 'community']);
  function soundcloudTrackUrl(value) {
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== 'https:' || url.hostname !== 'soundcloud.com' || url.username || url.password || url.port) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'n') parts.shift();
      if (parts.length !== 2 || reserved.has(parts[0]) || ['sets', 'tracks', 'likes', 'followers', 'following', 'reposts', 'albums', 'popular-tracks'].includes(parts[1])) return null;
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

  function showAnalysis(identity, result) {
    cache.set(identity, { at: Date.now(), value: result });
    for (const record of records) if (record.identity === identity && record.host.isConnected) record.apply(result);
  }
  function requestCached(record, force = false) {
    if (!isSoundcloud || !record.host.isConnected) return;
    const stored = cache.get(record.identity);
    if (!force && stored && Date.now() - stored.at < 30000) { record.apply(stored.value); return; }
    waiting.add(record.identity);
    clearTimeout(cacheTimer); cacheTimer = setTimeout(flushCache, 120);
  }
  async function flushCache() {
    if (cacheBusy || !waiting.size) return;
    cacheBusy = true;
    const urls = [...waiting].slice(0, 100); urls.forEach(url => waiting.delete(url));
    try {
      const result = await api('/cached', { urls });
      for (const url of urls) showAnalysis(url, result.metadata[url] || null);
    } catch { /* Manual actions show errors; a later visibility check retries cache reads. */ }
    finally { cacheBusy = false; if (waiting.size) cacheTimer = setTimeout(flushCache, 120); }
  }
  const visibility = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
    for (const entry of entries) {
      const record = [...records].find(r => r.host === entry.target);
      if (record) { record.visible = entry.isIntersecting; if (record.visible) requestCached(record); }
    }
  }) : null;
  function mount(target, identity, getTrack, dock = false, captionText = '', compact = false) {
    const previous = mounted.get(target);
    if (previous?.identity === identity && previous.host.isConnected) return;
    if (previous) { visibility?.unobserve(previous.host); records.delete(previous); previous.host.remove(); }
    const host = document.createElement('span'); host.className = 'ym-source-controls';
    host.dataset.track = identity;
    Object.assign(host.style, { display: 'block', margin: '6px 0', position: 'relative', zIndex: '1' });
    if (dock) {
      host.id = 'ym-source-player-controls';
      Object.assign(host.style, { position: 'fixed', right: '18px', bottom: '88px', zIndex: '2147483645', margin: '0', maxWidth: 'calc(100vw - 36px)' });
    }
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = `
      :host{font:12px/1.4 system-ui;color:#18212f}*{box-sizing:border-box}.panel{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.dock{padding:12px;background:#20242c;color:#f5f5f5;border:1px solid #77808d;border-radius:12px;box-shadow:0 5px 20px #0005;max-width:420px}.caption{flex-basis:100%;font-weight:600;max-height:3em;overflow:hidden}.caption:empty{display:none}button{background:#eef2f6;color:#18212f;border:1px solid #8993a3;border-radius:6px;padding:5px 9px;font:600 12px system-ui;cursor:pointer}button:hover{background:#fff}button:focus-visible{outline:2px solid #3770dd;outline-offset:2px}button:disabled{opacity:.6;cursor:wait}.status{flex-basis:100%;padding:4px 7px;background:#eef2f6;color:#18212f;border-radius:5px;max-width:480px;overflow-wrap:anywhere}.status:empty,.values:empty{display:none}.values{white-space:nowrap}`;
    const panel = document.createElement('span'); panel.className = dock ? 'panel dock' : 'panel';
    panel.setAttribute('role', 'group'); panel.setAttribute('aria-label', 'YaMusic Downloader PRO');
    const caption = document.createElement('span'); caption.className = 'caption';
    caption.textContent = captionText;
    if (compact) { host.style.margin = '0'; host.style.position = 'absolute'; host.style.right = '4px'; host.style.top = '0'; host.style.zIndex = '3'; }
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Скачать'; save.title = 'Скачать в общую папку YaMusic Downloader PRO';
    const scan = document.createElement('button'); scan.type = 'button'; scan.textContent = 'Анализировать';
    const values = document.createElement('span'); values.className = 'values';
    const status = document.createElement('span'); status.className = 'status'; status.setAttribute('role', 'status');
    let force = false;
    if (isSoundcloud) presentation.render(values, null);
    const apply = result => {
      if (result) {
        presentation.render(values, result); values.title = 'Сохранённый анализ фрагмента';
        force = true; scan.textContent = 'Пересчитать';
      }
    };
    const record = { identity, host, target, apply, visible: false, getTrack };

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
        showAnalysis(identity, result);
        if (isSoundcloud && chrome.storage?.local) chrome.storage.local.set({ ymAnalysisUpdated: { url: identity, at: Date.now() } }).catch(() => {});
        status.textContent = `${result.cached ? 'Из кэша. ' : ''}${result.seconds || 40} с аудио. Приблизительный результат.${result.disagreement ? ` Каталог: ${presentation.label(result.reference)}. Результаты расходятся.` : ''}`;
        force = true; scan.textContent = 'Пересчитать';
      } catch (error) { status.textContent = error.message; }
      finally { busy(false); }
    };
    for (const type of ['click', 'dblclick', 'pointerdown', 'pointerup']) host.addEventListener(type, event => event.stopPropagation());
    panel.append(caption, save, scan, values, status); shadow.append(style, panel); target.append(host);
    mounted.set(target, record); records.add(record);
    if (isSoundcloud) { if (visibility) visibility.observe(host); else requestCached(record); }
  }
  const urlsIn = node => new Set([...node.querySelectorAll('a[href]')].filter(a => !a.closest('.ym-source-controls')).map(a => soundcloudTrackUrl(a.href)).filter(Boolean));
  function soundcloudRow(link) {
    const outer = link.closest('.soundList__item, .searchList__item, .trackList__item, .systemPlaylistTrackList__item, .badgeList__item');
    if (outer && urlsIn(outer).size === 1) return outer;
    const known = link.closest('.queueItemView, .playableTile, .trackItem, article, li, [role="listitem"]');
    if (known && urlsIn(known).size === 1) return known;
    let current = link.parentElement, candidate = null;
    // Keep the smallest unambiguous track container, even when a new layout has no known classes.
    for (let depth = 0; current && depth < 6; depth++, current = current.parentElement) {
      if (current.matches('body, main, nav, header, footer, ul, ol, [role="list"]') || urlsIn(current).size !== 1) break;
      if (!current.closest('a, button')) {
        candidate ||= current;
        if (current.querySelector('[role="toolbar"], button, [role="button"]')) return current;
      }
    }
    return candidate;
  }
  function guardedTrack(link, row, url) {
    return () => {
      if (!link.isConnected || !row.contains(link) || soundcloudTrackUrl(link.href) !== url) throw new Error('Список обновился. Нажмите кнопку у нужного трека ещё раз.');
      return soundcloudTrack(url);
    };
  }
  let playerTarget;
  function injectSoundcloud() {
    const pageUrl = soundcloudTrackUrl(location.href);
    const heading = pageUrl && document.querySelector('[aria-label="Track header"] h1, h1.soundTitle__title, main h1');
    const activeTargets = new Set();
    if (heading) {
      const target = heading.closest('[aria-label="Track header"]') || heading.parentElement;
      activeTargets.add(target);
      mount(target, pageUrl, () => {
        if (soundcloudTrackUrl(location.href) !== pageUrl) throw new Error('Страница обновилась. Нажмите кнопку ещё раз.');
        return soundcloudTrack(pageUrl);
      });
    }
    const playerLink = document.querySelector('.playbackSoundBadge__titleLink');
    const playerUrl = playerLink && soundcloudTrackUrl(playerLink.href);
    if (playerUrl) {
      if (!playerTarget?.isConnected) {
        playerTarget = document.createElement('div'); playerTarget.className = 'ym-source-player'; document.body.append(playerTarget);
      }
      activeTargets.add(playerTarget);
      mount(playerTarget, playerUrl, guardedTrack(playerLink, document.body, playerUrl), true, `В плеере: ${playerLink.getAttribute('title') || playerLink.textContent.trim()}`);
    }
    for (const link of document.querySelectorAll('a[href]')) {
      if (link.closest('header, footer, nav, [role="banner"], .ym-source-controls, .ym-source-player, .playbackSoundBadge')) continue;
      if (link.closest('[role="contentinfo"], .playControls') && !link.closest('.queue')) continue;
      const url = soundcloudTrackUrl(link.href);
      if (!url || heading && url === pageUrl && link.closest('[aria-label="Track header"]')) continue;
      const row = soundcloudRow(link);
      if (!row || activeTargets.has(row) || row.matches('body, main')) continue;
      activeTargets.add(row);
      const compact = Boolean(row.closest('.queue'));
      mount(row, url, guardedTrack(link, row, url), false, '', compact);
    }
    for (const record of records) if (!record.host.isConnected || !activeTargets.has(record.target)) {
      visibility?.unobserve(record.host); record.host.remove(); records.delete(record); mounted.delete(record.target);
    }
  }
  function injectVK() {
    const activeTargets = new Set();
    for (const row of document.querySelectorAll('[data-audio]')) {
      const track = vkSource.readElement(row); if (!track) continue;
      activeTargets.add(row);
      mount(row, track.id, () => {
        const current = vkSource.readElement(row);
        if (!current || current.id !== track.id) throw new Error('Список обновился. Нажмите кнопку у нужного трека ещё раз.');
        return Promise.resolve(current);
      });
    }
    for (const record of records) if (!record.host.isConnected || !activeTargets.has(record.target)) {
      record.host.remove(); records.delete(record); mounted.delete(record.target);
    }
  }
  Object.assign(globalThis.YM_DJ_SOURCE_ACTIONS, { soundcloudRow, injectSoundcloud });
  if (!document.body) return;
  let timer, lastUrl = location.href;
  const inject = () => isSoundcloud ? injectSoundcloud() : injectVK();
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; inject(); }, 250); };
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'data-audio', 'data-full-id'] });
  window.addEventListener('popstate', schedule);
  setInterval(() => { if (location.href !== lastUrl) { lastUrl = location.href; schedule(); } }, 1000);
  if (isSoundcloud) {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== 'local' || !changes.ymAnalysisUpdated) return;
      const url = changes.ymAnalysisUpdated.newValue?.url; cache.delete(url);
      for (const record of records) if (record.identity === url) requestCached(record, true);
    });
    setInterval(() => {
      for (const record of records) {
        if (!record.host.isConnected) { visibility?.unobserve(record.host); records.delete(record); }
        else if (record.visible) requestCached(record);
      }
      if (cache.size > 1000) for (const key of [...cache.keys()].slice(0, cache.size - 1000)) cache.delete(key);
    }, 30000);
  }
  inject();
})();
