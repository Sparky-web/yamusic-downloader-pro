export const normalize = (s = '') => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const major = ['B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E'];
const minor = ['Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db'];
const enharmonic = { 'G#': 'Ab', 'D#': 'Eb', 'A#': 'Bb', 'C#': 'Db', Gb: 'F#', Cb: 'B', Fb: 'E', 'E#': 'F', 'B#': 'C' };
export function camelot(key, scale) {
  let note = String(key || '').replace(/♯/g, '#').replace(/♭/g, 'b').trim();
  const isMinor = scale === 'minor' || /m$/.test(note);
  note = note.replace(/m$/, '');
  note = enharmonic[note] || note;
  const index = (isMinor ? minor : major).indexOf(note);
  return index < 0 ? null : `${index + 1}${isMinor ? 'A' : 'B'}`;
}
export function fullTitle(track) {
  return `${track.title || ''}${track.version ? ` (${track.version})` : ''}`;
}
export function selectCatalogueMatch(track, candidates) {
  const title = normalize(fullTitle(track));
  const artists = (track.artists || [track.artist]).filter(Boolean).map(normalize);
  let matches = candidates.filter(c => normalize(c.title) === title && artists.includes(normalize(c.artist?.name)));
  const sameAlbum = track.album && matches.filter(c => normalize(c.album?.title) === normalize(track.album));
  if (sameAlbum?.length) matches = sameAlbum;
  // Identical titles can still represent different recordings. Conflicting data requires audio analysis.
  const keys = new Set(matches.map(c => c.key_of));
  const tempos = matches.map(c => Number(c.tempo)).filter(n => n > 0);
  if (!matches.length || keys.size !== 1 || tempos.length !== matches.length || Math.max(...tempos) - Math.min(...tempos) > 1) return null;
  return { ...matches[0], tempoRange: [...new Set(tempos)].sort((a, b) => a - b) };
}
export function validateTrack(value) {
  if (!value || !['yandex', 'soundcloud', 'vk'].includes(value.source)) throw new Error('Неизвестный источник');
  if (!value.id || String(value.id).length > 120 || !String(value.title || '').trim()) throw new Error('Не указан трек');
  if (String(value.title).length > 400 || String(value.artist || '').length > 400) throw new Error('Слишком длинное название');
  return { source: value.source, id: String(value.id), title: String(value.title), version: String(value.version || '').slice(0, 400),
    artist: String(value.artist || ''), album: String(value.album || '').slice(0, 400), artists: Array.isArray(value.artists) ? value.artists.slice(0, 30).map(String) : undefined,
    duration: Math.max(0, Math.min(7200, Number(value.duration) || 0)), url: String(value.url || ''), directUrl: String(value.directUrl || '') };
}
export function cacheKey(track) { return `${track.source}:${track.id}`; }
