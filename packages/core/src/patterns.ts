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
  const out: number[] = [];
  for (let i = 0; i * every < 4; i++) out.push(i * every);
  return out;
}

const ARP_UP_DOWN = [0, 1, 2, 3, 2, 1, 0, 1] as const;

interface PresetDef {
  pattern: Pattern;
  roles: readonly TrackRole[];
}

const PRESET_DEFS: readonly PresetDef[] = [
  {
    roles: ['chords', 'pad'],
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
    pattern: { id: 'whole', name: 'Whole notes', length: 4, steps: steps([0], 4, 'chord') },
  },
  {
    roles: ['chords'],
    pattern: { id: 'half', name: 'Half notes', length: 4, steps: steps([0, 2], 2, 'chord') },
  },
  {
    roles: ['chords'],
    pattern: {
      id: 'quarters',
      name: 'Quarter stabs',
      length: 4,
      steps: steps(grid(1), 0.5, 'chord'),
    },
  },
  {
    roles: ['chords'],
    pattern: { id: 'eighths', name: 'Eighths', length: 4, steps: steps(grid(0.5), 0.25, 'chord') },
  },
  {
    roles: ['chords'],
    pattern: {
      id: 'offbeat',
      name: 'Off-beat eighths',
      length: 4,
      steps: steps([0.5, 1.5, 2.5, 3.5], 0.4, 'chord'),
    },
  },
  {
    roles: ['chords'],
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
    pattern: {
      id: 'bass-quarters',
      name: 'Bass quarters',
      length: 4,
      steps: steps(grid(1), 0.9, 'bass'),
    },
  },
  {
    roles: ['bass'],
    pattern: {
      id: 'bass-root-fifth',
      name: 'Root–fifth',
      length: 4,
      steps: steps(grid(1), 0.9, (i) => (i % 2 === 0 ? 'bass' : 'fifth')),
    },
  },
  {
    roles: ['bass'],
    pattern: {
      id: 'bass-octaves',
      name: 'Octave eighths',
      length: 4,
      steps: steps(grid(0.5), 0.45, 'bass', (i) => (i % 2 === 1 ? 0.8 : undefined)),
    },
  },
  {
    roles: ['arp'],
    pattern: {
      id: 'arp-up-8',
      name: 'Arp up 1/8',
      length: 4,
      steps: steps(grid(0.5), 0.45, (i) => ({ index: i })),
    },
  },
  {
    roles: ['arp'],
    pattern: {
      id: 'arp-up-16',
      name: 'Arp up 1/16',
      length: 4,
      steps: steps(grid(0.25), 0.22, (i) => ({ index: i })),
    },
  },
  {
    roles: ['arp'],
    pattern: {
      id: 'arp-updown-8',
      name: 'Arp up–down 1/8',
      length: 4,
      steps: steps(grid(0.5), 0.45, (i) => ({ index: ARP_UP_DOWN[i] ?? 0 })),
    },
  },
  {
    roles: ['pad'],
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
