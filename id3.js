'use strict';

// ==================================================================
// === ЧАСТЬ 1: ГЕНЕРАТОР ID3v2 ТЕГОВ (ОБЛОЖКА И МЕТАДАННЫЕ) ===
// ==================================================================
function buildID3v2Tag(tags, coverArrayBuffer) {
  const encodeUTF16 = (str) => {
    const buf = new ArrayBuffer(str.length * 2 + 2);
    const view = new Uint8Array(buf);
    view[0] = 0xFF; view[1] = 0xFE; // BOM для кириллицы
    const view16 = new Uint16Array(buf, 2);
    for (let i = 0; i < str.length; i++) view16[i] = str.charCodeAt(i);
    return new Uint8Array(buf);
  };

  const createFrame = (id, content) => {
    const frame = new Uint8Array(10 + content.length);
    frame.set([id.charCodeAt(0), id.charCodeAt(1), id.charCodeAt(2), id.charCodeAt(3)], 0);
    frame[4] = (content.length >> 24) & 0xFF; frame[5] = (content.length >> 16) & 0xFF;
    frame[6] = (content.length >> 8) & 0xFF;  frame[7] = content.length & 0xFF;
    frame[8] = 0; frame[9] = 0;
    frame.set(content, 10);
    return frame;
  };

  const frames = [];
  const textFrames = {
    'TIT2': tags.title,
    'TPE1': tags.artist,
    'TALB': tags.album,
    'TYER': tags.year,
    'TCON': tags.genre
  };

  for (const [id, text] of Object.entries(textFrames)) {
    if (text) {
      const textBytes = encodeUTF16(text);
      const payload = new Uint8Array(1 + textBytes.length);
      payload[0] = 1;
      payload.set(textBytes, 1);
      frames.push(createFrame(id, payload));
    }
  }

  if (coverArrayBuffer) {
    const mime = "image/jpeg";
    const mimeBytes = new Uint8Array(mime.length + 1);
    for(let i=0; i<mime.length; i++) mimeBytes[i] = mime.charCodeAt(i);
    mimeBytes[mime.length] = 0;

    const desc = new Uint8Array([0xFF, 0xFE, 0x00, 0x00]);
    const payload = new Uint8Array(1 + mimeBytes.length + 1 + desc.length + coverArrayBuffer.byteLength);
    let offset = 0;
    payload[offset++] = 1;
    payload.set(mimeBytes, offset); offset += mimeBytes.length;
    payload[offset++] = 3;
    payload.set(desc, offset); offset += desc.length;
    payload.set(new Uint8Array(coverArrayBuffer), offset);

    frames.push(createFrame('APIC', payload));
  }

  const totalSize = frames.reduce((acc, f) => acc + f.length, 0);
  const header = new Uint8Array(10);
  header.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00], 0);

  header[6] = (totalSize >> 21) & 0x7F; header[7] = (totalSize >> 14) & 0x7F;
  header[8] = (totalSize >> 7) & 0x7F;  header[9] = totalSize & 0x7F;

  const id3 = new Uint8Array(10 + totalSize);
  id3.set(header, 0);
  let offset = 10;
  for (const f of frames) { id3.set(f, offset); offset += f.length; }
  return id3.buffer;
}
