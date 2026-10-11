/** Pure track ("band") operations used by the Band panel, the toolbar and auditions. */
import type { NoteEvent, Pattern, Song, Track, TrackRole } from '@crokychords/core';
import {
  PATTERN_PRESETS,
  ROLE_DEFAULTS,
  TRACK_ROLES,
  createTrack,
  isRestToken,
  patternPreset,
  patternRoles,
  renderTrack,
  tryParseToken,
} from '@crokychords/core';

export const MIDI_CHANNELS = 16;
export const OCTAVE_MIN = -1;
export const OCTAVE_MAX = 9;
export const TRANSPOSE_MIN = -24;
export const TRANSPOSE_MAX = 24;
export const VELOCITY_MIN = 1;
export const VELOCITY_MAX = 127;
export const GATE_MIN = 0.1;
export const GATE_MAX = 1;
/** Length of a hover/keyboard audition, in beats of the song tempo. */
export const AUDITION_BEATS = 2;

export const ROLE_LABELS: Record<TrackRole, string> = {
  chords: 'Chords',
  bass: 'Bass',
  arp: 'Arp',
  pad: 'Pad',
  custom: 'Custom',
};

/** The song's tracks (`[]` for a hand-built schema-1 song object). */
export function songTracks(song: Song): readonly Track[] {
  return song.tracks ?? [];
}

export function findTrack(song: Song, id: string | null): Track | undefined {
  return id === null ? undefined : songTracks(song).find((t) => t.id === id);
}

function withTracks(song: Song, tracks: Track[]): Song {
  return { ...song, tracks };
}

/** The least used MIDI channel (0-15), lowest first: the first free one while any is free. */
export function nextFreeChannel(tracks: readonly Track[]): number {
  const counts = new Array<number>(MIDI_CHANNELS).fill(0);
  for (const t of tracks) counts[t.channel] = (counts[t.channel] ?? 0) + 1;
  let best = 0;
  for (let ch = 1; ch < MIDI_CHANNELS; ch++) {
    if ((counts[ch] ?? 0) < (counts[best] ?? 0)) best = ch;
  }
  return best;
}

/** `base`, or `base 2`, `base 3`, ... whichever is not taken yet. */
export function uniqueTrackName(tracks: readonly Track[], base: string): string {
  const names = new Set(tracks.map((t) => t.name));
  if (!names.has(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!names.has(name)) return name;
  }
}

/** Append a track with the role's defaults on the next free channel. */
export function addTrack(
  song: Song,
  role: TrackRole,
  random: () => number = Math.random,
): { song: Song; trackId: string } {
  const tracks = songTracks(song);
  const track = createTrack(
    role,
    {
      channel: nextFreeChannel(tracks),
      name: uniqueTrackName(tracks, ROLE_DEFAULTS[role].name),
    },
    random,
  );
  return { song: withTracks(song, [...tracks, track]), trackId: track.id };
}

export function removeTrack(song: Song, id: string): Song {
  const tracks = songTracks(song);
  if (!tracks.some((t) => t.id === id)) return song;
  return withTracks(
    song,
    tracks.filter((t) => t.id !== id),
  );
}

/** Move a track `delta` places (−1 = up); unchanged at the ends. */
export function moveTrack(song: Song, id: string, delta: number): Song {
  const tracks = [...songTracks(song)];
  const from = tracks.findIndex((t) => t.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= tracks.length || to === from) return song;
  const [track] = tracks.splice(from, 1);
  if (track === undefined) return song;
  tracks.splice(to, 0, track);
  return withTracks(song, tracks);
}

export type TrackPatch = Partial<Omit<Track, 'id'>>;

function samePattern(a: Pattern, b: Pattern): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Change fields of one track; returns the same song object when nothing changed. */
export function updateTrack(song: Song, id: string, patch: TrackPatch): Song {
  const tracks = songTracks(song);
  const index = tracks.findIndex((t) => t.id === id);
  const track = tracks[index];
  if (track === undefined) return song;
  const next: Track = { ...track, ...patch };
  const changed = (Object.keys(patch) as (keyof TrackPatch)[]).some((k) =>
    k === 'pattern' ? !samePattern(track.pattern, next.pattern) : track[k] !== next[k],
  );
  if (!changed) return song;
  const copy = [...tracks];
  copy[index] = next;
  return withTracks(song, copy);
}

export function toggleMute(song: Song, id: string): Song {
  const track = findTrack(song, id);
  return track === undefined ? song : updateTrack(song, id, { muted: !track.muted });
}

/** Replace the track's pattern with a fresh copy of a preset. */
export function setTrackPattern(song: Song, id: string, presetId: string): Song {
  return updateTrack(song, id, { pattern: patternPreset(presetId) });
}

