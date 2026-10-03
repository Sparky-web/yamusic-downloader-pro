import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import essentia from 'essentia.js';
import { camelot } from './music.mjs';
const engine = new essentia.Essentia(essentia.EssentiaWASM);
try {
  const buffer = readFileSync(workerData.path);
  const samples = new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  if (samples.length < 44100 * 15) throw new Error('Слишком короткий фрагмент');
  const vector = engine.arrayToVector(samples);
  const rhythm = engine.RhythmExtractor2013(vector, 208, 'multifeature', 60);
  const tonal = engine.KeyExtractor(vector);
  const result = { bpm: Math.round(rhythm.bpm * 10) / 10, key: camelot(tonal.key, tonal.scale),
    musicalKey: `${tonal.key} ${tonal.scale}`, rhythmConfidence: rhythm.confidence, keyStrength: tonal.strength,
    seconds: Math.round(samples.length / 44100) };
  vector.delete();
  for (const value of Object.values(rhythm)) value?.delete?.();
  parentPort.postMessage(result);
} catch (err) { parentPort.postMessage({ error: err.message }); }
