# Страница GetSongBPM

Публичная страница: https://ya-music.studentto.ru/backlink

Страница содержит прямую ссылку на https://getsongbpm.com/ без `nofollow`.
Cloudflare Workers Static Assets публикует только каталог `public`.
Код расширения и локальные настройки не входят в публикацию.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm deploy
```

Для первой публикации нужен вход через `pnpm exec wrangler login`.
Custom Domain создаёт DNS-запись и сертификат Cloudflare.

При регистрации GetSongBPM укажите:

- Website URL: `https://ya-music.studentto.ru/`
- Backlink URL: `https://ya-music.studentto.ru/backlink`

Храните API-ключ вне публичных файлов и Git.
