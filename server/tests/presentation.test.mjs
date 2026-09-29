import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const script = await readFile(new URL('../../dj-presentation.js', import.meta.url), 'utf8');
function environment() {
  const window = new EventTarget();
  const host = {};
  const document = { activeElement: null, getElementById: () => host };
  const context = vm.createContext({ window, document });
  vm.runInContext(script, context);
  return { window, host, document, presentation: context.YM_DJ_PRESENTATION };
}
function luminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map(value => parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
test('All 24 Camelot badges retain readable contrast and omit visible field labels', () => {
  const { presentation } = environment();
  const foreground = luminance('#18212f');
  assert.equal(Object.keys(presentation.colors).length, 24);
  for (let n = 1; n <= 12; n++) for (const scale of ['A', 'B']) {
    const color = presentation.colors[`${n}${scale}`];
    assert.ok(color);
    assert.ok((luminance(color) + 0.05) / (foreground + 0.05) >= 7, `${n}${scale} needs better contrast`);
  }
  assert.equal(presentation.label({ bpm: 128, key: '8A' }), '128 · 8A');
  assert.equal(presentation.label({ bpm: 92, bpmRange: [92, 93], key: '10A', approximate: true, uncertain: true }), '≈ 92–93 · 10A ?');
  assert.equal(presentation.label(null), '— · —');
});
test('Modal keyboard events never reach later global shortcuts and retain native editing defaults', () => {
  const { window, host, document, presentation } = environment();
  let shortcuts = 0, modalKeys = 0;
  presentation.onKeyDown = () => modalKeys++;
  for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, () => shortcuts++, { capture: true });
  document.activeElement = host;
  for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'Enter', 'a', 'v']) for (const type of ['keydown', 'keypress', 'keyup']) {
    const event = new Event(type, { cancelable: true }); event.key = key;
    assert.equal(window.dispatchEvent(event), true, 'Editing/submit defaults must remain active');
  }
  assert.equal(shortcuts, 0); assert.equal(modalKeys, 6);
  document.activeElement = null;
  window.dispatchEvent(new Event('keydown'));
  assert.equal(shortcuts, 1, 'Player shortcuts must work outside the modal');
});
test('The keyboard guard loads at document_start before the page can register shortcuts', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
  const guard = manifest.content_scripts.find(s => s.js.includes('dj-presentation.js'));
  assert.equal(guard.run_at, 'document_start');
});
