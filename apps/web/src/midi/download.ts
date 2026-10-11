import type { Song } from '@crokychords/core';
import { DEFAULT_SONG_TITLE, songToMidi } from '@crokychords/core';

/** '<title>.mid' with characters that are unsafe in file names replaced. */
export function midiFileName(title: string): string {
  const printable = [...title].map((c) => (c.charCodeAt(0) < 0x20 ? '-' : c)).join('');
  const base = printable
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return `${base === '' ? DEFAULT_SONG_TITLE : base}.mid`;
}

/** The song as a Standard MIDI File: format 1 with one track per unmuted layer. */
export function midiBlob(song: Song): Blob {
  return new Blob([songToMidi(song)], { type: 'audio/midi' });
}

/** Download the song as a Standard MIDI File through a temporary <a download>. */
export function downloadMidi(song: Song): void {
  const url = URL.createObjectURL(midiBlob(song));
  const a = document.createElement('a');
  a.href = url;
  a.download = midiFileName(song.title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
