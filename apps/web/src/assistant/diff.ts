/**
 * What a proposal changes (docs/specs/assistant-v1.md §B1): the progression chord by chord
 * (unchanged, added, replaced, removed) and one line per other change (key, tempo, meter, title,
 * melody, band), so the user sees the whole edit before applying it.
 */
import type { Melody, MelodyNote, Song, SongChord, Track } from '@crokychords/core';
import { MODE_LABELS } from '../music';
import { songMelody } from '../melody';

export type ChordChange =
  | { kind: 'same'; token: string; beats: number }
  | { kind: 'added'; token: string; beats: number }
  | { kind: 'removed'; token: string; beats: number }
  | { kind: 'replaced'; token: string; beats: number; before: string; beforeBeats: number };

const sameChord = (a: SongChord, b: SongChord): boolean =>
  a.token === b.token && a.beats === b.beats;

/** The progression's changes, in the order of the new song (removed chords where they were). */
export function diffChords(
  before: readonly SongChord[],
  after: readonly SongChord[],
): ChordChange[] {
  const n = before.length;
  const m = after.length;
  // lcs[i][j]: longest common run of before[i..] and after[j..].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const a = before[i];
      const b = after[j];
      const row = lcs[i] ?? [];
      row[j] =
        a !== undefined && b !== undefined && sameChord(a, b)
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: ChordChange[] = [];
  let removed: SongChord[] = [];
  let added: SongChord[] = [];
  const flush = (): void => {
    const pairs = Math.min(removed.length, added.length);
    for (let k = 0; k < pairs; k++) {
      const r = removed[k];
      const a = added[k];
      if (r === undefined || a === undefined) continue;
      out.push({
        kind: 'replaced',
        token: a.token,
        beats: a.beats,
        before: r.token,
        beforeBeats: r.beats,
      });
    }
    for (const r of removed.slice(pairs))
      out.push({ kind: 'removed', token: r.token, beats: r.beats });
    for (const a of added.slice(pairs)) out.push({ kind: 'added', token: a.token, beats: a.beats });
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const a = before[i];
    const b = after[j];
    if (a !== undefined && b !== undefined && sameChord(a, b)) {
      flush();
      out.push({ kind: 'same', token: b.token, beats: b.beats });
      i++;
      j++;
    } else if (
      b === undefined ||
      (a !== undefined && (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))
    ) {
      if (a !== undefined) removed.push(a);
      i++;
    } else {
      added.push(b);
      j++;
    }
  }
  flush();
  return out;
}

const noteKey = (n: MelodyNote): string =>
  `${n.beat}/${n.length}/${n.degree}/${n.octave}/${n.accidental}`;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

function melodyLines(before: Melody, after: Melody): string[] {
  const lines: string[] = [];
  const old = new Set(before.notes.map(noteKey));
  const now = new Set(after.notes.map(noteKey));
  const added = [...now].filter((k) => !old.has(k)).length;
  const removed = [...old].filter((k) => !now.has(k)).length;
  const parts: string[] = [];
  if (added > 0) parts.push(`+${plural(added, 'note')}`);
  if (removed > 0) parts.push(`−${plural(removed, 'note')}`);
  if (parts.length > 0) lines.push(`Melody: ${parts.join(', ')}`);
  if (before.channel !== after.channel) {
    lines.push(`Melody: channel ${before.channel + 1} → ${after.channel + 1}`);
  }
  if (before.muted !== after.muted) lines.push(`Melody: ${after.muted ? 'muted' : 'unmuted'}`);
  return lines;
}

const TRACK_FIELDS = [
  'name',
  'role',
  'octave',
  'voicing',
  'velocity',
  'gate',
  'transpose',
] as const;

function trackLines(before: readonly Track[], after: readonly Track[]): string[] {
  const lines: string[] = [];
  for (const t of before) {
    if (!after.some((a) => a.id === t.id)) lines.push(`Band: − ${t.name}`);
  }
  for (const t of after) {
    const old = before.find((b) => b.id === t.id);
    if (old === undefined) {
      lines.push(`Band: + ${t.name} (${t.role}, channel ${t.channel + 1})`);
      continue;
    }
    const parts: string[] = [];
    for (const field of TRACK_FIELDS) {
      if (old[field] !== t[field])
        parts.push(`${field} ${String(old[field])} → ${String(t[field])}`);
    }
    if (old.channel !== t.channel) parts.push(`channel ${old.channel + 1} → ${t.channel + 1}`);
    if (old.pattern.id !== t.pattern.id) parts.push(`pattern ${old.pattern.id} → ${t.pattern.id}`);
    if (old.muted !== t.muted) parts.push(t.muted ? 'muted' : 'unmuted');
    if (parts.length > 0) lines.push(`${old.name}: ${parts.join(', ')}`);
  }
  return lines;
}

/** One line per change outside the progression. */
export function describeChanges(before: Song, after: Song): string[] {
  const lines: string[] = [];
  const key = (s: Song) => `${s.key.tonic} ${MODE_LABELS[s.key.mode].toLowerCase()}`;
  if (before.key.tonic !== after.key.tonic || before.key.mode !== after.key.mode) {
    lines.push(`Key: ${key(before)} → ${key(after)}`);
  }
  if (before.tempo !== after.tempo) lines.push(`Tempo: ${before.tempo} → ${after.tempo} BPM`);
  if (before.meter.beats !== after.meter.beats || before.meter.unit !== after.meter.unit) {
    lines.push(
      `Meter: ${before.meter.beats}/${before.meter.unit} → ${after.meter.beats}/${after.meter.unit}`,
    );
  }
  if (before.title !== after.title) lines.push(`Title: “${before.title}” → “${after.title}”`);
  lines.push(...melodyLines(songMelody(before), songMelody(after)));
  lines.push(...trackLines(before.tracks ?? [], after.tracks ?? []));
  return lines;
}
