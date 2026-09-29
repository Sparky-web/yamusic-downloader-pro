import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { soundcloudUrl } from '../soundcloud.mjs';
const script = await readFile(new URL('../../source-ui.js', import.meta.url), 'utf8');
const vkScript = await readFile(new URL('../../vk-content.js', import.meta.url), 'utf8');
function environment(sendMessage, vkSource) {
  const context = vm.createContext({ URL, setTimeout, document: { body: null },
    location: { hostname: vkSource ? 'vk.ru' : 'soundcloud.com', href: 'https://soundcloud.com/artist/song' },
    chrome: { runtime: { sendMessage } }, YM_DJ_PRESENTATION: {}, YM_DJ_VK_SOURCE: vkSource });
  vm.runInContext(script, context);
  return context.YM_DJ_SOURCE_ACTIONS;
}
const track = { source: 'soundcloud', id: '123', artist: 'Artist', title: 'Original Title', url: 'https://soundcloud.com/artist/song' };
test('SoundCloud track links support embedded pages and reject navigation links', () => {
  const { soundcloudTrackUrl } = environment();
  assert.equal(soundcloudTrackUrl('/n/artist/song?embedded=crossfade'), track.url);
  assert.equal(soundcloudTrackUrl('/artist/song?in=playlist'), track.url);
  for (const url of ['/tags/house', '/you/likes', '/artist/sets', '/artist/tracks', '/artist/sets/playlist', '/artist', 'https://evil.example/artist/song']) assert.equal(soundcloudTrackUrl(url), null);
  assert.equal(soundcloudUrl(track.url + '?in=playlist'), track.url);
  assert.throws(() => soundcloudUrl('https://soundcloud.com@evil.example/artist/song'));
});
test('Download keeps the folder selected before the metadata request', async () => {
  let selected = { type: 'directory', id: 'A' }, queued;
  const actions = environment(async msg => {
    if (msg.type === 'YM_DJ_DESTINATION') return { ...selected };
    if (msg.type === 'YM_DJ_QUEUE') { queued = msg; return { ok: true }; }
    throw new Error('Unexpected message');
  });
  await actions.download(async () => { selected = { type: 'directory', id: 'B' }; return track; });
  assert.equal(queued.destination.id, 'A');
  assert.equal(queued.filename, 'Artist - Original Title.mp3');
  assert.equal(queued.track.id, '123');
});
test('Cached VK analysis never resolves or downloads audio', async () => {
  let resolves = 0;
  const calls = [];
  const actions = environment(async msg => { calls.push(msg); return { ok: true, metadata: { bpm: 128, key: '8A' } }; },
    { resolveTrack: () => { resolves++; throw new Error('Must not request media'); } });
  const result = await actions.analyse(async () => ({ ...track, source: 'vk', id: '-1_2' }), () => {});
  assert.equal(result.cached, true); assert.equal(result.key, '8A');
  assert.equal(resolves, 0); assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/lookup'); assert.equal(calls[0].body.analysisOnly, true);
});
test('Recalculate bypasses the cache and resolves only the requested VK track', async () => {
  const calls = [], resolved = [];
  const actions = environment(async msg => {
    calls.push(msg);
    if (msg.path === '/analyse') return { ok: true, id: 'job' };
    if (msg.path === '/jobs/job') return { ok: true, status: 'done', result: { bpm: 120, key: '2A' } };
    throw new Error('Unexpected request');
  }, { resolveTrack: async t => { resolved.push(t.id); return 'https://example.vkuseraudio.net/sample.mp3'; } });
  const result = await actions.analyse(async () => ({ ...track, source: 'vk', id: '-1_2' }), () => {}, true);
  assert.equal(result.cached, false); assert.equal(result.bpm, 120);
  assert.deepEqual(resolved, ['-1_2']); assert.equal(calls[0].body.force, true);
  assert.equal(calls[0].body.track.directUrl, 'https://example.vkuseraudio.net/sample.mp3');
});
test('VK row identity is preserved and reload selects the exact owner and track', async () => {
  const row = [12, -34, '', 'Song', 'Artist', 180]; row[13] = '//hashA///hashB';
  let requested;
  const context = vm.createContext({ document: { querySelector: () => null }, location: { pathname: '/audios567' },
    DOMParser: class { parseFromString(html) { return { body: { textContent: html } }; } },
    chrome: { runtime: { onMessage: { addListener() {} }, async sendMessage(msg) {
      requested = msg;
      return { ok: true, data: { data: [[[99, -34, 'wrong'], [12, -34, 'https://example.vkuseraudio.net/right.mp3']]] } };
    } } } });
  vm.runInContext(vkScript, context);
  const adapter = context.YM_DJ_VK_SOURCE;
  const parsed = adapter.readElement({ getAttribute: () => JSON.stringify(row) });
  assert.equal(parsed.id, '-34_12'); assert.equal(parsed.title, 'Song');
  assert.equal(await adapter.resolveTrack(parsed), 'https://example.vkuseraudio.net/right.mp3');
  assert.equal(requested.fullId, '-34_12_hashA_hashB');
  assert.equal(adapter.readElement({ getAttribute: () => 'invalid' }), null);
});
