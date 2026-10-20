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

/**
 * The song as a Standard MIDI File: format 1 with one track per unmuted layer; `programs`
 * (track id or 'melody' → General MIDI program) adds a Program Change to those tracks.
 */
export function midiBlob(song: Song, programs?: Readonly<Record<string, number>>): Blob {
  const bytes = songToMidi(song, programs === undefined ? {} : { programs });
  return new Blob([bytes], { type: 'audio/midi' });
}

/** Download the song as a Standard MIDI File through a temporary <a download>. */
export function downloadMidi(song: Song, programs?: Readonly<Record<string, number>>): void {
  const url = URL.createObjectURL(midiBlob(song, programs));
  const a = document.createElement('a');
  a.href = url;
  a.download = midiFileName(song.title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
