import { spawn } from 'node:child_process';
export function run(command, args, { timeout = 90000, maxBytes = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GETSONG_API_KEY: '', SERVICE_TOKEN: '' } });
    let size = 0, stderr = '';
    const chunks = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxBytes) child.kill('SIGKILL'); else chunks.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const reason = /DRM protected/i.test(stderr) ? 'Источник защищает аудио DRM. Скачивание и анализ недоступны.' :
          /not available in your country|geo.?restricted/i.test(stderr) ? 'Трек недоступен в регионе сервера.' :
          /sign in|log in|login required/i.test(stderr) ? 'Источник требует вход. Этот трек недоступен серверу.' :
          /timed out|timeout/i.test(stderr) ? 'Источник не ответил вовремя. Повторите запрос.' : `${command.split('/').pop()}: обработка не удалась`;
        const error = new Error(signal ? 'Превышен лимит времени или размера' : reason);
        // Upstream errors can contain signed URLs. Keep them out of the client response and logs.
        error.code = code;
        reject(error);
      } else resolve(Buffer.concat(chunks));
    });
  });
}
