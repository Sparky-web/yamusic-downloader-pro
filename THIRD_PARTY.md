# Third-party components

- Original extension: [KernelPace/yamusic-downloader-pro](https://github.com/KernelPace/yamusic-downloader-pro), GPL-3.0. Original notices and LICENSE are retained.
- Audio analysis: [MTG/essentia.js](https://github.com/MTG/essentia.js), version 0.1.3, AGPL-3.0. The local server loads this dependency; it is not bundled into the Chrome extension. See the dependency's license and the [Essentia licensing page](https://essentia.upf.edu/licensing_information.html) before distributing or hosting the analysis service.
- SoundCloud extractor: [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp), version 2026.8.19, Unlicense. See the project's third-party notices for its dependencies.
- HTTP transport for yt-dlp: [lexiforest/curl_cffi](https://github.com/lexiforest/curl_cffi), version 0.13.0, MIT, with curl-impersonate dependencies under their own licenses.
- VK web protocol and URL decoding in `vk-content.js` are adapted from [python273/vk_api](https://github.com/python273/vk_api), `vk_api/audio.py` and `vk_api/audio_url_decoder.py`, Apache-2.0. This adaptation changes the runtime to JavaScript and keeps browser session credentials inside the browser. The Apache-2.0 license is included at `licenses/vk-api-Apache-2.0.txt`.
- Metadata provider: [GetSongBPM](https://getsongbpm.com/). The service uses the user's API key. Attribution is linked from the extension and [the public backlink page](https://ya-music.studentto.ru/backlink).
