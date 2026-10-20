import type { NoteSelector, Pattern, PatternStep, Track, TrackRole } from './tracks';
import { clonePattern, newTrackId } from './tracks';

function steps(
  ats: readonly number[],
  length: number,
  notes: NoteSelector | ((i: number) => NoteSelector),
  accent?: (i: number) => number | undefined,
): PatternStep[] {
  return ats.map((at, i) => {
    const step: PatternStep = { at, length, notes: typeof notes === 'function' ? notes(i) : notes };
    const a = accent?.(i);
    if (a !== undefined) step.accent = a;
    return step;
  });
}

/** 0, every, 2 * every, ... below 4 beats. */
function grid(every: number): number[] {
  return gridOf(every, 4);
}

/** 0, every, 2 * every, ... below `length` beats. */
function gridOf(every: number, length: number): number[] {
  const out: number[] = [];
  for (let i = 0; i * every < length; i++) out.push(i * every);
  return out;
}

/** Tone selectors cycling through `indices`, one per step. */
function tones(indices: readonly number[]): (i: number) => NoteSelector {
  return (i) => ({ index: indices[i % indices.length] ?? 0 });
}

const ARP_UP_DOWN = [0, 1, 2, 3, 2, 1, 0, 1] as const;
/** Walking bass over one chord: bass note, third, fifth, octave. */
const WALK: readonly NoteSelector[] = ['bass', { index: 1 }, { index: 2 }, 'octave'];

interface PresetDef {
  pattern: Pattern;
  roles: readonly TrackRole[];
  /** One line for the pattern select. */
  description: string;
}

