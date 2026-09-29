import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCatalogue } from '../catalogue.mjs';

test('Essentia recognises a 120 BPM A minor reference at 44.1 kHz', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ym-analysis-'));
  const path = join(directory, 'audio.f32'), rate = 44100;
  const samples = new Float32Array(rate * 40);
  for (let i = 0; i < samples.length; i++) {
    const t = i / rate, pulse = Math.exp(-((t * 2) % 1) * 24);
    samples[i] = pulse * 0.45 * Math.sin(2 * Math.PI * 90 * t) + 0.09 *
      (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 261.6256 * t) + Math.sin(2 * Math.PI * 329.6276 * t));
  }
  await writeFile(path, Buffer.from(samples.buffer));
  const worker = new Worker(new URL('../analyse-worker.mjs', import.meta.url), { workerData: { path } });
  try {
    const data = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    assert.ok(Math.abs(data.bpm - 120) < 2, JSON.stringify(data));
    assert.equal(data.key, '8A'); assert.equal(data.seconds, 40);
  } finally { await worker.terminate(); await rm(directory, { force: true, recursive: true }); }
});

test('Analysis cannot overwrite catalogue metadata; VK stays manual', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)');
  const catalogue = createCatalogue(db, '');
  const known = { bpm: 92, key: '10A', method: 'catalogue' };
  catalogue.put('yandex:1', known);
  catalogue.put('analysis:yandex:1', { bpm: 93, key: '9A', method: 'analysis' });
  assert.deepEqual(await catalogue.lookup({ source: 'yandex', id: '1' }), known);
  catalogue.put('analysis:vk:1', { bpm: 100, key: '8A' });
  assert.equal(await catalogue.lookup({ source: 'vk', id: '1' }), null);
  assert.equal(catalogue.getAnalysis({ source: 'vk', id: '1' }).key, '8A');
  catalogue.put('analysis:soundcloud:1', { bpm: 86, key: '4A' });
  assert.equal((await catalogue.lookup({ source: 'soundcloud', id: '1' })).key, '4A');
  db.close();
});

test('Analysis cache survives reopening SQLite and expires after its TTL', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ym-cache-'));
  const path = join(directory, 'cache.sqlite');
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec('CREATE TABLE metadata (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)');
    const catalogue = createCatalogue(db, '');
    catalogue.put('analysis:soundcloud:42', { bpm: 128, key: '8A', method: 'analysis' });
    catalogue.put('analysis:soundcloud:43', { bpm: 90, key: '9A' }, -1);
    const row = db.prepare('SELECT expires FROM metadata WHERE id = ?').get('analysis:soundcloud:42');
    assert.ok(Math.abs(row.expires - Date.now() - 30 * 86400000) < 2000);
    db.close(); db = new DatabaseSync(path);
    const reopened = createCatalogue(db, '');
    assert.equal(reopened.getAnalysis({ source: 'soundcloud', id: '42' }).key, '8A');
    assert.equal(reopened.getAnalysis({ source: 'soundcloud', id: '43' }), null);
  } finally { db?.close(); await rm(directory, { force: true, recursive: true }); }
});
