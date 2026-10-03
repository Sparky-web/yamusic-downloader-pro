import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
const script = await readFile(new URL('../../source-ui.js', import.meta.url), 'utf8');
const canonical = name => `https://soundcloud.com/artist/${name}`;
const link = name => `<a href="${canonical(name)}">${name}</a>`;
function environment(html, path = '/you/likes', cached = {}) {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const calls = [], timers = [];
  const location = { hostname: 'soundcloud.com', href: 'https://soundcloud.com' + path };
  const context = vm.createContext({ document, location, URL,
    window: { addEventListener() {} },
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; }, clearTimeout, setInterval: () => 0,
    MutationObserver: class { observe() {} },
    chrome: { runtime: { async sendMessage(msg) {
      calls.push(msg);
      if (msg.path === '/cached') return { ok: true, metadata: Object.fromEntries(msg.body.urls.map(url => [url, cached[url] || null])) };
      if (msg.path === '/track') return { ok: true, track: { source: 'soundcloud', id: '123', title: 'Song', url: msg.body.url } };
      if (msg.path === '/lookup') return { ok: true, metadata: { bpm: 123, key: '8A', cached: true } };
      if (msg.type === 'YM_DJ_DESTINATION') return { type: 'browser' };
      return { ok: true };
    } } },
    YM_DJ_PRESENTATION: { render: (node, data) => { node.textContent = data ? `${data.bpm} · ${data.key}` : '— · —'; }, label: () => '' }
  });
  vm.runInContext(script, context);
  return { document, calls, location, actions: context.YM_DJ_SOURCE_ACTIONS, cleanup: () => timers.forEach(clearTimeout) };
}
test('SoundCloud covers tiles, playlist rows, feed, search, related cards, queue and miniplayer without duplicates', () => {
  const env = environment(`
    <li class="badgeList__item"><div class="playableTile">${link('tile')}${link('tile')}</div></li>
    <li class="systemPlaylistTrackList__item"><div class="trackItem">${link('playlist')}</div></li>
    <li class="soundList__item">${link('feed')}</li>
    <li class="searchList__item">${link('search')}</li>
    <div><div>${link('related')}<div role="toolbar"><button>Like</button></div></div></div>
    <div>${link('new-layout')}</div>
    <section role="contentinfo" class="playControls"><div class="queue"><div class="queueItemView">${link('queue')}</div></div>
    <div class="playbackSoundBadge"><a class="playbackSoundBadge__titleLink" href="${canonical('playing')}" title="Playing">Playing</a></div></section>
    <nav>${link('navigation')}</nav><a href="https://soundcloud.com/artist/albums">Albums</a>
  `);
  try {
    const controls = () => [...env.document.querySelectorAll('.ym-source-controls')];
    assert.equal(controls().length, 8);
    assert.equal(new Set(controls().map(e => e.dataset.track)).size, 8);
    assert.ok(env.document.querySelector('.badgeList__item > .ym-source-controls'));
    assert.ok(env.document.querySelector('.systemPlaylistTrackList__item > .ym-source-controls'));
    env.actions.injectSoundcloud(); assert.equal(controls().length, 8);
    for (const host of controls()) assert.equal(host.shadowRoot.querySelectorAll('button').length, 2);
    assert.ok(env.document.querySelector('#ym-source-player-controls').shadowRoot.querySelector('.caption').textContent.includes('Playing'));
  } finally { env.cleanup(); }
});
test('Embedded track page mounts controls at the track header', () => {
  const env = environment('<main><section aria-label="Track header"><h1>Song</h1></section></main>', '/n/artist/song?embedded=crossfade');
  try { assert.equal(env.document.querySelector('[aria-label="Track header"] .ym-source-controls').dataset.track, canonical('song')); }
  finally { env.cleanup(); }
});
test('Automatic badges batch cache reads without metadata extraction or analysis', async () => {
  const env = environment(`<li>${link('song')}</li><li>${link('song')}</li><li>${link('other')}</li>`, '/you/likes', { [canonical('song')]: { bpm: 128, key: '4A' } });
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(env.calls.length, 1); assert.equal(env.calls[0].path, '/cached');
    assert.equal(env.calls[0].body.urls.length, 2);
    const hosts = [...env.document.querySelectorAll('.ym-source-controls')];
    assert.equal(hosts[0].shadowRoot.querySelector('.values').textContent, '128 · 4A');
    assert.equal(hosts[1].shadowRoot.querySelector('.values').textContent, '128 · 4A');
    assert.equal(hosts[2].shadowRoot.querySelector('.values').textContent, '— · —');
  } finally { env.cleanup(); }
});
test('Recycled rows and miniplayer discard old badges and cannot download the previous track', async () => {
  const env = environment(`<li>${link('old')}</li><div class="playbackSoundBadge"><a class="playbackSoundBadge__titleLink" href="${canonical('playing')}">Playing</a></div>`);
  try {
    const row = env.document.querySelector('li'), previous = row.querySelector('.ym-source-controls');
    row.querySelector('a').href = canonical('new');
    await previous.shadowRoot.querySelector('button').onclick();
    assert.ok(previous.shadowRoot.querySelector('.status').textContent.includes('Список обновился'));
    assert.equal(env.calls.some(msg => msg.type === 'YM_DJ_QUEUE'), false);
    env.actions.injectSoundcloud(); assert.equal(row.querySelectorAll('.ym-source-controls').length, 1);
    assert.equal(row.querySelector('.ym-source-controls').dataset.track, canonical('new'));
    assert.equal(previous.isConnected, false);
    env.document.querySelector('.playbackSoundBadge__titleLink').href = canonical('next');
    env.actions.injectSoundcloud();
    assert.equal(env.document.querySelector('#ym-source-player-controls').dataset.track, canonical('next'));
    row.querySelector('a').href = 'https://soundcloud.com/artist';
    env.actions.injectSoundcloud(); assert.equal(row.querySelector('.ym-source-controls'), null);
  } finally { env.cleanup(); }
});
