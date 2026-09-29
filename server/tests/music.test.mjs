import test from 'node:test';
import assert from 'node:assert/strict';
import { camelot, selectCatalogueMatch, validateTrack } from '../music.mjs';
import { validateMediaUrl, publicAddress, parsePlaylist } from '../media.mjs';
import { soundcloudUrl } from '../soundcloud.mjs';
test('Camelot maps major, minor and enharmonic spellings', () => {
  assert.equal(camelot('Bm'), '10A'); assert.equal(camelot('A', 'minor'), '8A');
  assert.equal(camelot('C'), '8B'); assert.equal(camelot('G#', 'minor'), '1A');
  assert.equal(camelot('Gb'), '2B'); assert.equal(camelot('unknown'), null);
});
const track = { source: 'yandex', id: '1', title: 'Duvet', artist: 'bôa' };
const original = { title: 'Duvet', artist: { name: 'Bôa' }, tempo: '92', key_of: 'Bm' };
test('Catalogue never substitutes acoustic, remix or another artist', () => {
  const acoustic = { ...original, title: 'Duvet (acoustic)', tempo: '172', key_of: 'G' };
  assert.equal(selectCatalogueMatch(track, [acoustic]), null);
  assert.equal(selectCatalogueMatch({ ...track, version: 'Club Remix' }, [original]), null);
  assert.equal(selectCatalogueMatch(track, [{ ...original, artist: { name: 'Other' } }]), null);
  assert.equal(selectCatalogueMatch(track, [acoustic, original]).tempo, '92');
});
test('Conflicting recordings are rejected; small rounding differences stay visible', () => {
  assert.equal(selectCatalogueMatch(track, [original, { ...original, tempo: '184' }]), null);
  assert.equal(selectCatalogueMatch(track, [original, { ...original, key_of: 'C' }]), null);
  assert.deepEqual(selectCatalogueMatch(track, [original, { ...original, tempo: '93' }]).tempoRange, [92, 93]);
});
test('Audio fetch rejects arbitrary domains, credentials, ports and private IPs', () => {
  for (const url of ['http://cdn.yandex.net/a', 'https://yandex.net.evil.test/a', 'https://localhost/a', 'https://a:b@cdn.yandex.net/a', 'https://cdn.yandex.net:8080/a']) assert.throws(() => validateMediaUrl(url, 'yandex'));
  assert.equal(validateMediaUrl('https://cdn.yandex.net/a', 'yandex').hostname, 'cdn.yandex.net');
  for (const ip of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.100.100.100', '::1']) assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress('8.8.8.8'), true);
});
test('HLS preserves timeline, sequence, key rotation and relative URLs', () => {
  const p = parsePlaylist('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:10,\na.ts\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:12,\nb.ts', 'https://cdn.sndcdn.com/test/list.m3u8');
  assert.equal(p.duration, 22); assert.equal(p.segments[0].sequence, 7); assert.equal(p.segments[1].time, 10);
  assert.equal(p.segments[0].key.url, 'https://cdn.sndcdn.com/test/key'); assert.equal(p.segments[1].key, null);
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"', 'https://cdn.sndcdn.com/a'));
});
test('SoundCloud accepts only individual public track URLs', () => {
  assert.equal(soundcloudUrl('https://soundcloud.com/artist/song?utm_source=x'), 'https://soundcloud.com/artist/song');
  for (const url of ['https://soundcloud.com.evil.test/a/b', 'file:///tmp/a', 'https://soundcloud.com/a/sets/b', 'https://soundcloud.com/a']) assert.throws(() => soundcloudUrl(url));
  assert.throws(() => validateTrack({ source: 'custom', id: '1', title: 'test' }));
});
