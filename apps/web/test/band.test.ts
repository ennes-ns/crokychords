import type { Song, Track } from '@crokychords/core';
import {
  PATTERN_PRESETS,
  ROLE_DEFAULTS,
  createSong,
  createTrack,
  patternPreset,
} from '@crokychords/core';
import { describe, expect, it } from 'vitest';
import {
  AUDITION_BEATS,
  AUDITION_TRACK_ID,
  addTrack,
  applyRoleDefaults,
  auditionEvents,
  auditionTrack,
  channelMap,
  channelMapLabel,
  channelsToSilence,
  clampInt,
  findTrack,
  hasRoleDefaults,
  isPresetPattern,
  moveTrack,
  nextFreeChannel,
  presetGroups,
  removeTrack,
  roleDefaultsPatch,
  setTrackPattern,
  silencedTracks,
  songTracks,
  toggleMute,
  trackChannels,
  uniqueTrackName,
  updateTrack,
} from '../src/band';

let seed = 0;
/** Deterministic ids for the tests. */
const random = () => {
  seed = (seed + 0.137) % 1;
  return seed;
};

const track = (id: string, channel: number, extra: Partial<Track> = {}): Track =>
  createTrack(extra.role ?? 'chords', { id, channel, ...extra });

const bandSong = (): Song =>
  createSong({
    chords: [{ token: 'I', beats: 4 }],
    tracks: [
      track('a', 0, { name: 'Chords' }),
      track('b', 1, { role: 'bass', name: 'Bass' }),
      track('c', 2, { role: 'arp', name: 'Arp', muted: true }),
    ],
  });

const ids = (song: Song) => songTracks(song).map((t) => t.id);

describe('songTracks / findTrack', () => {
  it('returns the tracks, or [] for a song object without them', () => {
    const song = bandSong();
    expect(ids(song)).toEqual(['a', 'b', 'c']);
    const legacy: Song = { ...song, schema: 1 };
    delete legacy.tracks;
    expect(songTracks(legacy)).toEqual([]);
    expect(findTrack(song, 'b')?.role).toBe('bass');
    expect(findTrack(song, null)).toBeUndefined();
    expect(findTrack(song, 'zzz')).toBeUndefined();
  });
});

describe('nextFreeChannel', () => {
  it('picks the lowest unused channel', () => {
    expect(nextFreeChannel([])).toBe(0);
    expect(nextFreeChannel([track('a', 0), track('b', 1), track('c', 2)])).toBe(3);
    expect(nextFreeChannel([track('a', 0), track('b', 2)])).toBe(1);
  });

  it('falls back to the least used channel once all 16 are taken', () => {
    const all = Array.from({ length: 16 }, (_, i) => track(`t${i}`, i));
    expect(nextFreeChannel(all)).toBe(0);
    expect(nextFreeChannel([...all, track('x', 0), track('y', 1)])).toBe(2);
  });
});

describe('uniqueTrackName', () => {
  it('numbers duplicates', () => {
    const tracks = [track('a', 0, { name: 'Bass' }), track('b', 1, { name: 'Bass 2' })];
    expect(uniqueTrackName(tracks, 'Pad')).toBe('Pad');
    expect(uniqueTrackName(tracks, 'Bass')).toBe('Bass 3');
  });
});

