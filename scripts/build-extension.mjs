import { readFile, writeFile, mkdir, copyFile, chmod } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { resolve, join } from 'node:path';
const env = parseEnv(await readFile('.env.local', 'utf8'));
if (!env.SERVICE_TOKEN || env.SERVICE_TOKEN.length < 32) throw new Error('Сначала выполните pnpm configure');
const files = ['manifest.json', 'icon.png', 'button-config.js', 'content.js', 'vibe-interceptor.js', 'background.js',
  'popup.html', 'popup.js', 'options.html', 'options.js', 'dj-ui.js', 'dj-background.js', 'dj-api.js', 'vk-content.js',
  'downloads.html', 'downloads.js', 'downloads.css', 'id3.js'];
const directory = resolve('.local/extension');
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const file of files) await copyFile(file, join(directory, file));
await writeFile(join(directory, 'config.local.js'), `globalThis.YM_DJ_CONFIG = ${JSON.stringify({ serverUrl: env.SERVER_URL || 'http://127.0.0.1:8789', serviceToken: env.SERVICE_TOKEN })};\n`, { mode: 0o600 });
await chmod(join(directory, 'config.local.js'), 0o600);
console.log(`Расширение собрано: ${directory}`);
