import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
test('Queued downloads keep their destination when the selected folder changes', async () => {
  const storage = { downloadDestination: { type: 'directory', id: 'first', name: 'Folder A' } };
  let listener;
  const context = vm.createContext({ crypto: webcrypto, URL, console, YM_DJ_API: {}, chrome: {
    storage: { local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, structuredClone(storage[k])])),
      set: async data => Object.assign(storage, structuredClone(data)) } },
    tabs: { query: async () => [{ id: 1 }], update: async () => {}, create: async () => {} },
    runtime: { getURL: path => `chrome-extension://test/${path}`, onMessage: { addListener: callback => { listener = callback; } } }
  } });
  vm.runInContext(await readFile(new URL('../../dj-background.js', import.meta.url), 'utf8'), context);
  const send = (message, sender = {}) => new Promise(resolve => listener(message, sender, resolve));
  const snapshot = await send({ type: 'YM_DJ_DESTINATION' });
  storage.downloadDestination = { type: 'directory', id: 'second', name: 'Folder B' };
  assert.equal((await send({ type: 'YM_DL_BUILD_AND_DOWNLOAD', destination: snapshot, payload: { filename: 'Artist - Title (Edit).mp3' } })).ok, true);
  assert.equal((await send({ type: 'YM_DJ_QUEUE', filename: 'Other - Track.mp3', track: { source: 'soundcloud' } })).ok, true);
  assert.equal(storage.downloadJobs[0].destination.id, 'first');
  assert.equal(storage.downloadJobs[1].destination.id, 'second');
  assert.equal(storage.downloadJobs[0].filename, 'Artist - Title (Edit).mp3');
  const denied = await send({ type: 'YM_DJ_UPDATE_JOB', id: storage.downloadJobs[0].id, patch: { status: 'done' } }, { url: 'https://music.yandex.ru/' });
  assert.equal(denied.ok, false);
  assert.equal(storage.downloadJobs[0].status, 'queued');
});

test('VK requests reach the content script with its own message type', async () => {
  let listener, sent;
  const context = vm.createContext({ crypto: webcrypto, URL, console, chrome: {
    runtime: { onMessage: { addListener: callback => { listener = callback; } } },
    tabs: { query: async () => [{ id: 7, url: 'https://vk.ru/audio' }], sendMessage: async (id, message) => {
      sent = { id, message }; return { ok: true, tracks: [] };
    } }
  } });
  vm.runInContext(await readFile(new URL('../../dj-background.js', import.meta.url), 'utf8'), context);
  const result = await new Promise(resolve => listener({ type: 'YM_DJ_VK_REQUEST', action: 'search', query: 'track remix' }, {}, resolve));
  assert.equal(result.ok, true); assert.equal(sent.id, 7);
  assert.equal(sent.message.type, 'YM_DJ_VK'); assert.equal(sent.message.query, 'track remix');
});
