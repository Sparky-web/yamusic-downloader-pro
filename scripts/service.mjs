import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

if (process.platform !== 'darwin') throw new Error('Автозапуск поддерживается только в macOS');
const root = fileURLToPath(new URL('..', import.meta.url));
const label = 'ru.studentto.yamusic-downloader-pro';
const domain = `gui/${process.getuid()}`, service = `${domain}/${label}`;
const plist = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const logs = join(homedir(), 'Library/Logs/YaMusic Downloader PRO');
const action = process.argv[2] || 'status';
const launch = args => execFileSync('/bin/launchctl', args, { encoding: 'utf8' });
const loaded = () => spawnSync('/bin/launchctl', ['print', service], { encoding: 'utf8' }).status === 0;
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const env = parseEnv(await readFile(join(root, '.env.local'), 'utf8'));
const endpoint = `http://127.0.0.1:${Number(env.PORT || 8789)}/health`;
async function health() {
  try { const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) }); return res.ok ? await res.json() : null; }
  catch { return null; }
}
async function ready() {
  for (let i = 0; i < 30; i++) {
    if ((await health())?.name === 'YaMusic Downloader PRO') { console.log('Сервер работает. Автозапуск и перезапуск включены.'); return; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Сервер не запустился. Проверьте журнал: ${logs}/stderr.log`);
}
if (action === 'install') {
  if (!env.SERVICE_TOKEN || env.SERVICE_TOKEN.length < 32) throw new Error('Сначала выполните pnpm configure');
  await access(join(root, 'node_modules/essentia.js'));
  await access(env.YTDLP_PATH || join(root, '.local/venv/bin/yt-dlp'));
  const bins = ['ffmpeg', 'ffprobe'].map(name => execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim());
  const wasLoaded = loaded();
  if (!wasLoaded && await health()) throw new Error('Сначала остановите сервер, запущенный вручную, и повторите установку службы');
  await mkdir(dirname(plist), { recursive: true }); await mkdir(logs, { recursive: true, mode: 0o700 });
  const paths = [...new Set([dirname(process.execPath), ...bins.map(dirname), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(delimiter);
  const args = [process.execPath, `--env-file=${join(root, '.env.local')}`, join(root, 'server/index.mjs')];
  const contents = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(paths)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>20</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(logs, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, 'stderr.log'))}</string>
</dict></plist>\n`;
  await writeFile(plist, contents, { mode: 0o600 });
  execFileSync('/usr/bin/plutil', ['-lint', plist]);
  if (wasLoaded) launch(['bootout', service]);
  launch(['enable', service]); launch(['bootstrap', domain, plist]);
  await ready();
  console.log(`Служба: ${plist}\nЖурналы: ${logs}`);
} else if (action === 'restart') {
  launch(['kickstart', '-k', service]); await ready();
} else if (action === 'uninstall') {
  if (loaded()) launch(['bootout', service]);
  await rm(plist, { force: true }); console.log('Автозапуск отключён. Кэш и настройки сохранены.');
} else if (action === 'status') {
  console.log(JSON.stringify({ loaded: loaded(), health: await health(), plist, logs }, null, 2));
} else throw new Error('Команды: install, status, restart, uninstall');
