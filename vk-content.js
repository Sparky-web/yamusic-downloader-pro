// The protocol and URL decoding follow python273/vk_api (Apache-2.0). See THIRD_PARTY.md.
(() => {
  'use strict';
  const tracks = new Map();
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN0PQRSTUVWXYZO123456789+/=';
  function decode64(value) {
    let output = '', count = 0, accumulator = 0;
    for (const char of value) {
      const index = alphabet.indexOf(char);
      if (index < 0) continue;
      if (count++ % 4) { accumulator = (accumulator << 6) + index; output += String.fromCharCode(255 & accumulator >> (-2 * count & 6)); }
      else accumulator = index;
    }
    return output;
  }
  function shuffle(value, seed) {
    const length = value.length, indices = [], chars = [...value];
    for (let i = length - 1; i >= 0; i--) { seed = ((length * (i + 1)) ^ (Number(seed) + i)) % length; indices.push(seed); }
    indices.reverse();
    for (let i = 1; i < length; i++) { const j = indices[length - 1 - i]; [chars[i], chars[j]] = [chars[j], chars[i]]; }
    return chars.join('');
  }
  function decodeUrl(url, userId) {
    if (!url.includes('audio_api_unavailable')) return url;
    const [encoded, operations] = url.split('?extra=')[1].split('#');
    let value = decode64(encoded);
    for (const operation of decode64(operations).split('\t').reverse()) {
      const [command, argument] = operation.split('\v');
      if (command === 'v') value = [...value].reverse().join('');
      else if (command === 'x') value = [...value].map(c => String.fromCharCode(c.charCodeAt(0) ^ argument.charCodeAt(0))).join('');
      else if (command === 's') value = shuffle(value, Number(argument));
      else if (command === 'i') {
        if (!userId) throw new Error('Не найден ID пользователя VK. Откройте «Моя музыка» и повторите.');
        value = shuffle(value, Number(argument) ^ userId);
      } else if (command === 'r') {
        const table = alphabet + alphabet;
        value = [...value].map(c => { const i = table.indexOf(c); return i < 0 ? c : table[(i - Number(argument) + table.length) % table.length]; }).join('');
      } else throw new Error('VK изменил формат аудиоссылки');
    }
    if (!value.startsWith('https://')) throw new Error('VK не предоставил доступный адрес аудио');
    return value;
  }
  function userId() {
    const ownMusic = document.querySelector('a#l_aud a, a#l_aud, a[href^="/audios"]');
    return Number((ownMusic?.getAttribute('href') || location.pathname).match(/audios(\d+)/)?.[1] || 0);
  }
  async function post(url, data) {
    const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, body: new URLSearchParams(data), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`VK: HTTP ${response.status}`);
    try { return JSON.parse((await response.text()).replace(/^\s*<!--/, '')); }
    catch { throw new Error('VK запросил вход или изменил ответ. Откройте музыку VK.'); }
  }
  const plain = html => new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent;
  function registerTrack(row) {
    if (!Array.isArray(row) || !/^\d+$/.test(String(row[0])) || !/^-?\d+$/.test(String(row[1]))) throw new Error('Не удалось прочитать трек VK');
    const hashes = String(row[13] || '').split('/');
    const track = { source: 'vk', id: `${row[1]}_${row[0]}`, title: plain(row[3]), artist: plain(row[4]), duration: Number(row[5]), url: `https://vk.ru/audio${row[1]}_${row[0]}` };
    if (tracks.size >= 1000) tracks.delete(tracks.keys().next().value);
    tracks.set(track.id, { fullId: hashes[2] && hashes[5] ? [row[1], row[0], hashes[2], hashes[5]].join('_') : null, userId: userId(), directUrl: row[2] });
    return track;
  }
  function readElement(element) {
    const value = element.getAttribute('data-audio') || element.querySelector('[data-audio]')?.getAttribute('data-audio');
    if (!value) return null;
    try { return registerTrack(JSON.parse(value)); } catch { return null; }
  }
  async function resolveTrack(track) {
    const cached = tracks.get(track.id);
    if (!cached) throw new Error('Обновите страницу VK: ссылка на трек устарела');
    if (!cached.fullId && cached.directUrl) return decodeUrl(cached.directUrl, cached.userId);
    if (!cached.fullId) throw new Error('VK не предоставил ссылку на этот трек');
    const response = await chrome.runtime.sendMessage({ type: 'YM_DJ_VK_RELOAD', fullId: cached.fullId });
    if (!response?.ok) throw new Error(response?.error || 'VK не ответил');
    const row = response.data.data?.[0]?.find(row => `${row[1]}_${row[0]}` === track.id);
    if (!row?.[2]) throw new Error('VK не предоставил аудио. Трек может быть недоступен.');
    return decodeUrl(row[2], cached.userId);
  }
  globalThis.YM_DJ_VK_SOURCE = { readElement, resolveTrack };
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type !== 'YM_DJ_VK') return;
    (async () => {
      if (msg.action === 'search') {
        const data = await post('/al_audio.php', { al: '1', act: 'section', claim: '0', is_layer: '0', owner_id: String(userId()), section: 'search', q: String(msg.query).slice(0, 300) });
        const list = data.payload?.[1]?.[1]?.playlist?.list;
        if (!Array.isArray(list)) throw new Error('VK не вернул список треков. Проверьте вход; веб-API мог измениться.');
        const results = list.slice(0, 30).map(registerTrack);
        return { ok: true, tracks: results };
      }
      if (msg.action === 'resolve') {
        return { ok: true, directUrl: await resolveTrack(msg.track) };
      }
      throw new Error('Неизвестная команда VK');
    })().then(sendResponse, err => sendResponse({ ok: false, error: err.message }));
    return true;
  });
})();