describe('addTrack / removeTrack / moveTrack', () => {
  it('adds a track with the role defaults on the next free channel', () => {
    const { song, trackId } = addTrack(bandSong(), 'pad', random);
    const added = findTrack(song, trackId);
    expect(trackId).toMatch(/^trk-[0-9a-z]{8}$/);
    expect(added).toMatchObject({
      role: 'pad',
      name: 'Pad',
      channel: 3,
      octave: ROLE_DEFAULTS.pad.octave,
      velocity: ROLE_DEFAULTS.pad.velocity,
      muted: false,
    });
    expect(added?.pattern.id).toBe(ROLE_DEFAULTS.pad.pattern);
    expect(addTrack(song, 'bass', random).song.tracks?.at(-1)?.name).toBe('Bass 2');
  });

  it('removes a track (unknown ids leave the song alone)', () => {
    const song = bandSong();
    expect(ids(removeTrack(song, 'b'))).toEqual(['a', 'c']);
    expect(removeTrack(song, 'nope')).toBe(song);
  });

  it('reorders with ▲▼ and stops at the ends', () => {
    const song = bandSong();
    expect(ids(moveTrack(song, 'c', -1))).toEqual(['a', 'c', 'b']);
    expect(ids(moveTrack(song, 'a', 1))).toEqual(['b', 'a', 'c']);
    expect(moveTrack(song, 'a', -1)).toBe(song);
    expect(moveTrack(song, 'c', 1)).toBe(song);
    expect(moveTrack(song, 'nope', 1)).toBe(song);
    expect(ids(moveTrack(song, 'a', 2))).toEqual(['b', 'c', 'a']);
  });
});

describe('updateTrack and friends', () => {
  it('patches one track and keeps the song when nothing changed', () => {
    const song = bandSong();
    const next = updateTrack(song, 'b', { channel: 5, velocity: 80 });
    expect(findTrack(next, 'b')).toMatchObject({ channel: 5, velocity: 80 });
    expect(findTrack(next, 'a')).toBe(findTrack(song, 'a'));
    expect(updateTrack(song, 'b', { channel: 1 })).toBe(song);
    expect(updateTrack(song, 'nope', { channel: 3 })).toBe(song);
    const samePattern = patternPreset(findTrack(song, 'a')?.pattern.id ?? 'sustain');
    expect(updateTrack(song, 'a', { pattern: samePattern })).toBe(song);
  });

  it('toggles mute', () => {
    const song = toggleMute(bandSong(), 'c');
    expect(findTrack(song, 'c')?.muted).toBe(false);
    expect(findTrack(toggleMute(song, 'c'), 'c')?.muted).toBe(true);
    const unchanged = bandSong();
    expect(toggleMute(unchanged, 'nope')).toBe(unchanged);
  });

  it('sets a preset pattern', () => {
    const song = setTrackPattern(bandSong(), 'a', 'pop-ballad');
    expect(findTrack(song, 'a')?.pattern).toEqual(patternPreset('pop-ballad'));
    expect(() => setTrackPattern(bandSong(), 'a', 'no-such-preset')).toThrow(RangeError);
  });

  it('applies role defaults only on request', () => {
    // Changing the role alone keeps octave, pattern and velocity.
    const song = updateTrack(bandSong(), 'a', { role: 'bass' });
    const changed = findTrack(song, 'a');
    expect(changed).toMatchObject({ role: 'bass', octave: 4, velocity: 96 });
    expect(changed !== undefined && hasRoleDefaults(changed)).toBe(false);
    const applied = findTrack(applyRoleDefaults(song, 'a'), 'a');
    expect(applied).toMatchObject({ role: 'bass', octave: 2, velocity: 100, channel: 0 });
    expect(applied?.pattern.id).toBe('bass-quarters');
    expect(applied !== undefined && hasRoleDefaults(applied)).toBe(true);
    expect(roleDefaultsPatch('pad')).toMatchObject({ octave: 3, velocity: 80 });
    const unchanged = bandSong();
    expect(applyRoleDefaults(unchanged, 'nope')).toBe(unchanged);
  });
});

describe('presets', () => {
  it('groups every preset once, by its first role hint', () => {
    const groups = presetGroups();
    expect(groups.map((g) => g.role)).toEqual(['chords', 'bass', 'arp', 'pad']);
    const all = groups.flatMap((g) => g.presets.map((p) => p.id));
    expect(all.sort()).toEqual(PATTERN_PRESETS.map((p) => p.id).sort());
    expect(groups[0]?.presets.map((p) => p.id)).toContain('sustain');
    expect(groups[3]?.presets.map((p) => p.id)).toEqual(['pad']);
  });

  it('recognises preset patterns', () => {
    expect(isPresetPattern(patternPreset('half'))).toBe(true);
    expect(isPresetPattern({ id: 'custom', name: 'Mine', length: 4, steps: [] })).toBe(false);
  });
});