const PRESET_DEFS: readonly PresetDef[] = [
  {
    roles: ['chords', 'pad'],
    description: 'One chord held to the chord end',
    pattern: {
      id: 'sustain',
      name: 'Sustain',
      length: 4,
      steps: steps([0], 4, 'chord'),
      tail: 'sustain',
    },
  },
  {
    roles: ['chords'],
    description: 'One chord every four beats',
    pattern: { id: 'whole', name: 'Whole notes', length: 4, steps: steps([0], 4, 'chord') },
  },
  {
    roles: ['chords'],
    description: 'Chords on beats 1 and 3',
    pattern: { id: 'half', name: 'Half notes', length: 4, steps: steps([0, 2], 2, 'chord') },
  },
  {
    roles: ['chords'],
    description: 'Short chords on every beat',
    pattern: {
      id: 'quarters',
      name: 'Quarter stabs',
      length: 4,
      steps: steps(grid(1), 0.5, 'chord'),
    },
  },
  {
    roles: ['chords'],
    description: 'Short chords on every eighth',
    pattern: { id: 'eighths', name: 'Eighths', length: 4, steps: steps(grid(0.5), 0.25, 'chord') },
  },
  {
    roles: ['chords'],
    description: 'Chords between the beats',
    pattern: {
      id: 'offbeat',
      name: 'Off-beat eighths',
      length: 4,
      steps: steps([0.5, 1.5, 2.5, 3.5], 0.4, 'chord'),
    },
  },
  {
    roles: ['chords'],
    description: 'Long-short-long-long ballad rhythm',
    pattern: {
      id: 'pop-ballad',
      name: 'Pop ballad',
      length: 4,
      steps: [
        { at: 0, length: 1.5, notes: 'chord' },
        { at: 1.5, length: 0.5, notes: 'chord' },
        { at: 2, length: 1, notes: 'chord' },
        { at: 3, length: 1, notes: 'chord' },
      ],
    },
  },
  {
    roles: ['bass'],
    description: 'The bass note held to the chord end',
    pattern: {
      id: 'bass-whole',
      name: 'Bass whole',
      length: 4,
      steps: steps([0], 4, 'bass'),
      tail: 'sustain',
    },
  },
  {
    roles: ['bass'],
    description: 'The bass note on every beat',
    pattern: {
      id: 'bass-quarters',
      name: 'Bass quarters',
      length: 4,
      steps: steps(grid(1), 0.9, 'bass'),
    },
  },
  {
    roles: ['bass'],
    description: 'Bass note and fifth, alternating per beat',
    pattern: {
      id: 'bass-root-fifth',
      name: 'Root–fifth',
      length: 4,
      steps: steps(grid(1), 0.9, (i) => (i % 2 === 0 ? 'bass' : 'fifth')),
    },
  },
  {
    roles: ['bass'],
    description: 'The bass note on every eighth, off-beats softer',
    pattern: {
      id: 'bass-octaves',
      name: 'Octave eighths',
      length: 4,
      steps: steps(grid(0.5), 0.45, 'bass', (i) => (i % 2 === 1 ? 0.8 : undefined)),
    },
  },
  {
    roles: ['arp'],
    description: 'Chord tones climbing in eighths',
    pattern: {
      id: 'arp-up-8',
      name: 'Arp up 1/8',
      length: 4,
      steps: steps(grid(0.5), 0.45, (i) => ({ index: i })),
    },
  },
  {
    roles: ['arp'],
    description: 'Four chord tones up, every beat',
    pattern: {
      id: 'arp-up-16',
      name: 'Arp up 1/16',
      length: 4,
      steps: steps(grid(0.25), 0.22, tones([0, 1, 2, 3])),
    },
  },
  {
    roles: ['arp'],
    description: 'Chord tones up and down in eighths',
    pattern: {
      id: 'arp-updown-8',
      name: 'Arp up–down 1/8',
      length: 4,
      steps: steps(grid(0.5), 0.45, (i) => ({ index: ARP_UP_DOWN[i] ?? 0 })),
    },
  },
  {
    roles: ['arp'],
    description: 'Chord tones up and down in sixteenths',
    pattern: {
      id: 'arp-updown-16',
      name: 'Arp up–down 1/16',
      length: 4,
      steps: steps(grid(0.25), 0.22, tones([0, 1, 2, 3, 4, 3, 2, 1])),
    },
  },
  {
    roles: ['arp'],
    description: 'Root, fifth, third, octave in eighths',
    pattern: {
      id: 'arp-broken-8',
      name: 'Broken chord 1/8',
      length: 4,
      steps: steps(grid(0.5), 0.45, tones([0, 2, 1, 3])),
    },
  },
  {
    roles: ['arp', 'chords'],
    description: 'Low, high, middle, high: the classic left hand',
    pattern: {
      id: 'alberti',
      name: 'Alberti',
      length: 4,
      steps: steps(grid(0.5), 0.45, tones([0, 2, 1, 2])),
    },
  },
  {
    roles: ['chords'],
    description: 'Short stabs between the beats with a pickup',
    pattern: {
      id: 'stab-offbeat',
      name: 'Off-beat stabs',
      length: 4,
      steps: steps([0.5, 1.5, 2.5, 3.5, 3.75], 0.2, 'chord', (i) => (i === 4 ? 0.75 : undefined)),
    },
  },
  {
    roles: ['chords'],
    description: 'Syncopated piano stabs for four-on-the-floor',
    pattern: {
      id: 'house-piano',
      name: 'House piano',
      length: 4,
      steps: steps([0, 0.75, 1.5, 2.5, 3.25], 0.4, 'chord', (i) => (i === 0 ? undefined : 0.85)),
    },
  },
  {
    roles: ['chords'],
    description: 'Short chords on beats 2 and 4',
    pattern: {
      id: 'reggae-skank',
      name: 'Reggae skank',
      length: 4,
      steps: steps([1, 3], 0.3, 'chord'),
    },
  },
  {
    roles: ['chords'],
    description: 'Bass note, then two softer chords (three beats)',
    pattern: {
      id: 'waltz-3',
      name: 'Waltz 3/4',
      length: 3,
      steps: [
        { at: 0, length: 0.9, notes: 'bass' },
        { at: 1, length: 0.6, notes: 'chord', accent: 0.75 },
        { at: 2, length: 0.6, notes: 'chord', accent: 0.75 },
      ],
    },
  },
  {
    roles: ['bass'],
    description: 'Bass note and its octave, alternating in eighths',
    pattern: {
      id: 'bass-octave-8',
      name: 'Bass octaves 1/8',
      length: 4,
      steps: steps(
        grid(0.5),
        0.45,
        (i) => (i % 2 === 0 ? 'bass' : 'octave'),
        (i) => (i % 2 === 1 ? 0.8 : undefined),
      ),
    },
  },
  {
    roles: ['bass'],
    description: 'Bass note, third, fifth, octave on the beats',
    pattern: {
      id: 'bass-walk-4',
      name: 'Walking bass',
      length: 4,
      steps: steps(grid(1), 0.9, (i) => WALK[i] ?? 'bass'),
    },
  },
  {
    roles: ['pad'],
    description: 'A soft chord held to the chord end',
    pattern: {
      id: 'pad',
      name: 'Pad',
      length: 4,
      steps: steps([0], 4, 'chord', () => 0.8),
      tail: 'sustain',
    },
  },
];