/** The fields ROLE_DEFAULTS sets for the track's current role (octave, pattern, velocity). */
export function roleDefaultsPatch(role: TrackRole): TrackPatch {
  const d = ROLE_DEFAULTS[role];
  return { octave: d.octave, pattern: patternPreset(d.pattern), velocity: d.velocity };
}

/** True when the track already has its role's default octave, pattern and velocity. */
export function hasRoleDefaults(track: Track): boolean {
  const d = ROLE_DEFAULTS[track.role];
  return (
    track.octave === d.octave && track.pattern.id === d.pattern && track.velocity === d.velocity
  );
}

/** Apply ROLE_DEFAULTS of the track's role (the explicit "apply defaults" button). */
export function applyRoleDefaults(song: Song, id: string): Song {
  const track = findTrack(song, id);
  return track === undefined ? song : updateTrack(song, id, roleDefaultsPatch(track.role));
}

/** True when `pattern` is one of the built-in presets (by id). */
export function isPresetPattern(pattern: Pattern): boolean {
  return PATTERN_PRESETS.some((p) => p.id === pattern.id);
}

export interface PresetGroup {
  role: TrackRole;
  label: string;
  presets: readonly Pattern[];
}

/**
 * PATTERN_PRESETS grouped by their first role hint (so every preset appears once), in
 * TRACK_ROLES order; empty groups are left out.
 */
export function presetGroups(): PresetGroup[] {
  return TRACK_ROLES.map((role) => ({
    role,
    label: ROLE_LABELS[role],
    presets: PATTERN_PRESETS.filter((p) => (patternRoles(p.id)[0] ?? 'custom') === role),
  })).filter((g) => g.presets.length > 0);
}

export interface ChannelMapItem {
  id: string;
  name: string;
  /** 1-16, as shown to the user. */
  channel: number;
  muted: boolean;
}

export function channelMap(tracks: readonly Track[]): ChannelMapItem[] {
  return tracks.map((t) => ({ id: t.id, name: t.name, channel: t.channel + 1, muted: t.muted }));
}

/** 'Chords ch1 · Bass ch2 · Arp ch3 (muted)'. */
export function channelMapLabel(tracks: readonly Track[]): string {
  return channelMap(tracks)
    .map((i) => `${i.name} ch${i.channel}${i.muted ? ' (muted)' : ''}`)
    .join(' · ');
}

/** Distinct MIDI channels of the tracks, ascending. */
export function trackChannels(tracks: readonly Track[]): number[] {
  return [...new Set(tracks.map((t) => t.channel))].sort((a, b) => a - b);
}

/**
 * MIDI channels that need an all-notes-off after an edit: the old channel of every track
 * that moved to another channel, was muted or was removed, unless another unmuted track
 * still plays on it.
 */
export function channelsToSilence(before: readonly Track[], after: readonly Track[]): number[] {
  const live = new Set(after.filter((t) => !t.muted).map((t) => t.channel));
  const out = new Set<number>();
  for (const old of before) {
    if (old.muted) continue;
    const now = after.find((t) => t.id === old.id);
    const silenced = now === undefined || now.muted || now.channel !== old.channel;
    if (silenced && !live.has(old.channel)) out.add(old.channel);
  }
  return [...out].sort((a, b) => a - b);
}

/** Ids of tracks that were audible before and are muted or gone now (release their voices). */
export function silencedTracks(before: readonly Track[], after: readonly Track[]): string[] {
  return before
    .filter((old) => {
      if (old.muted) return false;
      const now = after.find((t) => t.id === old.id);
      return now === undefined || now.muted;
    })
    .map((t) => t.id);
}

export const AUDITION_TRACK_ID = 'audition';

/**
 * The track an audition plays through: the selected track (even when muted, it was chosen
 * explicitly), else the first unmuted track, else a default chords track.
 */
export function auditionTrack(song: Song, selectedTrack: string | null): Track {
  return (
    findTrack(song, selectedTrack) ??
    songTracks(song).find((t) => !t.muted) ??
    createTrack('chords', { id: AUDITION_TRACK_ID })
  );
}

/**
 * Note events for auditioning `token` through `track`: the track's pattern over one chord of
 * `beats` beats (muting ignored). [] for rests and tokens that do not parse.
 */
export function auditionEvents(
  song: Song,
  token: string,
  track: Track,
  beats = AUDITION_BEATS,
): NoteEvent[] {
  if (isRestToken(token) || tryParseToken(token) === undefined) return [];
  const temp: Song = { ...song, chords: [{ token, beats }], tracks: [track] };
  return renderTrack(temp, track, { includeMuted: true });
}

/** Parse a number input, round it and clamp it to min..max; undefined when not a number. */
export function clampInt(value: string, min: number, max: number): number | undefined {
  const n = Math.round(Number(value));
  if (value.trim() === '' || !Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}
