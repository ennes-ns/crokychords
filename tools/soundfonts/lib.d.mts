/** Types of lib.mjs (the SoundFont fetch helpers), for the web tests. */

export interface NoteRule {
  low: number;
  high: number;
  step: number;
}

export interface FileEntry {
  sha256: string;
  bytes: number;
}

export interface ManifestInstrument {
  name: string;
  program: number;
  /** Highest shipped note (MIDI); notes above it are silent in the source. */
  top: number;
  source: FileEntry & { file: string };
  notes: Record<string, FileEntry>;
}

export interface Manifest {
  schema_version: 1;
  source: {
    repository: string;
    commit: string;
    folder: string;
    licence: FileEntry & { file: string; spdx: string };
    readme_licence: string;
  };
  notes: NoteRule;
  instruments: ManifestInstrument[];
}

export const NOTE_NAMES: readonly string[];
export function noteName(midi: number): string;
export function noteNumber(name: string): number | null;
export function noteGrid(rule: NoteRule, top: number): number[];
export function parseSoundfontJs(text: string, name: string): Map<string, Uint8Array>;
export function noticeText(manifest: Manifest): string;