function deepFreeze(pattern: Pattern): Pattern {
  for (const step of pattern.steps) {
    if (typeof step.notes !== 'string') Object.freeze(step.notes);
    Object.freeze(step);
  }
  Object.freeze(pattern.steps);
  return Object.freeze(pattern);
}

/** Built-in rhythm patterns (frozen; use patternPreset for a mutable copy). */
export const PATTERN_PRESETS: readonly Pattern[] = Object.freeze(
  PRESET_DEFS.map((d) => deepFreeze(d.pattern)),
);

/** A fresh copy of the preset with this id. Throws RangeError for unknown ids. */
export function patternPreset(id: string): Pattern {
  const def = PRESET_DEFS.find((d) => d.pattern.id === id);
  if (def === undefined) throw new RangeError(`Unknown pattern preset: "${id}"`);
  return clonePattern(def.pattern);
}

/** Roles a preset is meant for (for grouping in the UI); [] for unknown ids and 'custom'. */
export function patternRoles(id: string): readonly TrackRole[] {
  return PRESET_DEFS.find((d) => d.pattern.id === id)?.roles ?? [];
}

/** One-line description of a built-in preset (for the pattern select); '' for unknown ids. */
export function patternDescription(id: string): string {
  return PRESET_DEFS.find((d) => d.pattern.id === id)?.description ?? '';
}

export interface RoleDefaults {
  name: string;
  /** Octave of the lowest voiced tone. */
  octave: number;
  /** Preset id. */
  pattern: string;
  velocity: number;
}

/** Defaults applied by createTrack per role. */
export const ROLE_DEFAULTS: Readonly<Record<TrackRole, RoleDefaults>> = {
  chords: { name: 'Chords', octave: 4, pattern: 'sustain', velocity: 96 },
  bass: { name: 'Bass', octave: 2, pattern: 'bass-quarters', velocity: 100 },
  arp: { name: 'Arp', octave: 4, pattern: 'arp-up-8', velocity: 96 },
  pad: { name: 'Pad', octave: 3, pattern: 'pad', velocity: 80 },
  custom: { name: 'Custom', octave: 4, pattern: 'sustain', velocity: 96 },
};

export const DEFAULT_GATE = 0.9;

/**
 * A track with the role's defaults (name, octave, pattern, velocity; channel 0, close voicing,
 * gate 0.9, unmuted, no transpose) overridden by `overrides`. The id is generated with
 * newTrackId(random) unless given.
 */
export function createTrack(
  role: TrackRole,
  overrides: Partial<Omit<Track, 'role'>> = {},
  random: () => number = Math.random,
): Track {
  const d = ROLE_DEFAULTS[role];
  return {
    id: overrides.id ?? newTrackId(random),
    name: overrides.name ?? d.name,
    role,
    channel: overrides.channel ?? 0,
    octave: overrides.octave ?? d.octave,
    voicing: overrides.voicing ?? 'close',
    pattern: overrides.pattern ? clonePattern(overrides.pattern) : patternPreset(d.pattern),
    velocity: overrides.velocity ?? d.velocity,
    gate: overrides.gate ?? DEFAULT_GATE,
    muted: overrides.muted ?? false,
    transpose: overrides.transpose ?? 0,
  };
}

/**
 * The default band: Chords (ch 0, octave 4, 'sustain'), Bass (ch 1, octave 2,
 * 'bass-quarters') and Arp (ch 2, octave 4, 'arp-up-8', muted). Fresh ids on every call.
 */
export function DEFAULT_TRACKS(random: () => number = Math.random): Track[] {
  return [
    createTrack('chords', { channel: 0 }, random),
    createTrack('bass', { channel: 1 }, random),
    createTrack('arp', { channel: 2, muted: true }, random),
  ];
}
