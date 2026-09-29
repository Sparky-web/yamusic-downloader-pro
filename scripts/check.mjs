import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const files = [...readdirSync('.').filter(f => f.endsWith('.js')), ...['server', 'scripts', 'server/tests'].flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.mjs')).map(f => `${dir}/${f}`))];
for (const file of files) execFileSync(process.execPath, ['--check', file]);
console.log(`Синтаксис проверен: ${files.length} файлов`);