describe('channel map', () => {
  it('lists name and 1-based channel per track', () => {
    const tracks = songTracks(bandSong());
    expect(channelMap(tracks)).toEqual([
      { id: 'a', name: 'Chords', channel: 1, muted: false },
      { id: 'b', name: 'Bass', channel: 2, muted: false },
      { id: 'c', name: 'Arp', channel: 3, muted: true },
    ]);
    expect(channelMapLabel(tracks)).toBe('Chords ch1 · Bass ch2 · Arp ch3 (muted)');
    expect(channelMapLabel([])).toBe('');
  });

  it('lists the distinct channels in use', () => {
    expect(trackChannels([track('a', 4), track('b', 1), track('c', 4)])).toEqual([1, 4]);
  });
});

describe('channelsToSilence / silencedTracks', () => {
  it('silences the old channel of a track that moved, was muted or removed', () => {
    const before = songTracks(bandSong());
    const moved = songTracks(updateTrack(bandSong(), 'b', { channel: 9 }));
    expect(channelsToSilence(before, moved)).toEqual([1]);
    const muted = songTracks(updateTrack(bandSong(), 'a', { muted: true }));
    expect(channelsToSilence(before, muted)).toEqual([0]);
    expect(silencedTracks(before, muted)).toEqual(['a']);
    const removed = songTracks(removeTrack(bandSong(), 'b'));
    expect(channelsToSilence(before, removed)).toEqual([1]);
    expect(silencedTracks(before, removed)).toEqual(['b']);
  });

  it('leaves channels alone that another audible track still uses, and muted tracks', () => {
    const before = songTracks(updateTrack(bandSong(), 'b', { channel: 0 })); // a and b on 0
    const moved = songTracks(updateTrack(createSong({ tracks: [...before] }), 'b', { channel: 4 }));
    expect(channelsToSilence(before, moved)).toEqual([]);
    const unmuteArp = songTracks(updateTrack(bandSong(), 'c', { channel: 7 }));
    expect(channelsToSilence(songTracks(bandSong()), unmuteArp)).toEqual([]);
    expect(silencedTracks(before, before)).toEqual([]);
  });
});

describe('auditions', () => {
  it('plays through the selected track, else the first unmuted one, else a default', () => {
    const song = bandSong();
    expect(auditionTrack(song, 'c').id).toBe('c'); // selected, even though muted
    expect(auditionTrack(song, null).id).toBe('a');
    const allMuted = createSong({ tracks: [track('m', 0, { muted: true })] });
    expect(auditionTrack(allMuted, null).id).toBe(AUDITION_TRACK_ID);
    expect(auditionTrack(createSong({ tracks: [] }), 'gone').role).toBe('chords');
  });

  it("renders the chord with the track's pattern, octave and channel", () => {
    const song = bandSong();
    const bass = findTrack(song, 'b');
    if (bass === undefined) throw new Error('missing bass');
    const events = auditionEvents(song, 'V', bass);
    // bass-quarters over two beats: G2 on beats 0 and 1, channel 1.
    expect(events.map((e) => [e.note, e.start, e.channel])).toEqual([
      [43, 0, 1],
      [43, 1, 1],
    ]);
    const arp = findTrack(song, 'c');
    if (arp === undefined) throw new Error('missing arp');
    expect(auditionEvents(song, 'I', arp)).toHaveLength(AUDITION_BEATS * 2); // muted is ignored
    expect(auditionEvents(song, 'rest', bass)).toEqual([]);
    expect(auditionEvents(song, 'V7alt1', bass)).toEqual([]);
  });
});

describe('clampInt', () => {
  it('rounds and clamps number input values', () => {
    expect(clampInt('3', -1, 9)).toBe(3);
    expect(clampInt('12', -1, 9)).toBe(9);
    expect(clampInt('-5', -1, 9)).toBe(-1);
    expect(clampInt('2.6', -1, 9)).toBe(3);
    expect(clampInt('', -1, 9)).toBeUndefined();
    expect(clampInt('abc', -1, 9)).toBeUndefined();
  });
});
