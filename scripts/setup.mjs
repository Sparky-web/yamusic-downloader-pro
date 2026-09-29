import { readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const path = new URL('../.env.local', import.meta.url);
let env = await readFile(path, 'utf8').catch(() => 'GETSONG_API_KEY=\n');
if (!/^SERVICE_TOKEN=.{32,}$/m.test(env)) env += `\nSERVICE_TOKEN=${randomBytes(32).toString('hex')}\n`;
await writeFile(path, env, { mode: 0o600 }); await chmod(path, 0o600);
console.log('Локальные настройки готовы. Секреты не выводятся.');
