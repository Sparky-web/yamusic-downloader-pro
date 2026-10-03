(() => {
  'use strict';
  const core = globalThis.YM_DJ_CORE;
  if (!core) return;
  const presentation = globalThis.YM_DJ_PRESENTATION;
  if (!presentation) return;
  const memory = new Map(), pending = new Map();
  const names = { yandex: 'Яндекс Музыка', soundcloud: 'SoundCloud', vk: 'VK Музыка' };
  const api = async (path, body) => {
    const result = await chrome.runtime.sendMessage({ type: 'YM_DJ_API', path, body });
    if (!result?.ok) throw new Error(result?.error || 'Сервер не ответил');
    return result;
  };
  const vk = async (action, data) => {
    const result = await chrome.runtime.sendMessage({ type: 'YM_DJ_VK_REQUEST', action, ...data });
    if (!result?.ok) throw new Error(result?.error || 'VK не ответил');
    return result;
  };
  const key = track => `${track.source}:${track.id}`;
  function yandexTrack(meta) {
    return { source: 'yandex', id: String(meta.id), title: meta.title, version: meta.version || '',
      artists: (meta.artists || []).map(a => a.name), artist: (meta.artists || []).map(a => a.name).join(', '),
      duration: Number(meta.durationMs || 0) / 1000, album: meta.albums?.[0]?.title || '', url: `https://music.yandex.ru/track/${meta.id}` };
  }
  const title = track => `${track.title}${track.version ? ` (${track.version})` : ''}`;
  const fileName = track => `${track.artist || 'Unknown Artist'} - ${title(track) || 'Unknown Title'}.mp3`.replace(/[\/\\?%*:|"<>]/g, '_');
  const label = presentation.label;
  const renderMetadata = (node, data) => { presentation.render(node, data); node.title = explanation(data); };
  const metadataStatus = (node, text) => { node.textContent = text; node.removeAttribute('aria-label'); };
  function explanation(metadata) {
    if (!metadata) return 'Можно проанализировать аудио по кнопке.';
    if (metadata.method === 'analysis') return `${metadata.cached ? 'Сохранённый анализ. ' : ''}${metadata.origin}: ${metadata.seconds} с, ${(metadata.bytes / 1048576).toFixed(1)} МБ. ${metadata.partialTransfer ? 'Загружены фрагменты.' : 'Источник потребовал полный файл.'} Результат приблизительный. BPM может отличаться вдвое.${metadata.disagreement ? ` Каталог показывает ${label(metadata.reference)}. Результаты расходятся.` : ''}`;
    return `${metadata.origin}. Совпали название, исполнитель и версия.${metadata.bpmRange ? ' Разные издания отличаются на 1 BPM.' : ''} Каталог может содержать неточности.`;
  }
  async function lookup(track) {
    if (track.source === 'vk') return null;
    if (track.metadata) return track.metadata;
    const id = key(track);
    if (memory.has(id)) return memory.get(id);
    if (pending.has(id)) return pending.get(id);
    const promise = api('/lookup', { track }).then(result => { memory.set(id, result.metadata); return result.metadata; }).finally(() => pending.delete(id));
    pending.set(id, promise); return promise;
  }
  async function resolveTrack(track) {
    if (track.source === 'yandex') return { ...track, directUrl: (await core.resolveAudio(track.id)).directUrl };
    if (track.source === 'vk') return { ...track, directUrl: (await vk('resolve', { track })).directUrl };
    return track;
  }
  async function analyse(track, update, force = false) {
    const remember = result => {
      const preferred = result.reference || result;
      memory.set(key(track), preferred);
      if (track.source === 'yandex') refreshBadges(track.id, preferred);
      return result;
    };
    if (!force) {
      update('Проверяем сохранённый анализ…');
      const cached = await api('/lookup', { track, analysisOnly: true });
      if (cached.metadata) return remember({ ...cached.metadata, cached: true });
    }
    update('Получаем аудио…');
    const job = await api('/analyse', { track: await resolveTrack(track), force });
    for (let i = 0; i < 300; i++) {
      const state = await api(`/jobs/${job.id}`);
      if (state.status === 'done') {
        return remember({ ...state.result, cached: Boolean(state.cached) });
      }
      if (state.status === 'error') throw new Error(state.error);
      update(state.status === 'queued' ? 'Анализ в очереди…' : 'Анализируем фрагмент…');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('Анализ ещё не завершён. Проверьте сервер.');
  }
  async function download(track) {
    const destination = await chrome.runtime.sendMessage({ type: 'YM_DJ_DESTINATION' });
    let result;
    if (track.source === 'yandex') result = await chrome.runtime.sendMessage({ type: 'YM_DL_BUILD_AND_DOWNLOAD', payload: await core.resolveAudio(track.id), destination });
    else result = await chrome.runtime.sendMessage({ type: 'YM_DJ_QUEUE', track: await resolveTrack(track), filename: fileName(track), destination });
    if (!result?.ok) throw new Error(result?.error || 'Не удалось добавить загрузку');
  }
  let host, shadow, returnFocus;
  const cardLookups = new WeakMap();
  const cardObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { cardObserver.unobserve(entry.target); cardLookups.get(entry.target)?.(); }
  });
  function element(tag, text, className) {
    const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
  }
  function button(text, action) {
    const node = element('button', text); node.type = 'button'; node.addEventListener('click', action); return node;
  }
  function close() { cardObserver.disconnect(); presentation.onKeyDown = null; host?.remove(); host = null; returnFocus?.focus(); }
  function refreshBadges(id, metadata) {
    for (const badge of document.querySelectorAll('.ym-dj-badge')) if (badge.dataset.id === String(id)) renderMetadata(badge, metadata);
  }
  function trackCard(track, immediate = false) {
    const card = element('article', '', 'card'), details = element('div', '', 'details');
    const link = element('a', title(track), 'title'); link.href = track.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    details.append(link, element('div', track.artist, 'artist'));
    const metadata = element('div', track.source === 'vk' ? 'Анализ по кнопке' : 'Загрузка…', 'metadata');
    const hint = element('div', '', 'hint'), actions = element('div', '', 'actions');
    let forceAnalysis = false;
    const applyMetadata = data => {
      renderMetadata(metadata, data); hint.textContent = explanation(data);
      if (data?.method === 'analysis') { forceAnalysis = true; analyseButton.textContent = 'Пересчитать'; }
    };
    const analyseButton = button('Анализировать', async () => {
      analyseButton.disabled = true;
      try { applyMetadata(await analyse(track, value => { metadataStatus(metadata, value); }, forceAnalysis)); }
      catch (err) { metadataStatus(metadata, err.message); }
      finally { analyseButton.disabled = false; }
    });
    const downloadButton = button('Скачать', async () => {
      downloadButton.disabled = true;
      try { await download(track); hint.textContent = 'Добавлено в общий центр загрузок'; }
      catch (err) { hint.textContent = err.message; }
      finally { downloadButton.disabled = false; }
    });
    actions.append(analyseButton, downloadButton); details.append(metadata, hint); card.append(details, actions);
    if (track.source !== 'vk') {
      cardLookups.set(card, () => lookup(track).then(applyMetadata).catch(err => { metadataStatus(metadata, 'Сервер недоступен'); hint.textContent = err.message; }));
      if (immediate) cardLookups.get(card)(); else cardObserver.observe(card);
    }
    return card;
  }
  async function searchYandex(query) {
    const response = await fetch(`https://api.music.yandex.ru/search?type=track&page=0&text=${encodeURIComponent(query)}`, { credentials: 'include', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Яндекс Музыка: HTTP ${response.status}`);
    const data = await response.json();
    if (data.error) throw new Error('Яндекс Музыка не разрешила поиск. Проверьте вход.');
    return (data.result?.tracks?.results || []).slice(0, 30).map(yandexTrack);
  }
  async function openVersions(id) {
    if (!id || id === 'vibe-active') throw new Error('Не удалось определить трек. Откройте его страницу.');
    const original = yandexTrack(await core.fetchMeta(id));
    if (host) close(); returnFocus = document.activeElement;
    host = element('div'); host.id = 'ym-dj-modal';
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '2147483646' });
    shadow = host.attachShadow({ mode: 'open' });
    const style = element('style'); style.textContent = `
      :host{font:14px/1.45 system-ui;color:#f5f5f5;color-scheme:dark}.backdrop{position:absolute;inset:0;background:#000b;display:flex;align-items:center;justify-content:center;padding:24px}*{box-sizing:border-box}.dialog{background:#17171c;border:1px solid #42424b;border-radius:18px;max-width:940px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 100px #0009}header{padding:22px 24px 14px;display:flex;justify-content:space-between;align-items:center}h2{margin:0;font-size:22px}h3{font-size:15px;margin:22px 0 9px;color:#fcce42}.body{padding:0 24px 24px;overflow:auto}button,input,select{font:inherit;border:1px solid #474753;border-radius:8px;background:#2a2a33;color:inherit;padding:8px 11px}button{cursor:pointer}button:hover{border-color:#fcce42}button:disabled{opacity:.45;cursor:wait}button.primary{background:#fcce42;color:#131313;border-color:transparent}.search{display:flex;gap:8px;margin:20px 0 8px}.search input{min-width:100px;flex:1}.card{padding:14px;background:#222228;border:1px solid #33333d;border-radius:11px;display:flex;gap:12px;margin:8px 0}.details{flex:1;min-width:0}.title{color:#fff;text-decoration:none;font-weight:600;overflow-wrap:anywhere}.title:hover{text-decoration:underline}.artist{color:#a9a9b5;margin:3px 0 7px}.metadata{color:#c6ced8;font-size:13px}.hint,.note{color:#9999a6;font-size:12px;margin-top:5px;overflow-wrap:anywhere}.actions{display:flex;align-items:center;gap:8px}.actions button{font-size:12px}.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:12px 0}.error{color:#ffa2a2;font-size:13px}footer{border-top:1px solid #33333b;padding:12px 24px;color:#9999a6;font-size:12px}footer a{color:#fcce42}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #fcce42;outline-offset:3px}@media(max-width:620px){.backdrop{padding:8px}.card{flex-direction:column}.search{flex-wrap:wrap}.dialog{max-height:96vh}.body{padding:0 14px 16px}header{padding:16px}.search input{flex-basis:100%}}`;
    const backdrop = element('div', '', 'backdrop'), dialog = element('section', '', 'dialog');
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Версии трека');
    const header = element('header'); header.append(element('h2', 'Версии трека'), button('Закрыть', close));
    const body = element('div', '', 'body'); body.append(trackCard(original, true));
    const form = element('form', '', 'search'), input = element('input'); input.value = `${original.artists?.[0] || original.artist} ${original.title}`; input.setAttribute('aria-label', 'Название и исполнитель');
    const kind = element('select'); kind.setAttribute('aria-label', 'Тип версии');
    for (const [value, text] of [['', 'Все версии'], ['remix', 'Remix'], ['edit', 'Edit'], ['bootleg', 'Bootleg'], ['mashup', 'Mashup']]) { const option = element('option', text); option.value = value; kind.append(option); }
    const submit = element('button', 'Найти', 'primary'); submit.type = 'submit'; form.append(input, kind, submit);
    const toolbar = element('div', '', 'toolbar'); toolbar.append(button('Папка загрузок', () => chrome.runtime.sendMessage({ type: 'YM_DJ_OPEN_DOWNLOADS' })), element('span', 'До 30 результатов каждого источника. Уточняйте запрос.', 'note'));
    const filterLabel = element('label', '', 'note'), filter = element('input'); filter.type = 'checkbox'; filter.checked = true; filter.style.width = 'auto';
    filterLabel.append(filter, document.createTextNode(' Скрыть другие песни')); toolbar.append(filterLabel);
    const sourceControls = element('div', '', 'toolbar'), selectedSources = new Set(['yandex', 'soundcloud']);
    for (const source of Object.keys(names)) {
      const label = element('label', '', 'note'), toggle = element('input'); toggle.type = 'checkbox'; toggle.checked = selectedSources.has(source);
      toggle.addEventListener('change', () => toggle.checked ? selectedSources.add(source) : selectedSources.delete(source));
      label.append(toggle, document.createTextNode(` ${names[source]}${source === 'vk' ? ' — нужна открытая вкладка' : ''}`)); sourceControls.append(label);
    }
    const results = element('div'); body.append(form, sourceControls, toolbar, results);
    const footer = element('footer', 'Каталог BPM и тональностей: '), credit = element('a', 'GetSongBPM'); credit.href = 'https://getsongbpm.com/'; credit.target = '_blank'; credit.rel = 'noopener'; footer.append(credit);
    dialog.append(header, body, footer); backdrop.append(dialog); shadow.append(style, backdrop); document.documentElement.append(host);
    backdrop.addEventListener('click', event => { if (event.target === backdrop) close(); });
    presentation.onKeyDown = event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const focusable = [...dialog.querySelectorAll('button:not(:disabled),input,select,a[href]')];
        const first = focusable[0], last = focusable.at(-1), current = shadow.activeElement;
        if (event.shiftKey && current === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && current === last) { event.preventDefault(); first.focus(); }
      }
    };
    let searchId = 0;
    form.onsubmit = async event => {
      event?.preventDefault(); const generation = ++searchId;
      const query = `${input.value.trim()} ${kind.value}`.trim();
      if (!query) return; cardObserver.disconnect(); results.replaceChildren(); submit.disabled = true;
      if (!selectedSources.size) { results.append(element('p', 'Выберите хотя бы один источник.', 'error')); submit.disabled = false; return; }
      const tasks = [...selectedSources].map(async source => {
        const section = element('section'), list = element('div', 'Ищем…', 'note'); section.append(element('h3', names[source]), list); results.append(section);
        try {
          const tracks = source === 'yandex' ? await searchYandex(query) : source === 'vk' ? (await vk('search', { query })).tracks : (await api('/search', { query })).tracks;
          if (generation !== searchId) return;
          list.className = ''; list.replaceChildren();
          const normalized = value => String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
          const terms = normalized(original.title).split(' ').filter(word => word.length > 2);
          const selected = filter.checked && terms.length ? tracks.filter(track => terms.every(word => normalized(track.title).includes(word))) : tracks;
          if (!selected.length) list.append(element('p', 'Ничего не найдено. Измените запрос или отключите фильтр других песен.', 'note'));
          for (const track of selected) list.append(trackCard(track));
        } catch (err) { if (generation === searchId) { list.className = 'error'; list.textContent = err.message; } }
      });
      await Promise.allSettled(tasks); if (generation === searchId) submit.disabled = false;
    };
    input.focus(); form.requestSubmit();
  }
  const badgeQueue = []; let active = 0;
  async function drain() {
    if (active >= 2 || !badgeQueue.length) return;
    const { badge, id } = badgeQueue.shift(); active++;
    try {
      const track = yandexTrack(await core.fetchMeta(id)), metadata = await lookup(track);
      if (badge.isConnected && badge.dataset.id === id) renderMetadata(badge, metadata);
    } catch (err) { if (badge.dataset.id === id) { metadataStatus(badge, '—'); badge.title = err.message; } }
    finally { active--; drain(); }
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); badgeQueue.push({ badge: entry.target, id: entry.target.dataset.id }); }
    drain(); drain();
  }, { rootMargin: '100px' });
  function inject() {
    const selectors = YM_DL_BUTTON_CONFIG.selectors;
    for (const row of document.querySelectorAll(selectors.trackRoots.join(','))) {
      const id = core.extractTrackId(row); if (!id) continue;
      let tools = row.querySelector('.ym-dj-tools');
      if (tools && tools.dataset.id !== id) { observer.unobserve(tools.querySelector('.ym-dj-badge')); tools.remove(); tools = null; }
      if (tools) continue;
      const link = row.querySelector(selectors.trackLink);
      const target = link?.closest('[class*="Meta_titleContainer"]') || link?.parentElement;
      if (!target || target.closest('a,button')) continue;
      tools = element('span', '', 'ym-dj-tools'); tools.dataset.id = id;
      Object.assign(tools.style, { display: 'inline-flex', gap: '7px', alignItems: 'center', marginLeft: '8px', verticalAlign: 'middle' });
      const badge = button('…', event => { event.preventDefault(); event.stopPropagation(); openVersions(core.extractTrackId(row)).catch(err => alert(err.message)); });
      badge.className = 'ym-dj-badge'; badge.dataset.id = id;
      const versions = button('Версии', event => { event.preventDefault(); event.stopPropagation(); openVersions(core.extractTrackId(row)).catch(err => alert(err.message)); });
      for (const control of [badge, versions]) Object.assign(control.style, { color: '#18212f', background: '#eef2f6', font: '12px system-ui', border: '1px solid #8993a3', borderRadius: '6px', padding: '3px 6px', cursor: 'pointer', whiteSpace: 'nowrap' });
      badge.style.padding = '2px';
      tools.append(badge, versions); target.append(tools); observer.observe(badge);
    }
  }
  let timeout;
  new MutationObserver(() => { clearTimeout(timeout); timeout = setTimeout(inject, 250); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'data-track-id'] });
  inject();
  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg?.action !== 'OPEN_VERSIONS') return;
    (async () => { await openVersions(msg.trackId || await core.currentId()); return { ok: true }; })().then(respond, err => respond({ ok: false, error: err.message })); return true;
  });
})();
